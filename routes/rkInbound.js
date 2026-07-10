/**
 * CN입고 도메인 — 입고리스트 (엑셀 원본 적재)
 * 구조: rk_cn_shipments (출고코드 헤더) 1 : N rk_cn_shipment_items (아이템)
 * 파싱 규칙은 기존 importChina 와 동일 (Sheet3 / B열 'BR' 박스만 / A=팔렛 B=박스명 C=중국번호 H=상품명 J=수량 K=바코드)
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;

function toKorean(r) {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    shipmentCode: r.rk_cn_shipments ? r.rk_cn_shipments.shipment_code : null,
    status: r.rk_cn_shipments ? r.rk_cn_shipments.status : null,
    boxName: r.box_name,
    orderNumber: r.order_number,
    productName: r.product_name,
    quantity: r.quantity,
    barcode: r.barcode,
    note: r.note,
  };
}

// 아이템 전체 조회 (헤더 join) — 1000행 우회
async function fetchAllItems() {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await sb
      .from('rk_cn_shipment_items')
      .select('*, rk_cn_shipments(shipment_code, status)')
      .order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// 출고코드 목록 (코드별 요약: 아이템 수)
router.get('/api/inbound/shipments', async (req, res) => {
  try {
    const { data: shipments, error } = await sb
      .from('rk_cn_shipments').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const items = await fetchAllItems();
    const countByShip = {};
    for (const it of items) countByShip[it.shipment_id] = (countByShip[it.shipment_id] || 0) + 1;
    res.json(shipments.map(s => ({
      id: s.id, shipmentCode: s.shipment_code, status: s.status, memo: s.memo,
      itemCount: countByShip[s.id] || 0, createdAt: s.created_at, updatedAt: s.updated_at,
    })));
  } catch (e) {
    console.error('[rk] inbound/shipments:', e);
    res.status(500).json({ error: '출고코드 목록을 불러오는데 실패했습니다.' });
  }
});

// 입고리스트 아이템 목록 (전체 또는 특정 출고코드)
router.get('/api/inbound/list', async (req, res) => {
  try {
    let rows = await fetchAllItems();
    const code = (req.query.shipmentCode || '').trim();
    if (code) rows = rows.filter(r => r.rk_cn_shipments && r.rk_cn_shipments.shipment_code === code);
    rows.sort((a, b) =>
      String(a.box_name || '').localeCompare(String(b.box_name || '')) ||
      String(a.barcode || '').localeCompare(String(b.barcode || '')));
    res.json(rows.map(toKorean));
  } catch (e) {
    console.error('[rk] inbound/list:', e);
    res.status(500).json({ error: '입고리스트를 불러오는데 실패했습니다.' });
  }
});

// 엑셀 원본 업로드 (헤더 upsert → 아이템 교체)
router.post('/api/inbound/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    const shipmentCode = (req.body.shipmentCode || '').trim();
    if (!shipmentCode) return res.status(400).json({ error: '출고코드가 입력되지 않았습니다.' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    if (!workbook.SheetNames.includes('Sheet3')) return res.status(400).json({ error: 'Sheet3를 찾을 수 없습니다.' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets['Sheet3'], { header: 'A' });
    const filtered = data.filter((row) => { const b = row['B']; return b && b.toString().startsWith('BR'); });

    // 1) 출고코드 헤더 upsert → id 확보
    const { data: sh, error: e1 } = await sb
      .from('rk_cn_shipments')
      .upsert({ shipment_code: shipmentCode }, { onConflict: 'shipment_code' })
      .select('id').single();
    if (e1) throw e1;
    const shipmentId = sh.id;

    // 2) 기존 아이템 교체
    const { error: e2 } = await sb.from('rk_cn_shipment_items').delete().eq('shipment_id', shipmentId);
    if (e2) throw e2;

    const rows = filtered.map((row) => ({
      shipment_id: shipmentId,
      pallet: row['A'] != null ? String(row['A']) : null,
      box_name: row['B'] != null ? String(row['B']) : null,
      order_number: row['C'] != null ? String(row['C']) : null,
      product_name: row['H'] != null ? String(row['H']) : null,
      quantity: row['J'] != null ? String(row['J']) : '0',
      barcode: row['K'] != null ? String(row['K']) : null,
      note: null,
    }));

    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await sb.from('rk_cn_shipment_items').insert(rows.slice(i, i + BATCH));
      if (error) throw error;
    }

    res.json({ message: `업로드 완료 (${rows.length}건)`, count: rows.length, shipmentId });
  } catch (e) {
    console.error('[rk] inbound/upload:', e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 비고 수정 (아이템 id 기준)
router.post('/api/inbound/update-note', async (req, res) => {
  try {
    const { id, note } = req.body;
    if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
    const { error } = await sb.from('rk_cn_shipment_items').update({ note: note ?? null }).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('[rk] inbound/update-note:', e);
    res.status(500).json({ error: '비고 저장 중 오류가 발생했습니다.' });
  }
});

// 아이템 + 배정(alloc)으로 { shipping(출고리스트), stock(남은상품) } 구성
function buildArranged(items, allocs) {
  const byItem = new Map();
  for (const a of allocs) {
    if (!byItem.has(a.shipment_item_id)) byItem.set(a.shipment_item_id, []);
    byItem.get(a.shipment_item_id).push(a);
  }
  const shipping = [], stock = [];
  for (const it of items) {
    const base = {
      출고코드: it.rk_cn_shipments ? it.rk_cn_shipments.shipment_code : null,
      박스명: it.box_name, 중국번호: it.order_number, 상품명: it.product_name, 바코드: it.barcode,
    };
    const total = parseInt(it.quantity) || 0;
    const list = byItem.get(it.id) || [];
    let allocated = 0;
    for (const a of list) {
      shipping.push({ ...base, 수량: total, 출고번호: a.order_number, 센터: a.center, 출고개수: a.ship_qty, 출고예정일: a.shipping_date || '', 회차: a.batch_no || 1, preparedAt: a.prepared_at });
      allocated += a.ship_qty || 0;
    }
    const leftover = total - allocated;
    if (leftover > 0) stock.push({ ...base, 수량: leftover });
  }
  return { shipping, stock };
}

// 저장된 출고배정 조회 → { shipping, stock }
router.get('/api/inbound/arranged', async (req, res) => {
  try {
    const shipmentCode = (req.query.shipmentCode || '').trim();
    let items = await fetchAllItems();
    if (shipmentCode) items = items.filter(i => i.rk_cn_shipments && i.rk_cn_shipments.shipment_code === shipmentCode);
    const itemIds = new Set(items.map(i => i.id));
    const { data: allocs, error } = await sb.from('rk_cn_shipping').select('*');
    if (error) throw error;
    res.json(buildArranged(items, (allocs || []).filter(a => itemIds.has(a.shipment_item_id))));
  } catch (e) {
    console.error('[rk] inbound/arranged:', e);
    res.status(500).json({ error: '출고배정 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

// 출고준비: 선택 발주서 기준으로 "남은 수량만" 증분 배정 → 새 회차(batch)로 rk_cn_shipping 저장
// 기존 배정은 보존(잠금). 회차는 출고코드별 max+1. 남은상품 = 아이템수량 - 배정합계(전 회차).
router.post('/api/inbound/prepare', async (req, res) => {
  try {
    const shipmentCode = (req.body.shipmentCode || '').trim();
    const orderNumbers = Array.isArray(req.body.orderNumbers) ? req.body.orderNumbers : null;

    // 대상 아이템
    let items = await fetchAllItems();
    if (shipmentCode) items = items.filter(i => i.rk_cn_shipments && i.rk_cn_shipments.shipment_code === shipmentCode);
    const targetItemIds = new Set(items.map(i => i.id));

    // 전체 배정 로드
    const { data: allAllocs, error: eAll } = await sb.from('rk_cn_shipping').select('*');
    if (eAll) throw eAll;

    // 발주 가용량 계산용: 바코드→(발주→이미 배정된 합계)  (전 출고코드/전 회차 통합)
    const consumedMap = new Map();
    for (const a of (allAllocs || [])) {
      if (!consumedMap.has(a.barcode)) consumedMap.set(a.barcode, new Map());
      const m = consumedMap.get(a.barcode);
      m.set(a.order_number, (m.get(a.order_number) || 0) + (a.ship_qty || 0));
    }

    // 대상 아이템의 기존 배정 → 아이템별 배정합계(남은수량 계산) + 출고코드별 최대 회차
    const existingForTarget = (allAllocs || []).filter(a => targetItemIds.has(a.shipment_item_id));
    const allocatedByItem = new Map();
    const maxBatchByShipment = new Map();
    for (const a of existingForTarget) {
      allocatedByItem.set(a.shipment_item_id, (allocatedByItem.get(a.shipment_item_id) || 0) + (a.ship_qty || 0));
      maxBatchByShipment.set(a.shipment_id, Math.max(maxBatchByShipment.get(a.shipment_id) || 0, a.batch_no || 0));
    }

    // 발주서 (선택된 것만)
    let orders = await S.listOrdersFull('rk_orders', 'rk_order_items');
    if (orderNumbers && orderNumbers.length) orders = orders.filter(o => orderNumbers.includes(o.발주번호));

    const barcodesInItems = new Set(items.map(i => i.barcode).filter(Boolean));
    const orderProductMap = new Map(); // barcode -> [{order, availableQuantity}]
    for (const order of orders) {
      for (const p of (order.상품정보 || [])) {
        if (!p.상품바코드 || p.박스정보) continue;
        if (!barcodesInItems.has(p.상품바코드)) continue;
        const 스캔 = parseInt(p.스캔수량) || 0;
        const consumed = consumedMap.has(p.상품바코드) && consumedMap.get(p.상품바코드).has(order.발주번호)
          ? consumedMap.get(p.상품바코드).get(order.발주번호) : 0;
        // 가용 = 확정 - 스캔 - (이미 배정된 전량). 입고1/입고2 미차감.
        const avail = (parseInt(p.확정수량) || 0) - 스캔 - consumed;
        if (avail > 0) {
          if (!orderProductMap.has(p.상품바코드)) orderProductMap.set(p.상품바코드, []);
          orderProductMap.get(p.상품바코드).push({
            order: { 발주번호: order.발주번호, 물류센터: order.물류센터, 입고예정일: order.입고예정일 },
            availableQuantity: avail,
          });
        }
      }
    }

    // 증분 배정 (아이템의 남은 수량만, 새 회차 부여)
    const runAt = new Date().toISOString();
    const nextBatch = new Map(); // shipment_id -> 이번 run의 회차
    const allocRows = [];
    for (const it of items) {
      const total = parseInt(it.quantity) || 0;
      let remaining = total - (allocatedByItem.get(it.id) || 0);
      if (remaining <= 0) continue;
      const entries = (orderProductMap.get(it.barcode) || []).slice()
        .sort((a, b) => String(a.order.입고예정일 || '').localeCompare(String(b.order.입고예정일 || '')));
      for (const entry of entries) {
        if (remaining <= 0) break;
        const assign = Math.min(remaining, entry.availableQuantity);
        if (assign > 0) {
          if (!nextBatch.has(it.shipment_id)) nextBatch.set(it.shipment_id, (maxBatchByShipment.get(it.shipment_id) || 0) + 1);
          allocRows.push({
            shipment_item_id: it.id, shipment_id: it.shipment_id, barcode: it.barcode,
            order_number: entry.order.발주번호, center: entry.order.물류센터, ship_qty: assign,
            shipping_date: entry.order.입고예정일 || '', batch_no: nextBatch.get(it.shipment_id), prepared_at: runAt,
          });
          entry.availableQuantity -= assign;
          remaining -= assign;
        }
      }
    }

    // 저장 (기존 유지 + 신규 추가)
    if (allocRows.length) {
      const BATCH = 1000;
      for (let i = 0; i < allocRows.length; i += BATCH) {
        const { error } = await sb.from('rk_cn_shipping').insert(allocRows.slice(i, i + BATCH));
        if (error) throw error;
      }
    }

    const newBatch = allocRows.length ? Math.max(...allocRows.map(r => r.batch_no)) : null;
    const result = buildArranged(items, existingForTarget.concat(allocRows));
    res.json({ ...result, saved: allocRows.length, batch: newBatch });
  } catch (e) {
    console.error('[rk] inbound/prepare:', e);
    res.status(500).json({ error: '출고준비 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 바코드 → 위치 후보 목록: rk_stocks(기존 재고 위치) ∪ rk_inventories(상품관리 위치)
async function locationCandidatesByBarcode(barcodes) {
  const map = new Map(); // barcode -> Set(location)
  if (!barcodes.length) return map;
  const add = (bc, loc) => {
    if (!bc || loc == null) return;
    const l = String(loc).trim();
    if (!l || l === '-') return;
    if (!map.has(bc)) map.set(bc, new Set());
    map.get(bc).add(l);
  };
  const BATCH = 200;
  for (let i = 0; i < barcodes.length; i += BATCH) {
    const chunk = barcodes.slice(i, i + BATCH);
    const { data: st, error: e1 } = await sb.from('rk_stocks').select('barcode, location').in('barcode', chunk);
    if (e1) throw e1;
    for (const x of (st || [])) add(x.barcode, x.location);
    const { data: iv, error: e2 } = await sb.from('rk_inventories').select('barcode, location').in('barcode', chunk);
    if (e2) throw e2;
    for (const x of (iv || [])) add(x.barcode, x.location);
  }
  const out = new Map();
  for (const [bc, set] of map) out.set(bc, [...set]);
  return out;
}

// 재고정리 저장 (입고정리의 '남은상품'을 확정 → rk_cn_stock_arranges, 재실행 시 갱신)
router.post('/api/inbound/stock-arrange', async (req, res) => {
  try {
    const shipmentCode = (req.body.shipmentCode || '').trim();
    if (!shipmentCode) return res.status(400).json({ error: '출고코드가 필요합니다.' });
    let items = await fetchAllItems();
    items = items.filter(i => i.rk_cn_shipments && i.rk_cn_shipments.shipment_code === shipmentCode);
    if (!items.length) return res.json({ message: '대상 아이템이 없습니다.', saved: 0 });

    const targetShipmentIds = [...new Set(items.map(i => i.shipment_id))];
    const targetItemIds = new Set(items.map(i => i.id));

    const { data: allocs, error: eA } = await sb.from('rk_cn_shipping').select('shipment_item_id, ship_qty');
    if (eA) throw eA;
    const allocByItem = new Map();
    for (const a of (allocs || [])) if (targetItemIds.has(a.shipment_item_id)) allocByItem.set(a.shipment_item_id, (allocByItem.get(a.shipment_item_id) || 0) + (a.ship_qty || 0));

    // 재실행 = 해당 출고코드 기존 재고정리 삭제 후 현재 남은상품으로 재삽입
    const { error: eD } = await sb.from('rk_cn_stock_arranges').delete().in('shipment_id', targetShipmentIds);
    if (eD) throw eD;

    const rows = [];
    for (const it of items) {
      const leftover = (parseInt(it.quantity) || 0) - (allocByItem.get(it.id) || 0);
      if (leftover > 0) rows.push({ shipment_id: it.shipment_id, shipment_item_id: it.id, barcode: it.barcode, qty: leftover });
    }
    if (rows.length) {
      const B = 1000;
      for (let i = 0; i < rows.length; i += B) {
        const { error } = await sb.from('rk_cn_stock_arranges').insert(rows.slice(i, i + B));
        if (error) throw error;
      }
    }
    res.json({ message: `재고정리 완료 (${rows.length}건)`, saved: rows.length });
  } catch (e) {
    console.error('[rk] inbound/stock-arrange:', e);
    res.status(500).json({ error: '재고정리 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 재고정리 조회 (전체 노출) — 아이템/헤더 join + 바코드→위치후보 목록
router.get('/api/inbound/stock-arranges', async (req, res) => {
  try {
    const { data, error } = await sb.from('rk_cn_stock_arranges')
      .select('*, rk_cn_shipments(shipment_code), rk_cn_shipment_items(box_name, order_number, product_name)')
      .order('id', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    const candMap = await locationCandidatesByBarcode([...new Set(rows.map(r => r.barcode).filter(Boolean))]);
    res.json(rows.map(r => ({
      id: r.id,
      출고코드: r.rk_cn_shipments ? r.rk_cn_shipments.shipment_code : null,
      박스명: r.rk_cn_shipment_items ? r.rk_cn_shipment_items.box_name : null,
      중국번호: r.rk_cn_shipment_items ? r.rk_cn_shipment_items.order_number : null,
      상품명: r.rk_cn_shipment_items ? r.rk_cn_shipment_items.product_name : null,
      수량: r.qty,
      바코드: r.barcode,
      위치후보: candMap.get(r.barcode) || [],
    })));
  } catch (e) {
    console.error('[rk] inbound/stock-arranges:', e);
    res.status(500).json({ error: '재고정리 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

// 처리완료: 체크된 항목을 선택 위치로 rk_stocks 에 반영(합산) 후 재고정리 행 삭제
router.post('/api/inbound/stock-complete', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '처리할 항목이 없습니다.' });
    for (const it of items) {
      if (!it.location || !String(it.location).trim()) return res.status(400).json({ error: '위치가 선택되지 않은 항목이 있습니다.' });
    }
    for (const it of items) {
      const barcode = String(it.barcode || '').trim();
      const location = String(it.location).trim();
      const qty = parseInt(it.qty) || 0;
      if (!barcode || qty <= 0) continue;
      // 같은 바코드+위치 있으면 합산, 없으면 신규
      const { data: ex, error: eF } = await sb.from('rk_stocks').select('id, qty').eq('barcode', barcode).eq('location', location).limit(1);
      if (eF) throw eF;
      if (ex && ex.length) {
        const { error } = await sb.from('rk_stocks').update({ qty: (parseInt(ex[0].qty) || 0) + qty }).eq('id', ex[0].id);
        if (error) throw error;
      } else {
        const { data: inv } = await sb.from('rk_inventories').select('sku_id, name').eq('barcode', barcode).limit(1);
        const { error } = await sb.from('rk_stocks').insert({
          barcode, location, qty,
          sku_id: inv && inv.length ? inv[0].sku_id : null,
          item_name: inv && inv.length ? inv[0].name : null,
        });
        if (error) throw error;
      }
    }
    const ids = items.map(it => it.id).filter(Boolean);
    if (ids.length) {
      const { error } = await sb.from('rk_cn_stock_arranges').delete().in('id', ids);
      if (error) throw error;
    }
    res.json({ message: `처리완료 (${items.length}건)`, done: items.length });
  } catch (e) {
    console.error('[rk] inbound/stock-complete:', e);
    res.status(500).json({ error: '처리완료 중 오류가 발생했습니다: ' + e.message });
  }
});

// 출고코드 단위 삭제 (헤더 삭제 → 아이템 cascade)
router.delete('/api/inbound/delete/:shipmentCode', async (req, res) => {
  try {
    const { error } = await sb.from('rk_cn_shipments').delete().eq('shipment_code', req.params.shipmentCode);
    if (error) throw error;
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error('[rk] inbound/delete:', e);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
