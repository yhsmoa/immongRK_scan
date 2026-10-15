/**
 * 출고스캔 도메인 — 발주서 단위 박스 출고 스캔 (rk_ship_boxes / rk_ship_box_items)
 * 설계: docs/plan-ship-scan.md
 *
 * - 유효 발주서 = rk_orders 존재
 * - 저장 = 신규 테이블 (기존 /scan·rk_order_items 무영향)
 * - 초과 차단 = 바코드별 확정수량 합 한도
 */
const express = require('express');
const S = require('./rkShared');

const router = express.Router();
const sb = S.supabase;

// 발주서의 바코드별 한도(확정수량 합) + 상품명 + 준비수량 + 발주서 원본 위치
async function orderBarcodeMeta(orderNumber) {
  const order = await S.getOrderFull('rk_orders', 'rk_order_items', orderNumber);
  const limit = new Map();  // barcode -> 확정수량 합
  const name = new Map();    // barcode -> 상품명
  const prep = new Map();    // barcode -> 준비수량 합 (전부 미입력이면 null 유지)
  const loc = new Map();     // barcode -> 발주서에 적힌 위치
  if (order && Array.isArray(order.상품정보)) {
    for (const p of order.상품정보) {
      if (p.박스정보) continue;               // 원본(박스 아님) 행만
      const bc = p.상품바코드;
      if (!bc) continue;
      limit.set(bc, (limit.get(bc) || 0) + (parseInt(p.확정수량) || 0));
      if (!name.has(bc) && p.상품이름) name.set(bc, p.상품이름);
      if (p.준비 != null) prep.set(bc, (prep.get(bc) || 0) + (parseInt(p.준비) || 0));
      if (!loc.has(bc) && p.위치 && p.위치 !== '-') loc.set(bc, p.위치);
    }
  }
  return { order, limit, name, prep, loc };
}

// 바코드별 위치 — 출고예정(rk_shipping_list source='재고') 위치 우선, 없으면 rk_stocks 위치.
// 출고준비(shipPrepare) 화면과 같은 우선순위를 쓴다. 정렬 전용이라 실패해도 조용히 넘어간다.
async function locationsByBarcode(orderNumber, barcodes) {
  const out = new Map();
  if (!barcodes.length) return out;
  const sortLoc = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });
  try {
    for (let i = 0; i < barcodes.length; i += 200) {
      const chunk = barcodes.slice(i, i + 200);
      const { data, error } = await sb.from('rk_shipping_list')
        .select('barcode, location')
        .eq('source', '재고').eq('status', '출고예정').eq('order_number', orderNumber)
        .in('barcode', chunk);
      if (error) throw error;
      const byBc = new Map();
      for (const r of (data || [])) {
        const l = String(r.location || '').trim();
        if (!r.barcode || !l || l === '-') continue;
        if (!byBc.has(r.barcode)) byBc.set(r.barcode, []);
        byBc.get(r.barcode).push(l);
      }
      for (const [bc, list] of byBc) out.set(bc, list.sort(sortLoc).join(' · '));
    }
    const rest = barcodes.filter(b => !out.has(b));
    for (let i = 0; i < rest.length; i += 200) {
      const chunk = rest.slice(i, i + 200);
      const { data, error } = await sb.from('rk_stocks').select('barcode, location').in('barcode', chunk);
      if (error) throw error;
      const byBc = new Map();
      for (const r of (data || [])) {
        const l = String(r.location || '').trim();
        if (!r.barcode || !l || l === '-') continue;
        if (!byBc.has(r.barcode)) byBc.set(r.barcode, []);
        byBc.get(r.barcode).push(l);
      }
      for (const [bc, list] of byBc) out.set(bc, [...new Set(list)].sort(sortLoc).join(' · '));
    }
  } catch (e) {
    console.error('[rk] ship-scan 위치 조회 실패(정렬만 영향):', e.message);
  }
  return out;
}

// 바코드별 출고예정 배정량(재고+입고 합) — 가상스캔의 목표 수량 기준 (docs/plan-virtual-scan.md §1-1)
// 준비수량(prepared_qty)과는 별개 값이다. 실패해도 조용히 빈 맵 (가상스캔만 영향).
//   바코드 → { total, stock(재고), inbound(입고), inboundByCode:{입고코드: qty} } — 가상스캔이 출처별로 박스를 나눠 담고,
//   입고분은 입고코드(rk_cn_shipments.shipment_code, 입고정리의 드롭박스)별로 골라 담을 수 있게 같이 센다 (2026-10-15)
async function allocByBarcode(orderNumber) {
  const out = new Map();
  try {
    const { data, error } = await sb.from('rk_shipping_list')
      .select('barcode, qty, source, shipment_id').eq('order_number', orderNumber).eq('status', '출고예정');
    if (error) throw error;
    // 입고분의 shipment_id → 입고코드
    const shipIds = [...new Set((data || []).map((r) => r.shipment_id).filter((x) => x != null))];
    const codeById = new Map();
    for (let i = 0; i < shipIds.length; i += 200) {
      const { data: cs, error: eC } = await sb.from('rk_cn_shipments').select('id, shipment_code').in('id', shipIds.slice(i, i + 200));
      if (eC) throw eC;
      for (const c of (cs || [])) codeById.set(c.id, c.shipment_code);
    }
    for (const r of (data || [])) {
      if (!r.barcode) continue;
      const q = parseInt(r.qty, 10) || 0;
      const a = out.get(r.barcode) || { total: 0, stock: 0, inbound: 0, inboundByCode: {} };
      a.total += q;
      if (r.source === '재고') a.stock += q;
      else if (r.source === '입고') {
        a.inbound += q;
        const code = codeById.get(r.shipment_id) || '(코드 없음)';
        a.inboundByCode[code] = (a.inboundByCode[code] || 0) + q;
      }
      out.set(r.barcode, a);
    }
  } catch (e) {
    console.error('[rk] ship-scan 배정량 조회 실패(가상스캔만 영향):', e.message);
  }
  return out;
}

