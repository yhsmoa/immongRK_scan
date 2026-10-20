/**
 * 통합 배정 (신규 발주서 가상버전 /newOrderV [배정]) — 재고(rk_stocks) + 입고(입고코드별 남은 상품)를 한 번에 배정
 * 설계: docs/plan-neworder-virtual.md §4, §9
 *
 *   GET  /api/allocate/sources?orderNumbers=a,b   모달 오른쪽: 발주서 등록 상태 · 재고 가용 종수 · 입고코드별 남은 종수/개수
 *   POST /api/allocate/run                         계산(save:false) / 저장(save:true → RPC rk_allocate_save, 한 트랜잭션)
 *   GET  /api/allocate/status?orderNumbers=a,b     표 채우기: 발주번호+바코드별 저장된 배정(재고 위치 · 입고코드-박스명)
 *   POST /api/allocate/cancel                       배정 취소 (재고 복원 / 입고 배정 삭제 — 기존 두 화면과 같은 함수)
 *
 * 저장 결과는 기존 화면과 같은 테이블·같은 형식이다:
 *   재고 → rk_shipping_list(source='재고') + rk_stocks 차감 + 이력  → 재고준비 [예정] 탭에 그 회차로 보인다
 *   입고 → rk_cn_shipping + rk_shipping_list 미러                   → 입고정리 [출고리스트] 에 그 회차로 보이고 남은상품·재고정리에서 빠진다
 */
const express = require('express');
const S = require('./rkShared');
const AllocPlan = require('../allocPlan');
const shippingListRouter = require('./rkShippingList');   // cancelStockReservations
const inboundRouter = require('./rkInbound');             // deleteInboundAllocs

const router = express.Router();
const sb = S.supabase;

const parseNos = (v) => {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  return [...new Set(list.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
};
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const sumBy = (rows, keyFn, qtyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; m.set(k, (m.get(k) || 0) + qtyFn(r)); }
  return m;
};

// 발주번호들 → 헤더(rk_orders) · 상태
async function loadHeaders(orderNumbers) {
  const rows = await S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_orders')
    .select('id, order_number, logistics_center, arrival_date, status').in('order_number', nos).order('id', { ascending: true })));
  const byNo = new Map();
  for (const h of rows) { const k = String(h.order_number); if (!byNo.has(k)) byNo.set(k, h); }
  return byNo;
}
// 등록 상태: 'registered' | 'unregistered' | 'done'
const regState = (h) => (!h ? 'unregistered' : (h.status === 'DONE' ? 'done' : 'registered'));

// 진행중 발주서들의 상품행(원본) → 발주서마다 바코드별 확정수량 합 (상품행 id 순 = 화면 순서)
async function loadOrderRows(headers) {
  const ids = headers.map((h) => h.id);
  const items = ids.length ? await S.chunked(ids, 200, (part) => S.pageAll(() => sb.from('rk_order_items')
    .select('id, order_id, barcode, product_name, confirmed_qty, box_info').in('order_id', part).order('id', { ascending: true }))) : [];
  const byOrder = new Map();
  for (const it of items) {
    if (it.box_info) continue;
    const bc = String(it.barcode || '').trim();
    if (!bc) continue;
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, new Map());
    const m = byOrder.get(it.order_id);
    const cur = m.get(bc) || { barcode: bc, productName: it.product_name || '', confirmedQty: 0 };
    cur.confirmedQty += toInt(it.confirmed_qty);
    if (!cur.productName && it.product_name) cur.productName = it.product_name;
    m.set(bc, cur);
  }
  return headers.map((h) => ({
    orderNumber: String(h.order_number), center: S.str(h.logistics_center), shippingDate: S.dateToYmd(h.arrival_date),
    rows: [...((byOrder.get(h.id) || new Map()).values())],
  }));
}

// 입고코드 목록 (등록 시각 순 = 오래된 것 먼저 → codeRank)
async function loadShipments() {
  const list = await S.pageAll(() => sb.from('rk_cn_shipments').select('id, shipment_code, created_at').order('created_at', { ascending: true }).order('id', { ascending: true }));
  return list.map((s, i) => ({ id: s.id, code: String(s.shipment_code), createdAt: s.created_at, rank: i }));
}

