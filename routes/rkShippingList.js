/**
 * 출고리스트 통합 도메인 — rk_shipping_list (source: 입고 | 재고, status: 출고예정 → 출고)
 * 설계: docs/plan-shipping-list.md
 *
 * - 재고건: 신규발주서 위치v2/준비v2 → rk_stocks 재고에서 발주수량만큼 배정
 * - 입고건: 기존 rk_cn_shipping 의 미러 (원본/버튼 동작 무변경, rkInbound prepare 에서 비파괴 복사)
 */
const express = require('express');
const S = require('./rkShared');

const router = express.Router();
const sb = S.supabase;

// in() 청크 조회 공통
async function fetchIn(table, select, column, values) {
  const all = [];
  const BATCH = 200;
  for (let i = 0; i < values.length; i += BATCH) {
    const { data, error } = await sb.from(table).select(select).in(column, values.slice(i, i + BATCH));
    if (error) throw error;
    all.push(...data);
  }
  return all;
}

/**
 * 재고 출고배정 계산 (위치v2 / 준비v2 공용)
 * body: { rows: [{orderNumber, center, shippingDate, barcode, productName, qty}], save: boolean }
 * - needed = qty(발주수량) − 이미 예약된 수량(같은 발주번호+바코드, status='출고예정', source 무관)
 * - avail(바코드,위치) = rk_stocks.qty − 재고건 예약합계(source='재고', status='출고예정')
 * - 요청 행 순서대로 그리디 배정, 같은 바코드는 공유 풀 소진, 위치는 location 오름차순
 * - save=true 면 배정 결과를 rk_shipping_list(source='재고')에 저장
 */