// 바코드별 상품 사이즈 (coupang_items: mm·g) — 가상스캔 부피/무게 계산용. 없으면 null.
async function sizesByBarcode(barcodes) {
  const out = new Map();
  try {
    for (let i = 0; i < barcodes.length; i += 200) {
      const { data, error } = await sb.from('coupang_items')
        .select('barcode, size_width, size_length, size_height, weight').in('barcode', barcodes.slice(i, i + 200));
      if (error) throw error;
      for (const r of (data || [])) {
        if (!r.barcode || out.has(r.barcode)) continue;
        out.set(r.barcode, { w: r.size_width, l: r.size_length, h: r.size_height, g: r.weight });
      }
    }
  } catch (e) {
    console.error('[rk] ship-scan 사이즈 조회 실패(가상스캔만 영향):', e.message);
  }
  return out;
}

// 발주서 스캔 상태 한 벌 — GET /api/ship-scan/order 의 응답 본문. 일괄 가상스캔(virtual-batch)도 같은 것을 쓴다.
//   { ok:true, payload } | { ok:false, status, error }
async function loadOrderScanState(orderNumberIn) {
  const orderNumber = String(orderNumberIn || '').trim();
  if (!orderNumber) return { ok: false, status: 400, error: '발주번호가 필요합니다.' };

  const orderId = await S.getOrderId('rk_orders', orderNumber);
  if (!orderId) return { ok: false, status: 404, error: '존재하지 않는 발주서입니다.' };

  const { order, limit, name, prep, loc } = await orderBarcodeMeta(orderNumber);
  // 처리완료(DONE) 발주서는 스캔 대상에서 제외
  if (S.isDoneOrder(order)) return { ok: false, status: 404, error: '처리완료된 발주서입니다.' };
  const barcodes = [...limit.keys()];
  const [locMap, allocMap, sizeMap] = await Promise.all([
    locationsByBarcode(orderNumber, barcodes),
    allocByBarcode(orderNumber),
    sizesByBarcode(barcodes),
  ]);
  const products = barcodes.map(bc => ({
    barcode: bc, productName: name.get(bc) || '', confirmedQty: limit.get(bc) || 0,
    preparedQty: prep.has(bc) ? prep.get(bc) : null,      // 미입력은 null (0 과 구분)
    location: locMap.get(bc) || loc.get(bc) || '',        // 정렬용
    allocQty: (allocMap.get(bc) || {}).total || 0,        // 출고예정 배정량 (가상스캔 목표)
    allocStock: (allocMap.get(bc) || {}).stock || 0,      //   그중 재고분 — 가상스캔 출처별 박스 분리용
    allocInbound: (allocMap.get(bc) || {}).inbound || 0,  //   그중 입고분
    allocInboundByCode: (allocMap.get(bc) || {}).inboundByCode || {},   //   입고분을 입고코드별로 — 가상스캔 모달의 입고코드 선택용
    size: sizeMap.get(bc) || null,                        // {w,l,h,g} mm·g (가상스캔 부피/무게)
  }));

  // 기존 박스 + 출고리스트
  const { data: boxes, error: eB } = await sb.from('rk_ship_boxes')
    .select('*').eq('order_number', orderNumber).order('box_no', { ascending: true });
  if (eB) throw eB;
  const boxIds = (boxes || []).map(b => b.id);
  let items = [];
  if (boxIds.length) {
    const { data: it, error: eI } = await sb.from('rk_ship_box_items')
      .select('*').in('box_id', boxIds).order('id', { ascending: true });
    if (eI) throw eI;
    items = it || [];
  }
  const boxNoById = new Map((boxes || []).map(b => [b.id, b.box_no]));

  return { ok: true, payload: {
    valid: true,
    orderNumber,
    center: (order && order.물류센터) || '',
    arrivalDate: (order && order.입고예정일) || '',
    products,
    // isVirtual / virtualQty: [가상스캔]으로 들어온 분량 표시 (화면 '가상' 태그)
    // virtualConfirmedQty: 가상확정 당시 가상 합 — 화면이 현재 가상 합과 비교해 "확정" 여부를 판단한다
    boxes: (boxes || []).map(b => ({ id: b.id, boxNo: b.box_no, boxSize: b.box_size, createdAt: b.created_at, isVirtual: !!b.is_virtual,
      virtualConfirmedQty: parseInt(b.virtual_confirmed_qty, 10) || 0 })),
    items: items.map(i => ({ boxId: i.box_id, boxNo: boxNoById.get(i.box_id), barcode: i.barcode, productName: i.product_name, qty: i.qty, virtualQty: i.virtual_qty || 0 })),
  } };
}

