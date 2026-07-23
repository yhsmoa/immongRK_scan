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
    if (!reqRows.length) return res.status(400).json({ error: '대상 행이 없습니다.' });

    const barcodes = [...new Set(reqRows.map(r => String(r.barcode || '').trim()).filter(Boolean))];
    if (!barcodes.length) return res.status(400).json({ error: '바코드가 있는 행이 없습니다.' });

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
      // 배정용 풀: 가용(재고−예약)>0 인 위치만
      const avail = (parseInt(s.qty) || 0) - (stockReservedByLoc.get(`${s.barcode}|${loc}`) || 0);
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
      let needed = orderQty - alreadyReserved;
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
      results.push({ orderNumber, barcode, orderQty, alreadyReserved, allocated: allocatedTotal, allocations,
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
    }

    res.json({ results, saved, batch: batchNo });
  } catch (e) {
    console.error('[rk] shipping-list/stock-allocate:', e);
    res.status(500).json({ error: '재고 출고배정 중 오류가 발생했습니다: ' + e.message });
  }
});

/**
 * 재고준비 실행 — 존재하는 발주서 전체를 대상으로 재고 출고배정 → rk_shipping_list(source='재고') 저장
 * - needed = 발주수량 − 이미 예약된 수량(같은 발주번호+바코드, status='출고예정', source 무관) → 재실행해도 중복배정 없음
 * - 이번 실행에서 새로 배정된 행에만 새 회차(batch_no = 재고건 max+1)와 prepared_at(출고일 기준값) 부여
 */
router.post('/api/stock-prepare/run', async (req, res) => {
  try {
    // 1) 발주서 원본 상품 → 요청 행
    const orders = await S.listOrdersFull('rk_orders', 'rk_order_items');
    const reqRows = [];
    for (const o of orders) {
      for (const p of (o.상품정보 || [])) {
        if (p.박스정보 || !p.상품바코드) continue; // 원본 상품만
        reqRows.push({
          orderNumber: o.발주번호, center: o.물류센터, shippingDate: o.입고예정일 || '',
          barcode: p.상품바코드, productName: p.상품이름 || '', qty: parseInt(p.발주수량) || 0,
        });
      }
    }
    if (!reqRows.length) return res.json({ saved: 0, batch: null, message: '대상 발주 상품이 없습니다.' });

    const barcodes = [...new Set(reqRows.map(r => r.barcode))];

    // 2) 재고 풀 + 기존 예약 (stock-allocate 와 동일 규칙)
    const stocks = await fetchIn('rk_stocks', 'id, barcode, location, qty', 'barcode', barcodes);
    const reserved = await fetchIn('rk_shipping_list', 'source, status, barcode, order_number, location, qty', 'barcode', barcodes);
    const activeReserved = reserved.filter(r => r.status === '출고예정');
    const stockReservedByLoc = new Map();
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
    const poolByBarcode = new Map();
    for (const s of stocks) {
      const loc = String(s.location || '').trim();
      if (!loc || loc === '-') continue;
      const avail = (parseInt(s.qty) || 0) - (stockReservedByLoc.get(`${s.barcode}|${loc}`) || 0);
      if (avail <= 0) continue;
      if (!poolByBarcode.has(s.barcode)) poolByBarcode.set(s.barcode, []);
      poolByBarcode.get(s.barcode).push({ stockId: s.id, location: loc, avail });
    }
    for (const list of poolByBarcode.values()) list.sort((a, b) => a.location.localeCompare(b.location, 'ko', { numeric: true }));

    // 3) 다음 회차 번호 (재고건 전체 기준 max+1)
    const { data: mb, error: eMb } = await sb.from('rk_shipping_list')
      .select('batch_no').eq('source', '재고').not('batch_no', 'is', null)
      .order('batch_no', { ascending: false }).limit(1);
    if (eMb) throw eMb;
    const nextBatch = ((mb && mb.length ? mb[0].batch_no : 0) || 0) + 1;
    const runAt = new Date().toISOString();

    // 4) 그리디 배정 → 새로 배정된 것만 insert
    const insertRows = [];
    for (const row of reqRows) {
      const already = reservedByOrder.get(`${row.orderNumber}|${row.barcode}`) || 0;
      let needed = row.qty - already;
      if (needed <= 0) continue;
      const pool = poolByBarcode.get(row.barcode) || [];
      for (const p of pool) {
        if (needed <= 0) break;
        const take = Math.min(needed, p.avail);
        if (take > 0) {
          insertRows.push({
            source: '재고', status: '출고예정',
            barcode: row.barcode, product_name: row.productName || null,
            order_number: row.orderNumber || null, center: row.center || null,
            shipping_date: row.shippingDate || null,
            qty: take, location: p.location, stock_id: p.stockId,
            batch_no: nextBatch, prepared_at: runAt,
          });
          p.avail -= take;
          needed -= take;
        }
      }
    }

    let saved = 0;
    if (insertRows.length) {
      const BATCH = 500;
      for (let i = 0; i < insertRows.length; i += BATCH) {
        const { error } = await sb.from('rk_shipping_list').insert(insertRows.slice(i, i + BATCH));
        if (error) throw error;
      }
      saved = insertRows.length;
    }
    const totalQty = insertRows.reduce((s, r) => s + r.qty, 0);
    res.json({ saved, totalQty, batch: saved ? nextBatch : null, preparedAt: saved ? runAt : null });
  } catch (e) {
    console.error('[rk] stock-prepare/run:', e);
    res.status(500).json({ error: '재고준비 실행 중 오류가 발생했습니다: ' + e.message });
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
