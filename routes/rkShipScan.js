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

// 발주서의 바코드별 한도(확정수량 합) + 상품명 맵
async function orderBarcodeMeta(orderNumber) {
  const order = await S.getOrderFull('rk_orders', 'rk_order_items', orderNumber);
  const limit = new Map();  // barcode -> 확정수량 합
  const name = new Map();    // barcode -> 상품명
  if (order && Array.isArray(order.상품정보)) {
    for (const p of order.상품정보) {
      if (p.박스정보) continue;               // 원본(박스 아님) 행만
      const bc = p.상품바코드;
      if (!bc) continue;
      limit.set(bc, (limit.get(bc) || 0) + (parseInt(p.확정수량) || 0));
      if (!name.has(bc) && p.상품이름) name.set(bc, p.상품이름);
    }
  }
  return { order, limit, name };
}

// 발주서 조회 (유효성 + 상품/박스/출고리스트)
router.get('/api/ship-scan/order/:orderNumber', async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim();
    if (!orderNumber) return res.status(400).json({ error: '발주번호가 필요합니다.' });

    const orderId = await S.getOrderId('rk_orders', orderNumber);
    if (!orderId) return res.status(404).json({ valid: false, error: '존재하지 않는 발주서입니다.' });

    const { limit, name } = await orderBarcodeMeta(orderNumber);
    const products = [...limit.keys()].map(bc => ({ barcode: bc, productName: name.get(bc) || '', confirmedQty: limit.get(bc) || 0 }));

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

    res.json({
      valid: true,
      orderNumber,
      products,
      boxes: (boxes || []).map(b => ({ id: b.id, boxNo: b.box_no, boxSize: b.box_size, createdAt: b.created_at })),
      items: items.map(i => ({ boxId: i.box_id, boxNo: boxNoById.get(i.box_id), barcode: i.barcode, productName: i.product_name, qty: i.qty })),
    });
  } catch (e) {
    console.error('[rk] ship-scan/order:', e);
    res.status(500).json({ error: '발주서 조회 실패: ' + e.message });
  }
});

// 저장 — 기록(합산분) → 박스 upsert + (box, barcode) 합산 upsert. 초과 차단 재검증.
router.post('/api/ship-scan/save', async (req, res) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!orderNumber) return res.status(400).json({ error: '발주번호가 없습니다.' });

    const orderId = await S.getOrderId('rk_orders', orderNumber);
    if (!orderId) return res.status(404).json({ error: '존재하지 않는 발주서입니다.' });

    // 정리: boxNo+barcode 로 합산
    const merged = new Map(); // `${boxNo}|${barcode}` -> {boxNo, boxSize, barcode, productName, qty}
    for (const it of rawItems) {
      const boxNo = parseInt(it.boxNo, 10);
      const barcode = String(it.barcode || '').trim();
      const qty = parseInt(it.qty, 10);
      if (!Number.isFinite(boxNo) || boxNo < 1 || !barcode || !Number.isFinite(qty) || qty <= 0) continue;
      const k = `${boxNo}|${barcode}`;
      if (!merged.has(k)) merged.set(k, { boxNo, boxSize: String(it.boxSize || '극소').trim() || '극소', barcode, productName: String(it.productName || '').trim(), qty: 0 });
      merged.get(k).qty += qty;
    }
    const list = [...merged.values()];
    if (!list.length) return res.status(400).json({ error: '저장할 스캔 기록이 없습니다.' });

    // 한도/기존 저장분 로드 → 초과 검증 (바코드 단위, 발주서 전체)
    const { limit, name } = await orderBarcodeMeta(orderNumber);
    const { data: existBoxes } = await sb.from('rk_ship_boxes').select('id, box_no, box_size').eq('order_number', orderNumber);
    const boxByNo = new Map((existBoxes || []).map(b => [b.box_no, b]));
    const savedByBarcode = new Map();
    if (existBoxes && existBoxes.length) {
      const { data: savedItems } = await sb.from('rk_ship_box_items').select('barcode, qty').in('box_id', existBoxes.map(b => b.id));
      for (const s of (savedItems || [])) savedByBarcode.set(s.barcode, (savedByBarcode.get(s.barcode) || 0) + (s.qty || 0));
    }
    const incomingByBarcode = new Map();
    for (const it of list) incomingByBarcode.set(it.barcode, (incomingByBarcode.get(it.barcode) || 0) + it.qty);
    for (const [bc, inc] of incomingByBarcode) {
      if (!limit.has(bc)) return res.status(400).json({ error: `발주서에 없는 바코드입니다: ${bc}` });
      const total = (savedByBarcode.get(bc) || 0) + inc;
      if (total > limit.get(bc)) return res.status(400).json({ error: `확정수량(${limit.get(bc)})을 초과했습니다: ${bc}` });
    }

    // 박스 upsert (없으면 생성) → box_id 확보
    const boxIdByNo = new Map();
    for (const [no, b] of boxByNo) boxIdByNo.set(no, b.id);
    for (const it of list) {
      if (boxIdByNo.has(it.boxNo)) continue;
      const { data, error } = await sb.from('rk_ship_boxes')
        .insert({ order_number: orderNumber, box_no: it.boxNo, box_size: it.boxSize }).select('id').single();
      if (error) throw error;
      boxIdByNo.set(it.boxNo, data.id);
    }

    // 아이템 (box_id, barcode) 합산 upsert
    let saved = 0;
    for (const it of list) {
      const boxId = boxIdByNo.get(it.boxNo);
      const pname = it.productName || name.get(it.barcode) || null;
      const { data: ex } = await sb.from('rk_ship_box_items').select('id, qty').eq('box_id', boxId).eq('barcode', it.barcode).limit(1);
      if (ex && ex.length) {
        const { error } = await sb.from('rk_ship_box_items').update({ qty: (ex[0].qty || 0) + it.qty, product_name: pname, updated_at: new Date().toISOString() }).eq('id', ex[0].id);
        if (error) throw error;
      } else {
        const { error } = await sb.from('rk_ship_box_items').insert({ box_id: boxId, order_number: orderNumber, barcode: it.barcode, product_name: pname, qty: it.qty });
        if (error) throw error;
      }
      saved += it.qty;
    }

    res.json({ ok: true, savedQty: saved, rows: list.length });
  } catch (e) {
    console.error('[rk] ship-scan/save:', e);
    res.status(500).json({ error: '출고스캔 저장 실패: ' + e.message });
  }
});

module.exports = router;