// 발주서 조회 (유효성 + 상품/박스/출고리스트)
router.get('/api/ship-scan/order/:orderNumber', async (req, res) => {
  try {
    const r = await loadOrderScanState(req.params.orderNumber);
    if (!r.ok) return res.status(r.status).json(r.status === 400 ? { error: r.error } : { valid: false, error: r.error });
    res.json(r.payload);
  } catch (e) {
    console.error('[rk] ship-scan/order:', e);
    res.status(500).json({ error: '발주서 조회 실패: ' + e.message });
  }
});

// 상태 코드를 붙인 오류 — saveShipState 가 검증 실패를 알릴 때. 라우트는 e.status 로 응답 코드를 정한다
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// 저장 — 현재 작업 상태(박스아이템 전체)를 그대로 반영(SET). 스캔·개수편집·삭제 모두 지원.
// body: { orderNumber, boxes:[{boxNo,boxSize}], items:[{boxNo,barcode,productName,qty,virtualQty?}] }
//   virtualQty = qty 중 [가상스캔]으로 들어온 개수 (0~qty). rk_ship_box_items.virtual_qty 로 저장하고,
//   박스에 가상 수량이 하나라도 있으면 rk_ship_boxes.is_virtual=true (없으면 false 로 되돌린다 — SET 이므로 매번 다시 계산).
// POST /api/ship-scan/save 와 일괄 가상스캔(virtual-batch)이 같이 쓴다. 검증 실패는 httpErr(400/404) 로 throw.
async function saveShipState(orderNumberIn, boxesRaw, itemsRaw) {
  const orderNumber = String(orderNumberIn || '').trim();
  const boxesIn = Array.isArray(boxesRaw) ? boxesRaw : [];
  const itemsIn = Array.isArray(itemsRaw) ? itemsRaw : [];
  if (!orderNumber) throw httpErr(400, '발주번호가 없습니다.');

  const orderId = await S.getOrderId('rk_orders', orderNumber);
  if (!orderId) throw httpErr(404, '존재하지 않는 발주서입니다.');

  // 아이템 정리 (boxNo+barcode 합산)
  const merged = new Map();
  for (const it of itemsIn) {
    const boxNo = parseInt(it.boxNo, 10);
    const barcode = String(it.barcode || '').trim();
    const qty = parseInt(it.qty, 10);
    if (!Number.isFinite(boxNo) || boxNo < 1 || !barcode || !Number.isFinite(qty) || qty <= 0) continue;
    const vq = Math.min(qty, Math.max(0, parseInt(it.virtualQty, 10) || 0));
    const k = `${boxNo}|${barcode}`;
    if (!merged.has(k)) merged.set(k, { boxNo, barcode, productName: String(it.productName || '').trim(), qty: 0, virtualQty: 0 });
    merged.get(k).qty += qty;
    merged.get(k).virtualQty += vq;
  }
  const list = [...merged.values()];

  // 초과/미존재 검증 (바코드 단위, SET이므로 전체 = list 합)
  const { order, limit, name } = await orderBarcodeMeta(orderNumber);
  // 처리완료(DONE) 발주서에는 저장하지 않는다
  if (S.isDoneOrder(order)) throw httpErr(400, '처리완료된 발주서에는 저장할 수 없습니다.');
  const byBc = new Map();
  for (const it of list) byBc.set(it.barcode, (byBc.get(it.barcode) || 0) + it.qty);
  for (const [bc, q] of byBc) {
    if (!limit.has(bc)) throw httpErr(400, `발주서에 없는 바코드입니다: ${bc}`);
    if (q > limit.get(bc)) throw httpErr(400, `확정수량(${limit.get(bc)})을 초과했습니다: ${bc}`);
  }

  // 박스 upsert (없으면 생성) — 크기는 boxes 입력 우선
  const sizeByNo = new Map(boxesIn.map(b => [parseInt(b.boxNo, 10), String(b.boxSize || '극소').trim() || '극소']));
  const { data: existBoxes } = await sb.from('rk_ship_boxes').select('id, box_no').eq('order_number', orderNumber);
  const boxIdByNo = new Map((existBoxes || []).map(b => [b.box_no, b.id]));
  const allBoxNos = new Set([...list.map(i => i.boxNo), ...sizeByNo.keys()].filter(n => Number.isFinite(n) && n >= 1));
  for (const no of allBoxNos) {
    const size = sizeByNo.get(no) || '극소';
    if (boxIdByNo.has(no)) {
      // 기존 박스: 크기 변경 반영 (박스 크기 입력이 있을 때만)
      if (sizeByNo.has(no)) {
        const { error } = await sb.from('rk_ship_boxes').update({ box_size: size }).eq('id', boxIdByNo.get(no));
        if (error) throw error;
      }
      continue;
    }
    const { data, error } = await sb.from('rk_ship_boxes')
      .insert({ order_number: orderNumber, box_no: no, box_size: size }).select('id').single();
    if (error) throw error;
    boxIdByNo.set(no, data.id);
  }

  // 아이템 SET: 이 발주서의 기존 박스아이템 전부 삭제 후 현재 상태 삽입
  const allBoxIds = [...boxIdByNo.values()];
  if (allBoxIds.length) {
    const { error } = await sb.from('rk_ship_box_items').delete().in('box_id', allBoxIds);
    if (error) throw error;
  }
  if (list.length) {
    const rows = list.map(it => ({
      box_id: boxIdByNo.get(it.boxNo), order_number: orderNumber, barcode: it.barcode,
      product_name: it.productName || name.get(it.barcode) || null, qty: it.qty, virtual_qty: it.virtualQty,
    }));
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await sb.from('rk_ship_box_items').insert(rows.slice(i, i + BATCH));
      if (error) throw error;
    }
  }

  // 박스 가상 표시 — 가상 수량이 있는 박스 true, 나머지 false (가상 분량을 지우거나 줄이면 자동 해제).
  // 가상이 없어진 박스는 가상확정 기록도 지운다 (확정 상태는 "확정 당시 가상 합 == 현재 가상 합" 로 판단하므로 남겨 둘 이유가 없다)
  const virtualBoxNos = new Set(list.filter(it => it.virtualQty > 0).map(it => it.boxNo));
  const vTrue = [...allBoxNos].filter(no => virtualBoxNos.has(no)).map(no => boxIdByNo.get(no));
  const vFalse = [...allBoxNos].filter(no => !virtualBoxNos.has(no)).map(no => boxIdByNo.get(no));
  if (vTrue.length) { const { error } = await sb.from('rk_ship_boxes').update({ is_virtual: true }).in('id', vTrue); if (error) throw error; }
  if (vFalse.length) { const { error } = await sb.from('rk_ship_boxes').update({ is_virtual: false, virtual_confirmed_qty: 0, virtual_confirmed_at: null }).in('id', vFalse); if (error) throw error; }

  return { ok: true, savedQty: list.reduce((s, i) => s + i.qty, 0), rows: list.length, virtualQty: list.reduce((s, i) => s + i.virtualQty, 0) };
}