// 입고 풀: 바코드가 겹치는 아이템의 남은 수량 = 원본 − 출고배정 − 재고확정 (재고정리 화면과 같은 공식)
//   shipments: loadShipments() 중 대상 코드들. 남은 > 0 만 돌려준다
async function loadInboundPool(shipments, barcodes) {
  if (!shipments.length || !barcodes.length) return [];
  const shipIds = shipments.map((s) => s.id);
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const items = await S.chunked(barcodes, 150, (bcs) => S.pageAll(() => sb.from('rk_cn_shipment_items')
    .select('id, shipment_id, pallet, box_name, barcode, quantity').in('shipment_id', shipIds).in('barcode', bcs).order('id', { ascending: true })));
  if (!items.length) return [];
  const itemIds = items.map((i) => i.id);
  const [shipped, arranged] = await Promise.all([
    S.chunked(itemIds, 200, (part) => S.pageAll(() => sb.from('rk_cn_shipping').select('shipment_item_id, ship_qty').in('shipment_item_id', part).order('id', { ascending: true }))),
    S.chunked(itemIds, 200, (part) => S.pageAll(() => sb.from('rk_cn_stock_arranges').select('shipment_item_id, qty').in('shipment_item_id', part).order('id', { ascending: true }))),
  ]);
  const shippedBy = sumBy(shipped, (r) => r.shipment_item_id, (r) => toInt(r.ship_qty));
  const arrangedBy = sumBy(arranged, (r) => r.shipment_item_id, (r) => toInt(r.qty));
  const pool = [];
  for (const it of items) {
    const remain = AllocPlan.inboundRemain(it.quantity, shippedBy.get(it.id) || 0, arrangedBy.get(it.id) || 0);
    if (remain <= 0) continue;
    const sh = shipById.get(it.shipment_id);
    pool.push({ shipmentId: it.shipment_id, shipmentItemId: it.id, code: sh.code, codeRank: sh.rank, barcode: String(it.barcode || '').trim(),
      pallet: it.pallet || '', boxName: it.box_name || '', remain });
  }
  return pool;
}

async function loadStockPool(barcodes) {
  if (!barcodes.length) return [];
  const rows = await S.chunked(barcodes, 200, (bcs) => S.pageAll(() => sb.from('rk_stocks')
    .select('id, barcode, location, qty').in('barcode', bcs).gt('qty', 0).order('id', { ascending: true })));
  return rows.map((s) => ({ stockId: s.id, barcode: String(s.barcode || '').trim(), location: String(s.location || '').trim(), qty: toInt(s.qty) }));
}

// 기존 예약(출고예정, 재고+입고) · 출고스캔 — 발주번호+바코드 합. 재고 예약의 위치는 동선 구역 우선에 쓴다
async function loadReservedScanned(orderNumbers) {
  const [resv, scan] = await Promise.all([
    S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_shipping_list')
      .select('order_number, barcode, qty, source, location').eq('status', '출고예정').in('order_number', nos).order('id', { ascending: true }))),
    S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_ship_box_items')
      .select('order_number, barcode, qty, virtual_qty').in('order_number', nos).order('id', { ascending: true }))),
  ]);
  const k = (r) => (r.order_number && r.barcode ? `${r.order_number}|${r.barcode}` : null);
  const zonesByOrder = {};
  for (const r of resv) if (r.source === '재고' && r.location) (zonesByOrder[r.order_number] ||= []).push(r.location);
  return {
    reservedByKey: sumBy(resv, k, (r) => toInt(r.qty)),
    scannedByKey: sumBy(scan, k, (r) => toInt(r.qty)),
    virtualByKey: sumBy(scan, k, (r) => toInt(r.virtual_qty)),
    zonesByOrder,
  };
}

