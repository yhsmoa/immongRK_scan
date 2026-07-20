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

    const { order, limit, name } = await orderBarcodeMeta(orderNumber);
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
      center: (order && order.물류센터) || '',
      products,
      boxes: (boxes || []).map(b => ({ id: b.id, boxNo: b.box_no, boxSize: b.box_size, createdAt: b.created_at })),
      items: items.map(i => ({ boxId: i.box_id, boxNo: boxNoById.get(i.box_id), barcode: i.barcode, productName: i.product_name, qty: i.qty })),
    });
  } catch (e) {
    console.error('[rk] ship-scan/order:', e);
    res.status(500).json({ error: '발주서 조회 실패: ' + e.message });
  }
});

// 저장 — 현재 작업 상태(박스아이템 전체)를 그대로 반영(SET). 스캔·개수편집·삭제 모두 지원.
// body: { orderNumber, boxes:[{boxNo,boxSize}], items:[{boxNo,barcode,productName,qty}] }
router.post('/api/ship-scan/save', async (req, res) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const boxesIn = Array.isArray(req.body.boxes) ? req.body.boxes : [];
    const itemsIn = Array.isArray(req.body.items) ? req.body.items : [];
    if (!orderNumber) return res.status(400).json({ error: '발주번호가 없습니다.' });

    const orderId = await S.getOrderId('rk_orders', orderNumber);
    if (!orderId) return res.status(404).json({ error: '존재하지 않는 발주서입니다.' });

    // 아이템 정리 (boxNo+barcode 합산)
    const merged = new Map();
    for (const it of itemsIn) {
      const boxNo = parseInt(it.boxNo, 10);
      const barcode = String(it.barcode || '').trim();
      const qty = parseInt(it.qty, 10);
      if (!Number.isFinite(boxNo) || boxNo < 1 || !barcode || !Number.isFinite(qty) || qty <= 0) continue;
      const k = `${boxNo}|${barcode}`;
      if (!merged.has(k)) merged.set(k, { boxNo, barcode, productName: String(it.productName || '').trim(), qty: 0 });
      merged.get(k).qty += qty;
    }
    const list = [...merged.values()];

    // 초과/미존재 검증 (바코드 단위, SET이므로 전체 = list 합)
    const { limit, name } = await orderBarcodeMeta(orderNumber);
    const byBc = new Map();
    for (const it of list) byBc.set(it.barcode, (byBc.get(it.barcode) || 0) + it.qty);
    for (const [bc, q] of byBc) {
      if (!limit.has(bc)) return res.status(400).json({ error: `발주서에 없는 바코드입니다: ${bc}` });
      if (q > limit.get(bc)) return res.status(400).json({ error: `확정수량(${limit.get(bc)})을 초과했습니다: ${bc}` });
    }

    // 박스 upsert (없으면 생성) — 크기는 boxes 입력 우선
    const sizeByNo = new Map(boxesIn.map(b => [parseInt(b.boxNo, 10), String(b.boxSize || '극소').trim() || '극소']));
    const { data: existBoxes } = await sb.from('rk_ship_boxes').select('id, box_no').eq('order_number', orderNumber);
    const boxIdByNo = new Map((existBoxes || []).map(b => [b.box_no, b.id]));
    const allBoxNos = new Set([...list.map(i => i.boxNo), ...sizeByNo.keys()].filter(n => Number.isFinite(n) && n >= 1));
    for (const no of allBoxNos) {
      if (boxIdByNo.has(no)) continue;
      const { data, error } = await sb.from('rk_ship_boxes')
        .insert({ order_number: orderNumber, box_no: no, box_size: sizeByNo.get(no) || '극소' }).select('id').single();
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
        product_name: it.productName || name.get(it.barcode) || null, qty: it.qty,
      }));
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await sb.from('rk_ship_box_items').insert(rows.slice(i, i + BATCH));
        if (error) throw error;
      }
    }

    res.json({ ok: true, savedQty: list.reduce((s, i) => s + i.qty, 0), rows: list.length });
  } catch (e) {
    console.error('[rk] ship-scan/save:', e);
    res.status(500).json({ error: '출고스캔 저장 실패: ' + e.message });
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
router.get('/api/ship-scan/scanned-map', async (req, res) => {
  try {
    const map = {};
    let from = 0;
    const size = 1000;
    while (true) {
      const { data, error } = await sb.from('rk_ship_box_items')
        .select('order_number, barcode, qty')
        .order('id', { ascending: true })
        .range(from, from + size - 1);
      if (error) throw error;
      for (const r of data) {
        if (!r.order_number || !r.barcode) continue;
        const k = `${r.order_number}|${r.barcode}`;
        map[k] = (map[k] || 0) + (parseInt(r.qty, 10) || 0);
      }
      if (data.length < size) break;
      from += size;
    }
    res.json(map);
  } catch (e) {
    console.error('[rk] ship-scan/scanned-map:', e);
    res.status(500).json({ error: '스캔개수 조회 실패: ' + e.message });
  }
});

module.exports = router;