router.post('/api/ship-scan/save', async (req, res) => {
  try {
    res.json(await saveShipState(req.body.orderNumber, req.body.boxes, req.body.items));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[rk] ship-scan/save:', e);
    res.status(500).json({ error: '출고스캔 저장 실패: ' + e.message });
  }
});

// ── 일괄 가상스캔 (입고정리 /inboundArrange [가상스캔]) — 발주서 여러 건을 같은 옵션으로 한 번에 (docs/plan-virtual-scan.md §7-13) ──
// body: { orderNumbers:[…], topUp:true|false, target:'all'|'입고'|'재고', inboundCode:'1011', confirm:false|true }
//   · 계산 = 출고스캔 모달과 같은 VirtualPack.planVirtualScan (발주서마다 GET order 와 같은 상태를 읽어 계산)
//   · 반영 = VirtualPack.applyPlan (모달 [확정] 규칙) → saveShipState (확정수량 한도·처리완료 검증 그대로)
//   · confirm=false 는 읽기만(미리보기). confirm=true 는 발주서마다 계획을 **그 시점 DB 로 다시 계산**해서 저장한다 (미리보기 결과를 그대로 쓰지 않는다)
//   · 같은 발주서를 다시 돌리면 남은 목표가 0 → '이미 완료' 로 건너뛴다 (중복 반영 없음)
//   · 입고코드는 화면에서 고른 코드 하나로 고정 (대상 재고면 무관). 다른 코드의 입고분은 '다른 입고코드' 로 제외된다
// 응답: { confirm, options, results:[{ orderNumber, center, arrivalDate, status:'ready'|'saved'|'skip'|'error', reason,
//          qty, skus, L, kg, bySource, existingBoxes, newBoxes, topUpBoxes, upgradedBoxes, assumedCount,
//          boxes:[{boxNo,size,sizeFrom,isNew,addQty,source,warnings}], warnings, excluded:{done,none,other:{사유:종수}}, saved?:{addQty,boxCnt,upCnt,savedQty,virtualQty} }],
//        summary:{ orders, ready, saved, skipped, errors, qty, boxes, newBoxes } }
const VirtualPack = require('../virtualPack');
const VB_TARGETS = new Set(['all', '입고', '재고']);
async function virtualBatchOne(orderNumber, opt, confirm) {
  const st = await loadOrderScanState(orderNumber);
  if (!st.ok) return { orderNumber, status: 'skip', reason: st.error, qty: 0, boxes: [], warnings: [], excluded: { done: 0, none: 0, other: {} } };
  const d = st.payload;
  // 출고스캔 화면이 loadOrder 에서 만드는 products 와 같은 모양: orderQty = 확정수량, scannedQty = 박스에 담긴 합
  const scannedBy = new Map();
  for (const it of d.items) scannedBy.set(it.barcode, (scannedBy.get(it.barcode) || 0) + (parseInt(it.qty, 10) || 0));
  const products = d.products.map((p) => Object.assign({}, p, { orderQty: p.confirmedQty, scannedQty: scannedBy.get(p.barcode) || 0 }));
  const boxSizeMap = new Map(d.boxes.map((b) => [b.boxNo, b.boxSize]));
  const input = { products, boxItems: d.items, savedBoxes: d.boxes, boxSizeMap };
  const plan = VirtualPack.planVirtualScan(input, {
    topUpExisting: !!opt.topUp,
    splitBySource: opt.target === 'all',
    sourceFilter: opt.target === 'all' ? null : opt.target,
    inboundCodes: opt.target === '재고' ? null : [opt.inboundCode],
  });
  const boxes = plan.boxes.filter((b) => b.items.length).map((b) => ({
    boxNo: b.boxNo, size: b.size, sizeFrom: b.sizeFrom || null, isNew: !!b.isNew, addQty: b.addQty, source: b.source || null, warnings: b.warnings }));
  const canApply = plan.ok && boxes.length > 0;
  const t = plan.totals, a = plan.assumptions;
  const other = {};
  for (const e of plan.excluded) if (e.reason !== '이미 완료' && e.reason !== '배정 없음') other[e.reason] = (other[e.reason] || 0) + 1;
  const row = {
    orderNumber: d.orderNumber, center: d.center, arrivalDate: d.arrivalDate,
    status: canApply ? 'ready' : 'skip', reason: canApply ? null : (plan.reason || '담을 상품이 없습니다.'),
    qty: t.qty, skus: t.skus, L: Math.round(t.L * 10) / 10, kg: Math.round(t.kg * 10) / 10, bySource: t.bySource || {},
    existingBoxes: d.boxes.length, newBoxes: t.newBoxes, topUpBoxes: t.topUpBoxes, upgradedBoxes: t.upgradedBoxes || 0, assumedCount: a.assumedCount,
    boxes, warnings: plan.warnings,
    excluded: { done: plan.excluded.filter((e) => e.reason === '이미 완료').length, none: plan.excluded.filter((e) => e.reason === '배정 없음').length, other },
  };
  if (confirm && canApply) {
    const body = VirtualPack.applyPlan(input, plan);
    const r = await saveShipState(d.orderNumber, body.boxes, body.items);
    row.status = 'saved';
    row.saved = { addQty: body.addQty, boxCnt: body.boxCnt, upCnt: body.upCnt, savedQty: r.savedQty, virtualQty: r.virtualQty };
  }
  return row;
}
router.post('/api/ship-scan/virtual-batch', async (req, res) => {
  try {
    const raw = Array.isArray(req.body.orderNumbers) ? req.body.orderNumbers : [];
    const orderNumbers = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
    if (!orderNumbers.length) return res.status(400).json({ error: '발주번호가 없습니다.' });
    if (orderNumbers.length > 300) return res.status(400).json({ error: '한 번에 300건까지 처리할 수 있습니다.' });
    const target = String(req.body.target || '');
    if (!VB_TARGETS.has(target)) return res.status(400).json({ error: '대상(전체/입고/재고)을 선택하세요.' });
    if (typeof req.body.topUp !== 'boolean') return res.status(400).json({ error: '기존 박스(채우기/새 박스만)를 선택하세요.' });
    const inboundCode = String(req.body.inboundCode || '').trim();
    if (target !== '재고' && !inboundCode) return res.status(400).json({ error: '입고코드가 없습니다.' });
    const confirm = req.body.confirm === true;
    const opt = { topUp: req.body.topUp, target, inboundCode: target === '재고' ? null : inboundCode };

    // 발주서마다 조회 6~7회 왕복 → 3개씩 동시에. 한 건이 실패해도 나머지는 계속 (그 행만 error)
    const results = await S.chunkedPool(orderNumbers, 1, async ([no]) => {
      try { return [await virtualBatchOne(no, opt, confirm)]; }
      catch (e) {
        console.error('[rk] ship-scan/virtual-batch', no, e);
        return [{ orderNumber: no, status: 'error', reason: e.message, qty: 0, boxes: [], warnings: [], excluded: { done: 0, none: 0, other: {} } }];
      }
    }, 3);
    const cnt = (s) => results.filter((r) => r.status === s).length;
    const applied = results.filter((r) => r.status === (confirm ? 'saved' : 'ready'));
    const summary = {
      orders: results.length, ready: cnt('ready'), saved: cnt('saved'), skipped: cnt('skip'), errors: cnt('error'),
      qty: applied.reduce((s, r) => s + (r.saved ? r.saved.addQty : r.qty), 0),
      boxes: applied.reduce((s, r) => s + r.boxes.length, 0),
      newBoxes: applied.reduce((s, r) => s + (r.newBoxes || 0), 0),
    };
    res.json({ confirm, options: opt, results, summary });
  } catch (e) {
    console.error('[rk] ship-scan/virtual-batch:', e);
    res.status(500).json({ error: '일괄 가상스캔 실패: ' + e.message });
  }
});