// ── 모달 오른쪽 ──
router.get('/api/allocate/sources', async (req, res) => {
  try {
    const orderNumbers = parseNos(req.query.orderNumbers);
    if (!orderNumbers.length) return res.status(400).json({ error: '발주번호가 없습니다.' });
    const headers = await loadHeaders(orderNumbers);
    const orders = orderNumbers.map((no) => ({ orderNumber: no, state: regState(headers.get(no)) }));
    const active = orderNumbers.map((no) => headers.get(no)).filter((h) => h && h.status !== 'DONE');
    const orderRows = await loadOrderRows(active);
    const barcodes = [...new Set(orderRows.flatMap((o) => o.rows.map((r) => r.barcode)))];
    const shipments = await loadShipments();
    const [stockPool, inboundPool] = await Promise.all([loadStockPool(barcodes), loadInboundPool(shipments, barcodes)]);
    const byCode = new Map();
    for (const p of inboundPool) {
      const c = byCode.get(p.code) || { skus: new Set(), qty: 0 };
      c.skus.add(p.barcode); c.qty += p.remain; byCode.set(p.code, c);
    }
    // 최근 코드부터 보여준다 (고르기 편하게). 남은 것이 없는 코드도 0 으로 보여 준다 (최근 8개까지 + 남은 것이 있는 코드 전부)
    const recent = shipments.slice().reverse();
    const codes = recent.filter((s, i) => i < 8 || byCode.has(s.code)).map((s) => {
      const c = byCode.get(s.code);
      return { code: s.code, createdAt: s.createdAt, skus: c ? c.skus.size : 0, qty: c ? c.qty : 0 };
    });
    res.json({
      orders,
      barcodes: barcodes.length,
      stock: { skus: new Set(stockPool.map((p) => p.barcode)).size, qty: stockPool.reduce((s, p) => s + p.qty, 0) },
      inboundCodes: codes,
    });
  } catch (e) {
    console.error('[rk] allocate/sources:', e);
    res.status(500).json({ error: '배정 출처 조회 실패: ' + e.message });
  }
});

// 계산 한 벌 (run 의 미리보기·저장 공용 — 저장은 이 함수를 그 시점 DB 로 다시 부른다)
async function computePlan(orderNumbers, sources, sourceOrder) {
  const headers = await loadHeaders(orderNumbers);
  const excluded = [];
  const active = [];
  for (const no of orderNumbers) {
    const h = headers.get(no);
    const st = regState(h);
    if (st === 'unregistered') excluded.push({ orderNumber: no, reason: '미등록' });
    else if (st === 'done') excluded.push({ orderNumber: no, reason: '처리완료' });
    else active.push(h);
  }
  const orders = await loadOrderRows(active);
  const activeNos = orders.map((o) => o.orderNumber);
  const barcodes = [...new Set(orders.flatMap((o) => o.rows.map((r) => r.barcode)))];
  const useStock = sourceOrder.includes('재고');
  const codes = sourceOrder.includes('입고') ? sources.inboundCodes : [];
  const shipments = codes.length ? (await loadShipments()).filter((s) => codes.includes(s.code)) : [];
  const [rs, stockPool, inboundPool] = await Promise.all([
    activeNos.length ? loadReservedScanned(activeNos) : Promise.resolve({ reservedByKey: new Map(), scannedByKey: new Map(), virtualByKey: new Map(), zonesByOrder: {} }),
    useStock ? loadStockPool(barcodes) : Promise.resolve([]),
    loadInboundPool(shipments, barcodes),
  ]);
  const plan = AllocPlan.planAllocation({ orders, reservedByKey: rs.reservedByKey, scannedByKey: rs.scannedByKey,
    stockPool, inboundPool, sourceOrder, zonesByOrder: rs.zonesByOrder });
  plan.excluded = excluded;
  return plan;
}