router.post('/api/shipping-list/stock-allocate', async (req, res) => {
  try {
    const reqRows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const save = !!req.body.save;
    const withBatch = !!req.body.batch;   // true면 저장분에 새 회차(batch_no)·prepared_at 부여 (재고준비 페이지용)
    const excludeShipScan = !!req.body.excludeShipScan;  // true면 needed에서 출고스캔(rk_ship_box_items)도 차감 (재고준비 전용)
    if (!reqRows.length) return res.status(400).json({ error: '대상 행이 없습니다.' });

    const barcodes = [...new Set(reqRows.map(r => String(r.barcode || '').trim()).filter(Boolean))];
    if (!barcodes.length) return res.status(400).json({ error: '바코드가 있는 행이 없습니다.' });

    // 출고스캔(rk_ship_box_items) 발주번호+바코드별 합 — excludeShipScan 일 때만 조회
    const shipScanByOrderBc = new Map();
    if (excludeShipScan) {
      const orderNos = [...new Set(reqRows.map(r => String(r.orderNumber || '').trim()).filter(Boolean))];
      for (let i = 0; i < orderNos.length; i += 200) {
        const batch = orderNos.slice(i, i + 200);
        let from = 0; const PAGE = 1000;
        while (true) {
          const { data, error } = await sb.from('rk_ship_box_items').select('order_number, barcode, qty').in('order_number', batch).range(from, from + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          for (const r of data) {
            if (!r.order_number || !r.barcode) continue;
            const k = `${r.order_number}|${r.barcode}`;
            shipScanByOrderBc.set(k, (shipScanByOrderBc.get(k) || 0) + (parseInt(r.qty) || 0));
          }
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }
    }

    // 1) 재고 로드 → (바코드,위치)별 가용 풀
    const stocks = await fetchIn('rk_stocks', 'id, barcode, location, qty', 'barcode', barcodes);
    // 2) 기존 예약 로드 (출고예정 전체 — needed 차감 및 재고건 가용 차감)
    const reserved = await fetchIn('rk_shipping_list', 'source, status, barcode, order_number, location, qty', 'barcode', barcodes);
    const activeReserved = reserved.filter(r => r.status === '출고예정');

    // 재고건 예약: (바코드|위치) → 예약합계
    const stockReservedByLoc = new Map();
    // 발주 예약: (발주번호|바코드) → 예약합계 (source 무관)
    const reservedByOrder = new Map();
    for (const r of activeReserved) {
      if (r.source === '재고' && r.location) {
        const k = `${r.barcode}|${r.location}`;
        stockReservedByLoc.set(k, (stockReservedByLoc.get(k) || 0) + (r.qty || 0));
      }
      if (r.order_number) {
        const k = `${r.order_number}|${r.barcode}`;
        reservedByOrder.set(k, (reservedByOrder.get(k) || 0) + (r.qty || 0));
      }
    }

    // 바코드 → [{stockId, location, avail}] (location 오름차순, 공유 풀)
    const poolByBarcode = new Map();
    // 바코드 → 위치별 실제 재고 [{location, qty}] (표시용, 0/NULL 포함, location 있는 것만)
    const stockLocsByBarcode = new Map();
    for (const s of stocks) {
      const loc = String(s.location || '').trim();
      if (!loc || loc === '-') continue;
      // 표시용: 실제 재고값(0/양수/NULL 구분)
      if (!stockLocsByBarcode.has(s.barcode)) stockLocsByBarcode.set(s.barcode, []);
      stockLocsByBarcode.get(s.barcode).push({ location: loc, qty: (s.qty == null ? null : (parseInt(s.qty) || 0)) });
      // 배정용 풀: 가용 = 실재고 qty (준비 시 rk_stocks 에서 즉시 차감하므로 예약 재차감 안 함)
      const avail = (parseInt(s.qty) || 0);
      if (avail <= 0) continue;
      if (!poolByBarcode.has(s.barcode)) poolByBarcode.set(s.barcode, []);
      poolByBarcode.get(s.barcode).push({ stockId: s.id, location: loc, avail });
    }
    const locSort = (a, b) => a.location.localeCompare(b.location, 'ko', { numeric: true });
    for (const list of poolByBarcode.values()) list.sort(locSort);
    for (const list of stockLocsByBarcode.values()) list.sort(locSort);

    // 3) 행 순서대로 그리디 배정
    const results = [];   // 요청 행별 결과
    const insertRows = []; // save 용
    for (const row of reqRows) {
      const barcode = String(row.barcode || '').trim();
      const orderNumber = String(row.orderNumber || '').trim();
      const orderQty = parseInt(row.qty) || 0;
      const alreadyReserved = reservedByOrder.get(`${orderNumber}|${barcode}`) || 0;
      const shipScanned = excludeShipScan ? (shipScanByOrderBc.get(`${orderNumber}|${barcode}`) || 0) : 0;
      let needed = orderQty - alreadyReserved - shipScanned;
      const allocations = [];
      if (barcode && needed > 0) {
        const pool = poolByBarcode.get(barcode) || [];
        for (const p of pool) {
          if (needed <= 0) break;
          const take = Math.min(needed, p.avail);
          if (take > 0) {
            allocations.push({ stockId: p.stockId, location: p.location, qty: take });
            p.avail -= take;
            needed -= take;
          }
        }
      }
      const allocatedTotal = allocations.reduce((s, a) => s + a.qty, 0);
      results.push({ orderNumber, barcode, orderQty, alreadyReserved, shipScanned, allocated: allocatedTotal, allocations,
        stockLocs: stockLocsByBarcode.get(barcode) || [] });
      if (save) {
        for (const a of allocations) {
          insertRows.push({
            source: '재고', status: '출고예정',
            barcode, product_name: row.productName || null,
            order_number: orderNumber || null, center: row.center || null,
            shipping_date: row.shippingDate || null,
            qty: a.qty, location: a.location, stock_id: a.stockId,
          });
        }
      }
    }

    let saved = 0;
    let batchNo = null;
    if (save && insertRows.length) {
      // 재고준비 페이지: 새 회차 번호(batch_no=재고건 max+1)·prepared_at 스탬프
      if (withBatch) {
        const { data: mb, error: eMb } = await sb.from('rk_shipping_list')
          .select('batch_no').eq('source', '재고').not('batch_no', 'is', null)
          .order('batch_no', { ascending: false }).limit(1);
        if (eMb) throw eMb;
        batchNo = ((mb && mb.length ? mb[0].batch_no : 0) || 0) + 1;
        const runAt = new Date().toISOString();
        for (const r of insertRows) { r.batch_no = batchNo; r.prepared_at = runAt; }
      }
      const BATCH = 500;
      for (let i = 0; i < insertRows.length; i += BATCH) {
        const { error } = await sb.from('rk_shipping_list').insert(insertRows.slice(i, i + BATCH));
        if (error) throw error;
      }
      saved = insertRows.length;

      // ── 준비된 만큼 rk_stocks 즉시 차감 (+ 이력 기록). stock_id별 합산, 0 미만 클램프 ──
      const takeByStock = new Map();
      for (const r of insertRows) {
        if (r.stock_id == null) continue;
        takeByStock.set(r.stock_id, (takeByStock.get(r.stock_id) || 0) + (r.qty || 0));
      }
      if (takeByStock.size) {
        const ids = [...takeByStock.keys()];
        const curById = new Map();
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error } = await sb.from('rk_stocks').select('id, barcode, location, sku_id, item_name, qty').in('id', ids.slice(i, i + 200));
          if (error) throw error;
          for (const s of (data || [])) curById.set(s.id, s);
        }
        const histories = [];
        const CONC = 40;
        const entries = [...takeByStock.entries()];
        for (let i = 0; i < entries.length; i += CONC) {
          const chunk = entries.slice(i, i + CONC);
          await Promise.all(chunk.map(async ([stockId, take]) => {
            const cur = curById.get(stockId);
            if (!cur) return;
            const before = parseInt(cur.qty) || 0;
            const after = Math.max(0, before - take);
            const { error } = await sb.from('rk_stocks').update({ qty: after }).eq('id', stockId);
            if (error) throw error;
            histories.push({ stock_id: stockId, sku_id: cur.sku_id || null, barcode: cur.barcode, location: cur.location,
              change_type: 'deduct', qty: before - after, qty_before: before, qty_after: after, note: '재고준비 출고배정' });
          }));
        }
        for (let i = 0; i < histories.length; i += 500) {
          const { error } = await sb.from('rk_stock_histories').insert(histories.slice(i, i + 500));
          if (error) console.error('[rk] stock-allocate 이력 기록 실패(계속):', error.message);
        }
      }
    }

    res.json({ results, saved, batch: batchNo });
  } catch (e) {
    console.error('[rk] shipping-list/stock-allocate:', e);
    res.status(500).json({ error: '재고 출고배정 중 오류가 발생했습니다: ' + e.message });
  }
});