// 박스 전체삭제 — 박스 + 담긴 아이템(cascade) 삭제
router.post('/api/ship-scan/delete-box', async (req, res) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const boxNo = parseInt(req.body.boxNo, 10);
    if (!orderNumber || !Number.isFinite(boxNo)) return res.status(400).json({ error: '파라미터가 올바르지 않습니다.' });
    const { error } = await sb.from('rk_ship_boxes').delete().eq('order_number', orderNumber).eq('box_no', boxNo);
    if (error) throw error; // rk_ship_box_items 는 on delete cascade 로 함께 삭제
    res.json({ ok: true });
  } catch (e) {
    console.error('[rk] ship-scan/delete-box:', e);
    res.status(500).json({ error: '박스 삭제 실패: ' + e.message });
  }
});

// 스캔개수 맵 — rk_ship_box_items 를 발주번호+바코드로 합산(박스가 달라도 합침)
// 응답: { "발주번호|바코드": qty합, ... }  (rocket 스캔수량 표시용)
// 기본은 진행중(DONE 아님) 발주서의 스캔행만 읽는다. 처리완료 발주서의 스캔행이 전체의 90% 를 넘어
// 전부 읽으면 2초 이상 걸리는데, 이 맵을 쓰는 화면(발주서·요약·출고준비·검수)은 모두 진행중만 표시한다.
// 처리완료까지 필요하면 ?all=1
// ── 가상확정 공용 ──
// 박스의 "확정" 상태 = 가상 수량이 있고, 가상확정 당시 가상 합(virtual_confirmed_qty)이 지금 가상 합과 같을 때.
// 확정 뒤 가상스캔으로 더 채우면 합이 달라져 자동으로 미확정으로 돌아간다 (다시 찾아와서 다시 확정).
const boxConfirmed = (box, virtualSum) => virtualSum > 0 && (parseInt(box.virtual_confirmed_qty, 10) || 0) === virtualSum;