// body: { orderNumbers:[…], sources:{ stock:bool, inboundCodes:[…] }, sourceOrder:['입고','재고'], save:bool, expect?:{rows:'발주|바코드|재고|입고'…} }
router.post('/api/allocate/run', async (req, res) => {
  try {
    const orderNumbers = parseNos(req.body.orderNumbers);
    if (!orderNumbers.length) return res.status(400).json({ error: '발주번호가 없습니다.' });
    if (orderNumbers.length > 300) return res.status(400).json({ error: '한 번에 300건까지 배정할 수 있습니다.' });
    const src = req.body.sources || {};
    const inboundCodes = parseNos(src.inboundCodes);
    const enabled = [];
    if (src.stock) enabled.push('재고');
    if (inboundCodes.length) enabled.push('입고');
    if (!enabled.length) return res.status(400).json({ error: '출처(재고 또는 입고코드)를 하나 이상 고르세요.' });
    const order = Array.isArray(req.body.sourceOrder) ? req.body.sourceOrder.filter((s) => AllocPlan.SOURCES.includes(s)) : [];
    let sourceOrder;
    if (enabled.length === 1) sourceOrder = enabled;
    else {
      if (order.length !== 2 || new Set(order).size !== 2) return res.status(400).json({ error: '순서(입고 → 재고 / 재고 → 입고)를 고르세요.' });
      sourceOrder = order;
    }
    const save = req.body.save === true;
    const plan = await computePlan(orderNumbers, { inboundCodes }, sourceOrder);
    if (!plan.ok) return res.status(400).json({ error: plan.reason });
    if (!save) return res.json({ save: false, ...plan });

    // 저장 — 지금 DB 로 다시 계산한 plan 을 RPC 로 (한 트랜잭션, 모자라면 전체 롤백)
    const stock = [], inbound = [];
    for (const r of plan.rows) {
      for (const a of r.allocs) {
        const base = { orderNumber: r.orderNumber, center: r.center, shippingDate: r.shippingDate, barcode: r.barcode, productName: r.productName, qty: a.qty };
        if (a.source === '재고') stock.push({ ...base, stockId: a.stockId, location: a.location });
        else inbound.push({ ...base, shipmentId: a.shipmentId, shipmentItemId: a.shipmentItemId });
      }
    }
    if (!stock.length && !inbound.length) return res.json({ save: true, saved: { savedStock: 0, savedInbound: 0 }, ...plan });
    const { data, error } = await sb.rpc('rk_allocate_save', { p: { stock, inbound, note: '가상버전 배정' } });
    if (error) {
      const msg = String(error.message || '');
      if (msg.startsWith('ALLOC:')) return res.status(409).json({ error: msg.slice(6) });
      throw error;
    }
    // 미리보기와 달라졌는지 (다른 PC 가 먼저 배정했거나 재고가 바뀜) — 화면이 안내만 한다
    let changed = null;
    if (req.body.expect && typeof req.body.expect === 'object') {
      const now = {};
      for (const r of plan.rows) now[`${r.orderNumber}|${r.barcode}`] = `${r.stockQty}|${r.inboundQty}`;
      changed = Object.keys(Object.assign({}, now, req.body.expect)).filter((k) => (now[k] || '0|0') !== (req.body.expect[k] || '0|0')).length;
    }
    res.json({ save: true, saved: data, changed, ...plan });
  } catch (e) {
    console.error('[rk] allocate/run:', e);
    res.status(500).json({ error: '배정 실패: ' + e.message });
  }
});

// ── 표 채우기 — 저장된 배정 (출고예정) ──
// 응답: { orders:{ 발주번호: 'registered'|'unregistered'|'done' }, allocs:{ "발주|바코드": [{ listId, source, location, code, boxName, qty, batchNo }] },
//         scanned:{ "발주|바코드": n }, virtual:{ "발주|바코드": n } }
router.get('/api/allocate/status', async (req, res) => {
  try {
    const orderNumbers = parseNos(req.query.orderNumbers);
    if (!orderNumbers.length) return res.json({ orders: {}, allocs: {}, scanned: {}, virtual: {} });
    const headers = await loadHeaders(orderNumbers);
    const [rows, scan] = await Promise.all([
      S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_shipping_list')
        .select('id, source, order_number, barcode, location, qty, batch_no, shipment_id, shipment_item_id, mobile_status')
        .eq('status', '출고예정').in('order_number', nos).order('id', { ascending: true }))),
      S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_ship_box_items')
        .select('order_number, barcode, qty, virtual_qty').in('order_number', nos).order('id', { ascending: true }))),
    ]);
    const itemIds = [...new Set(rows.filter((r) => r.source === '입고' && r.shipment_item_id).map((r) => r.shipment_item_id))];
    const shipIds = [...new Set(rows.filter((r) => r.source === '입고' && r.shipment_id).map((r) => r.shipment_id))];
    const [items, ships] = await Promise.all([
      itemIds.length ? S.chunked(itemIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipment_items').select('id, box_name').in('id', part); if (error) throw error; return data || []; }) : [],
      shipIds.length ? S.chunked(shipIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipments').select('id, shipment_code').in('id', part); if (error) throw error; return data || []; }) : [],
    ]);
    const boxById = new Map(items.map((i) => [i.id, i.box_name]));
    const codeById = new Map(ships.map((s) => [s.id, s.shipment_code]));
    const allocs = {};
    for (const r of rows) {
      if (!r.barcode) continue;
      (allocs[`${r.order_number}|${r.barcode}`] ||= []).push({ listId: r.id, source: r.source, location: r.location || '',
        code: r.source === '입고' ? String(codeById.get(r.shipment_id) || '') : '', boxName: r.source === '입고' ? String(boxById.get(r.shipment_item_id) || '') : '',
        qty: toInt(r.qty), batchNo: r.batch_no, mobile: r.mobile_status || null });
    }
    const scanned = {}, virtual = {};
    for (const r of scan) {
      if (!r.order_number || !r.barcode) continue;
      const k = `${r.order_number}|${r.barcode}`;
      scanned[k] = (scanned[k] || 0) + toInt(r.qty);
      const v = toInt(r.virtual_qty); if (v > 0) virtual[k] = (virtual[k] || 0) + v;
    }
    const orders = {};
    for (const no of orderNumbers) orders[no] = regState(headers.get(no));
    res.json({ orders, allocs, scanned, virtual });
  } catch (e) {
    console.error('[rk] allocate/status:', e);
    res.status(500).json({ error: '배정 현황 조회 실패: ' + e.message });
  }
});