// 재고건 예정 취소 — rk_shipping_list(재고) 삭제 + rk_stocks 복원(+이력)
// body: { ids: [rk_shipping_list.id, ...] }
router.post('/api/shipping-list/stock-cancel', async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(v => parseInt(v, 10)).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: '취소할 항목이 없습니다.' });

    // 대상 예약 조회 (재고건만)
    const rows = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from('rk_shipping_list')
        .select('id, source, stock_id, barcode, location, qty').in('id', ids.slice(i, i + 200));
      if (error) throw error;
      rows.push(...(data || []));
    }
    const targets = rows.filter(r => r.source === '재고');
    if (!targets.length) return res.json({ canceled: 0, restored: 0 });

    // 1) 예약 삭제
    const delIds = targets.map(r => r.id);
    for (let i = 0; i < delIds.length; i += 200) {
      const { error } = await sb.from('rk_shipping_list').delete().in('id', delIds.slice(i, i + 200));
      if (error) throw error;
    }

    // 2) 재고 복원 (stock_id별 합산 add) + 이력
    const addByStock = new Map();
    for (const r of targets) { if (r.stock_id != null) addByStock.set(r.stock_id, (addByStock.get(r.stock_id) || 0) + (r.qty || 0)); }
    let restored = 0;
    if (addByStock.size) {
      const sids = [...addByStock.keys()];
      const curById = new Map();
      for (let i = 0; i < sids.length; i += 200) {
        const { data, error } = await sb.from('rk_stocks').select('id, barcode, location, sku_id, qty').in('id', sids.slice(i, i + 200));
        if (error) throw error;
        for (const s of (data || [])) curById.set(s.id, s);
      }
      const histories = [];
      const entries = [...addByStock.entries()];
      const CONC = 40;
      for (let i = 0; i < entries.length; i += CONC) {
        const chunk = entries.slice(i, i + CONC);
        await Promise.all(chunk.map(async ([stockId, add]) => {
          const cur = curById.get(stockId);
          if (!cur) return;
          const before = parseInt(cur.qty) || 0;
          const after = before + add;
          const { error } = await sb.from('rk_stocks').update({ qty: after }).eq('id', stockId);
          if (error) throw error;
          restored += add;
          histories.push({ stock_id: stockId, sku_id: cur.sku_id || null, barcode: cur.barcode, location: cur.location,
            change_type: 'add', qty: add, qty_before: before, qty_after: after, note: '재고준비 취소 복원' });
        }));
      }
      for (let i = 0; i < histories.length; i += 500) {
        const { error } = await sb.from('rk_stock_histories').insert(histories.slice(i, i + 500));
        if (error) console.error('[rk] stock-cancel 이력 기록 실패(계속):', error.message);
      }
    }

    res.json({ canceled: targets.length, restored });
  } catch (e) {
    console.error('[rk] shipping-list/stock-cancel:', e);
    res.status(500).json({ error: '예정 취소 중 오류가 발생했습니다: ' + e.message });
  }
});