// 진행중 발주서의 박스 + 아이템을 한 번에 (박스별 가상 합 + 준비완료 판정 포함)
//   boxOk(box) = 박스 라벨 가상확정 OR 박스 안 가상 상품이 전부 모바일 입고로 찾아짐 (S.virtualReadiness 통합 규칙)
//   keyOk      = "발주번호|바코드" 단위로 가상 합이 모바일 찾음 합으로 다 채워진 상품
//   orderNumbers 를 주면 진행중 여부와 상관없이 그 발주서들만 (입고정리 박스 열 — 쉽먼트 접수로 처리완료된 발주서도 박스를 보여야 한다, 2026-10-15)
async function activeBoxesAndItems(orderNumbers) {
  const active = Array.isArray(orderNumbers) ? [...new Set(orderNumbers.map((x) => String(x || '').trim()).filter(Boolean))] : await S.listActiveOrderNumbers('rk_orders');
  if (!active.length) { const r = S.virtualReadiness([], new Map()); return { boxes: [], items: [], ...r }; }
  const [boxes, items, found] = await Promise.all([
    S.chunked(active, 200, (nos) => S.pageAll(() => sb.from('rk_ship_boxes')
      .select('id, order_number, box_no, box_size, is_virtual, virtual_confirmed_qty, virtual_confirmed_at, created_at').in('order_number', nos).order('id', { ascending: true }))),
    S.chunked(active, 200, (nos) => S.pageAll(() => sb.from('rk_ship_box_items')
      .select('order_number, box_id, barcode, product_name, qty, virtual_qty').in('order_number', nos).order('id', { ascending: true }))),
    S.mobileFoundByKey(active),
  ]);
  return { boxes, items, ...S.virtualReadiness(items, found) };
}

// 박스 맵 — 발주번호+바코드별로 "어느 박스에 몇 개(그중 가상 몇 개, 확정 여부)" (입고정리·재고준비의 박스 열용)
// 응답: { "발주번호|바코드": [ { boxNo, boxSize, qty, virtualQty, confirmed }, … ] }  — 박스번호 순
//   기본은 진행중 발주서만. ?orders=발주번호,발주번호… 를 주면 처리완료(DONE)여도 그 발주서들의 박스를 준다
//   (입고정리: 가상스캔 → 쉽먼트 접수 → 처리완료가 된 발주서의 박스 열이 비던 문제, 2026-10-15)
router.get('/api/ship-scan/box-map', async (req, res) => {
  try {
    const orders = req.query.orders != null ? String(req.query.orders).split(',') : null;
    const { boxes, items, boxOk } = await activeBoxesAndItems(orders);
    const boxById = new Map(boxes.map((b) => [b.id, b]));
    const map = {};
    for (const it of items) {
      const box = boxById.get(it.box_id);
      if (!box || !it.order_number || !it.barcode) continue;
      const qty = parseInt(it.qty, 10) || 0;
      if (qty <= 0) continue;
      const k = `${it.order_number}|${it.barcode}`;
      (map[k] ||= []).push({ boxNo: box.box_no, boxSize: box.box_size, qty, virtualQty: parseInt(it.virtual_qty, 10) || 0,
        confirmed: boxOk(box) });   // 박스 라벨 가상확정 또는 모바일 입고로 다 찾음
    }
    for (const list of Object.values(map)) list.sort((a, b) => a.boxNo - b.boxNo);
    res.json(map);
  } catch (e) {
    console.error('[rk] ship-scan/box-map:', e);
    res.status(500).json({ error: '박스 맵 조회 실패: ' + e.message });
  }
});