// ── 배정 취소 — body: { orderNumber, barcode, listIds?:[rk_shipping_list.id] } (listIds 없으면 그 발주번호+바코드의 출고예정 전부) ──
//   가상스캔으로 박스에 담긴 분량이 남은 배정보다 많아지면 거부 (가상 분량의 근거가 사라진다 → 출고스캔에서 박스를 먼저 비울 것)
//   재고 행 → cancelStockReservations (재고준비 [취소] 와 같은 함수: 예약 삭제 + rk_stocks 복원 + 이력)
//   입고 행 → deleteInboundAllocs (입고정리 배정 삭제와 같은 함수: rk_cn_shipping + 미러 삭제 → 남은상품으로 돌아간다)
router.post('/api/allocate/cancel', async (req, res) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const barcode = String(req.body.barcode || '').trim();
    if (!orderNumber || !barcode) return res.status(400).json({ error: '발주번호와 바코드가 필요합니다.' });
    const want = Array.isArray(req.body.listIds) ? new Set(req.body.listIds.map((v) => parseInt(v, 10)).filter(Number.isFinite)) : null;
    const { data: rows, error } = await sb.from('rk_shipping_list').select('id, source, qty, cn_shipping_id')
      .eq('order_number', orderNumber).eq('barcode', barcode).eq('status', '출고예정').order('id', { ascending: true });
    if (error) throw error;
    const targets = (rows || []).filter((r) => !want || want.has(r.id));
    if (!targets.length) return res.status(404).json({ error: '취소할 배정이 없습니다.' });
    const { data: box, error: eB } = await sb.from('rk_ship_box_items').select('qty, virtual_qty').eq('order_number', orderNumber).eq('barcode', barcode);
    if (eB) throw eB;
    const virtualQty = (box || []).reduce((s, b) => s + toInt(b.virtual_qty), 0);
    const total = (rows || []).reduce((s, r) => s + toInt(r.qty), 0);
    const cancelQty = targets.reduce((s, r) => s + toInt(r.qty), 0);
    if (virtualQty > 0 && total - cancelQty < virtualQty) {
      return res.status(409).json({ error: `가상스캔으로 박스에 담긴 ${virtualQty}개가 있어 취소할 수 없습니다 (취소 후 배정 ${total - cancelQty}개). 출고스캔에서 박스를 먼저 비우세요.` });
    }
    const stockIds = targets.filter((r) => r.source === '재고').map((r) => r.id);
    const cnIds = targets.filter((r) => r.source === '입고' && r.cn_shipping_id != null).map((r) => r.cn_shipping_id);
    const orphanInbound = targets.filter((r) => r.source === '입고' && r.cn_shipping_id == null).map((r) => r.id);
    const out = { stock: { canceled: 0, restored: 0 }, inbound: { deleted: 0 } };
    if (stockIds.length) out.stock = await shippingListRouter.cancelStockReservations(stockIds, '가상버전 배정 취소 복원');
    if (cnIds.length) out.inbound = await inboundRouter.deleteInboundAllocs(cnIds);
    if (orphanInbound.length) {   // 원본(rk_cn_shipping) 없는 입고 미러 — 정상 경로에선 없다. 미러만 지운다
      const { error: eO } = await sb.from('rk_shipping_list').delete().in('id', orphanInbound);
      if (eO) throw eO;
    }
    res.json({ ok: true, orderNumber, barcode, canceledQty: cancelQty, ...out });
  } catch (e) {
    console.error('[rk] allocate/cancel:', e);
    res.status(500).json({ error: '배정 취소 실패: ' + e.message });
  }
});

module.exports = router;