// rocket 상품명 클릭 상세 — 발주+바코드의 출고예정 내역 / 출고스캔 박스 / 재고
router.get('/api/rocket/scan-detail', async (req, res) => {
  try {
    const orderNumber = String(req.query.orderNumber || '').trim();
    const barcode = String(req.query.barcode || '').trim();
    if (!barcode) return res.status(400).json({ error: '바코드가 필요합니다.' });

    // 1) 출고예정 내역 (rk_shipping_list) — 재고/입고
    let slq = sb.from('rk_shipping_list').select('*').eq('barcode', barcode);
    if (orderNumber) slq = slq.eq('order_number', orderNumber);
    const { data: sl, error: e1 } = await slq;
    if (e1) throw e1;

    // 2) 출고스캔 박스 (rk_ship_box_items + rk_ship_boxes)
    let biq = sb.from('rk_ship_box_items').select('box_id, order_number, barcode, qty').eq('barcode', barcode);
    if (orderNumber) biq = biq.eq('order_number', orderNumber);
    const { data: bi, error: e2 } = await biq;
    if (e2) throw e2;
    const boxIds = [...new Set((bi || []).map(x => x.box_id).filter(x => x != null))];
    const boxById = new Map();
    for (let i = 0; i < boxIds.length; i += 200) {
      const { data: bx, error: eB } = await sb.from('rk_ship_boxes').select('id, box_no, box_size').in('id', boxIds.slice(i, i + 200));
      if (eB) throw eB;
      for (const b of (bx || [])) boxById.set(b.id, b);
    }

    // 3) 재고 (rk_stocks) — 바코드 전체 위치
    const { data: st, error: e3 } = await sb.from('rk_stocks').select('location, qty, item_name').eq('barcode', barcode);
    if (e3) throw e3;

    res.json({
      shippingList: (sl || []).map(r => ({
        source: r.source, status: r.status, orderNumber: r.order_number, center: r.center,
        location: r.location, qty: r.qty, shippingDate: r.shipping_date, batchNo: r.batch_no, createdAt: r.created_at,
      })),
      boxItems: (bi || []).map(r => { const b = boxById.get(r.box_id) || {}; return { orderNumber: r.order_number, boxNo: b.box_no, boxSize: b.box_size, qty: r.qty }; })
        .sort((a, b) => (a.boxNo || 0) - (b.boxNo || 0)),
      stocks: (st || []).map(r => ({ location: r.location, qty: r.qty, itemName: r.item_name }))
        .filter(r => r.location && r.location !== '-')
        .sort((a, b) => String(a.location).localeCompare(String(b.location), 'ko', { numeric: true })),
    });
  } catch (e) {
    console.error('[rk] rocket/scan-detail:', e);
    res.status(500).json({ error: '스캔 상세 조회 실패: ' + e.message });
  }
});

// 통합 출고리스트 조회 (추후 통합 화면/스캔용)
router.get('/api/shipping-list', async (req, res) => {
  try {
    const all = [];
    let from = 0;
    const size = 1000;
    while (true) {
      let q = sb.from('rk_shipping_list').select('*').order('id', { ascending: true }).range(from, from + size - 1);
      const { data, error } = await q;
      if (error) throw error;
      all.push(...data);
      if (data.length < size) break;
      from += size;
    }
    const source = (req.query.source || '').trim();
    const status = (req.query.status || '').trim();
    let rows = all;
    if (source) rows = rows.filter(r => r.source === source);
    if (status) rows = rows.filter(r => r.status === status);
    res.json(rows.map(r => ({
      id: r.id, source: r.source, status: r.status,
      barcode: r.barcode, productName: r.product_name,
      orderNumber: r.order_number, center: r.center, shippingDate: r.shipping_date,
      qty: r.qty, location: r.location,
      stockId: r.stock_id, shipmentId: r.shipment_id, shipmentItemId: r.shipment_item_id,
      batchNo: r.batch_no, preparedAt: r.prepared_at, createdAt: r.created_at,
    })));
  } catch (e) {
    console.error('[rk] shipping-list 목록:', e);
    res.status(500).json({ error: '출고리스트를 불러오는데 실패했습니다.' });
  }
});

module.exports = router;