// 가상 박스 목록 — 가상확정 페이지의 대기/확정 목록. 진행중 발주서에서 가상 수량이 있는 박스만
// 응답: [{ orderNumber, center, arrivalDate, boxNo, boxSize, qty, virtualQty, itemCount, confirmed, confirmedAt }]
router.get('/api/ship-scan/virtual-boxes', async (req, res) => {
  try {
    const { boxes, items, virtualSumByBox, boxOk } = await activeBoxesAndItems();
    const vBoxes = boxes.filter((b) => (virtualSumByBox.get(b.id) || 0) > 0);
    const orderNos = [...new Set(vBoxes.map((b) => String(b.order_number)))];
    const headers = orderNos.length ? await S.chunked(orderNos, 200, (nos) => S.pageAll(() => sb.from('rk_orders')
      .select('order_number, logistics_center, arrival_date').in('order_number', nos).order('id', { ascending: true }))) : [];
    const hdr = new Map(headers.map((h) => [String(h.order_number), h]));
    const statByBox = new Map();
    for (const it of items) {
      const s = statByBox.get(it.box_id) || { qty: 0, n: 0 };
      s.qty += parseInt(it.qty, 10) || 0; s.n++;
      statByBox.set(it.box_id, s);
    }
    const out = vBoxes.map((b) => {
      const h = hdr.get(String(b.order_number)) || {};
      const s = statByBox.get(b.id) || { qty: 0, n: 0 };
      const vsum = virtualSumByBox.get(b.id) || 0;
      return { orderNumber: String(b.order_number), center: S.str(h.logistics_center), arrivalDate: S.dateToYmd(h.arrival_date),
        boxNo: b.box_no, boxSize: b.box_size, qty: s.qty, virtualQty: vsum, itemCount: s.n,
        confirmed: boxOk(b), confirmedAt: b.virtual_confirmed_at };
    }).sort((a, b) => String(a.arrivalDate).localeCompare(String(b.arrivalDate)) || a.orderNumber.localeCompare(b.orderNumber) || a.boxNo - b.boxNo);
    res.json(out);
  } catch (e) {
    console.error('[rk] ship-scan/virtual-boxes:', e);
    res.status(500).json({ error: '가상 박스 목록 조회 실패: ' + e.message });
  }
});

// 박스 1개 상세 (가상확정 페이지) — ?orderNumber=&boxNo=
router.get('/api/ship-scan/box', async (req, res) => {
  try {
    const orderNumber = String(req.query.orderNumber || '').trim();
    const boxNo = parseInt(req.query.boxNo, 10);
    if (!orderNumber || !Number.isFinite(boxNo)) return res.status(400).json({ error: '발주번호와 박스번호가 필요합니다.' });
    const { data: boxes, error: eB } = await sb.from('rk_ship_boxes').select('*').eq('order_number', orderNumber).eq('box_no', boxNo).limit(1);
    if (eB) throw eB;
    if (!boxes || !boxes.length) return res.status(404).json({ error: `박스를 찾을 수 없습니다: ${orderNumber} - ${boxNo}` });
    const box = boxes[0];
    const [{ data: allItems, error: eI }, { data: hdrs, error: eH }, found] = await Promise.all([
      sb.from('rk_ship_box_items').select('box_id, order_number, barcode, product_name, qty, virtual_qty').eq('order_number', orderNumber).order('id', { ascending: true }),
      sb.from('rk_orders').select('order_number, logistics_center, arrival_date, status').eq('order_number', orderNumber).limit(1),
      S.mobileFoundByKey([orderNumber]),
    ]);
    if (eI) throw eI;
    if (eH) throw eH;
    const h = (hdrs && hdrs[0]) || {};
    const items = (allItems || []).filter((it) => it.box_id === box.id);
    const { keyOk, boxOk } = S.virtualReadiness(allItems || [], found);   // 모바일 입고 찾음까지 합친 준비완료 판정
    const vsum = items.reduce((s, it) => s + (parseInt(it.virtual_qty, 10) || 0), 0);
    res.json({
      orderNumber, boxNo: box.box_no, boxSize: box.box_size, center: S.str(h.logistics_center), arrivalDate: S.dateToYmd(h.arrival_date),
      done: S.isDoneOrder({ 상태: h.status }),
      qty: items.reduce((s, it) => s + (parseInt(it.qty, 10) || 0), 0), virtualQty: vsum,
      confirmed: boxOk(box), labelConfirmed: boxConfirmed(box, vsum),   // confirmed = 통합(라벨 확정 또는 모바일 다 찾음) · labelConfirmed = 박스 라벨 확정만
      confirmedAt: box.virtual_confirmed_at, confirmedQty: parseInt(box.virtual_confirmed_qty, 10) || 0,
      items: items.map((it) => ({ barcode: it.barcode, productName: it.product_name, qty: it.qty, virtualQty: parseInt(it.virtual_qty, 10) || 0,
        mobileFound: keyOk.has(`${orderNumber}|${it.barcode}`) })),
    });
  } catch (e) {
    console.error('[rk] ship-scan/box:', e);
    res.status(500).json({ error: '박스 조회 실패: ' + e.message });
  }
});

// 가상확정 / 취소 — body: { orderNumber, boxNo, undo? }
//   확정: virtual_confirmed_qty = 지금 가상 합, virtual_confirmed_at = now. 가상이 없는 박스는 확정할 것이 없다.
//   취소: 0 / null
router.post('/api/ship-scan/virtual-confirm', async (req, res) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const boxNo = parseInt(req.body.boxNo, 10);
    const undo = req.body.undo === true;
    if (!orderNumber || !Number.isFinite(boxNo)) return res.status(400).json({ error: '발주번호와 박스번호가 필요합니다.' });
    const { data: boxes, error: eB } = await sb.from('rk_ship_boxes').select('id, virtual_confirmed_qty').eq('order_number', orderNumber).eq('box_no', boxNo).limit(1);
    if (eB) throw eB;
    if (!boxes || !boxes.length) return res.status(404).json({ error: `박스를 찾을 수 없습니다: ${orderNumber} - ${boxNo}` });
    const box = boxes[0];
    const { data: items, error: eI } = await sb.from('rk_ship_box_items').select('virtual_qty').eq('box_id', box.id);
    if (eI) throw eI;
    const vsum = (items || []).reduce((s, it) => s + (parseInt(it.virtual_qty, 10) || 0), 0);
    if (!undo && vsum <= 0) return res.status(400).json({ error: '이 박스에는 가상스캔 수량이 없습니다.' });
    const patch = undo ? { virtual_confirmed_qty: 0, virtual_confirmed_at: null } : { virtual_confirmed_qty: vsum, virtual_confirmed_at: new Date().toISOString() };
    const { error: eU } = await sb.from('rk_ship_boxes').update(patch).eq('id', box.id);
    if (eU) throw eU;
    res.json({ ok: true, orderNumber, boxNo, virtualQty: vsum, confirmed: !undo, confirmedAt: patch.virtual_confirmed_at });
  } catch (e) {
    console.error('[rk] ship-scan/virtual-confirm:', e);
    res.status(500).json({ error: '가상확정 실패: ' + e.message });
  }
});

//   ?virtual=1 이면 { map, virtual, confirmed } — virtual 은 같은 키로 가상스캔 수량 합(virtual_qty>0 인 것만),
//   confirmed 는 그중 가상확정된 박스에 든 가상 수량 합. 발주서 관리의 '가상' 배지용.
//   (기본 응답 형식은 그대로 — 요약·출고준비 등 다른 화면이 같은 맵을 쓴다)
router.get('/api/ship-scan/scanned-map', async (req, res) => {
  try {
    const withVirtual = String(req.query.virtual || '') === '1';
    const map = {};
    const virtual = {};
    const confirmed = {};
    if (withVirtual) {
      // 박스 확정 여부가 필요하므로 박스까지 같이 읽는다 (진행중 발주서 기준)
      const { boxes, items, keyOk, boxOk } = await activeBoxesAndItems();
      const confirmedBox = new Set(boxes.filter((b) => boxOk(b)).map((b) => b.id));
      for (const r of items) {
        if (!r.order_number || !r.barcode) continue;
        const k = `${r.order_number}|${r.barcode}`;
        map[k] = (map[k] || 0) + (parseInt(r.qty, 10) || 0);
        const vq = parseInt(r.virtual_qty, 10) || 0;
        if (vq > 0) {
          virtual[k] = (virtual[k] || 0) + vq;
          // 박스가 확정됐거나(라벨 확정 / 박스 전부 찾음) 그 상품의 가상 합이 모바일 입고로 다 채워졌으면 확정 분량
          if (confirmedBox.has(r.box_id) || keyOk.has(k)) confirmed[k] = (confirmed[k] || 0) + vq;
        }
      }
      return res.json({ map, virtual, confirmed });
    }
    const add = (rows) => {
      for (const r of rows) {
        if (!r.order_number || !r.barcode) continue;
        const k = `${r.order_number}|${r.barcode}`;
        map[k] = (map[k] || 0) + (parseInt(r.qty, 10) || 0);
      }
    };
    const baseQuery = () => sb.from('rk_ship_box_items').select('order_number, barcode, qty');
    if (String(req.query.all || '') === '1') {
      add(await S.pageAll(() => baseQuery().order('id', { ascending: true })));
    } else {
      const active = await S.listActiveOrderNumbers('rk_orders');
      if (active.length) {
        add(await S.chunked(active, 200, (nos) =>
          S.pageAll(() => baseQuery().in('order_number', nos).order('id', { ascending: true }))));
      }
    }
    res.json(map);
  } catch (e) {
    console.error('[rk] ship-scan/scanned-map:', e);
    res.status(500).json({ error: '스캔개수 조회 실패: ' + e.message });
  }
});

module.exports = router;
