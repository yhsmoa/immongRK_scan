/**
 * 발주서 V2 라우터 — Supabase(SQL) 조회 전용
 *
 * - 기존 MongoDB API(/api/orders 등)는 그대로 두고, /api/v2/* 네임스페이스만 추가
 * - Supabase의 정규화 테이블(rk_orders/rk_order_items 등)을 읽어
 *   기존 프론트가 기대하는 "한글 필드 + 상품정보 배열" Mongo 형태로 재구성해 반환
 * - 1차 목표: 조회 전용 (쓰기 없음)
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==================== 값 복원 헬퍼 (SQL → 기존 화면 형태) ====================

// "2026-07-16" → "20260716" (화면 정렬이 YYYYMMDD 문자열에 의존)
function dateToYmd(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

// timestamptz → KST "YYYY-MM-DD HH:mm:ss"
function tsToKst(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}

// null → '-' (입고1/입고2/위치 는 원본이 '-' 기본값)
function dash(v) {
  return v === null || v === undefined || v === '' ? '-' : v;
}
// null → ''
function str(v) {
  return v === null || v === undefined ? '' : v;
}

function itemToKorean(it) {
  const obj = {
    상품번호: str(it.product_number),
    상품바코드: str(it.barcode),
    상품이름: str(it.product_name),
    발주수량: it.order_qty,
    확정수량: it.confirmed_qty,
    스캔수량: it.scanned_qty,
    입고유형: str(it.receiving_type),
    발주상태: str(it.order_status),
    '유통(소비)기한': str(it.expiry_date),
    제조일자: str(it.manufacture_date),
    생산년도: str(it.production_year),
    납품부족사유: str(it.shortage_reason),
    회송담당자: str(it.return_manager),
    '회송담당자 연락처': str(it.return_manager_phone),
    회송지주소: str(it.return_address),
    매입가: it.purchase_price,
    공급가: it.supply_price,
    부가세: it.vat,
    '총발주 매입금': it.total_purchase_amount,
    발주등록일시: tsToKst(it.registered_at),
    입고1: dash(it.receiving_1),
    입고2: dash(it.receiving_2),
    위치: dash(it.location),
  };
  if (it.box_info) obj.박스정보 = it.box_info;
  return obj;
}

function headerToKorean(h, itemsKorean) {
  return {
    _id: h.mongo_id,
    발주번호: str(h.order_number),
    입고예정일: dateToYmd(h.arrival_date),
    물류센터: str(h.logistics_center),
    상품수: h.product_count,
    발주수량: h.order_qty,
    확정수량: h.confirmed_qty,
    스캔수량: h.scanned_qty,
    상품정보: itemsKorean,
  };
}

// rocket 페이지용 중복제거: 원본(박스정보 없음) 우선, 바코드별 1행
function dedupRocket(items) {
  const unique = [];
  const seen = new Set();
  items.filter((p) => !p.box_info).forEach((p) => {
    unique.push(itemToKorean(p));
    seen.add(p.barcode);
  });
  items.forEach((p) => {
    if (!seen.has(p.barcode)) {
      const k = itemToKorean(p);
      delete k.박스정보;
      unique.push(k);
      seen.add(p.barcode);
    }
  });
  return unique;
}

// 1000행 제한 우회: order_id로 페이지네이션하며 전체 items 조회
async function fetchAllItems(itemTable, orderIds) {
  if (orderIds.length === 0) return [];
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(itemTable)
      .select('*')
      .in('order_id', orderIds)
      .order('order_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

function groupItems(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.order_id)) map.set(it.order_id, []);
    map.get(it.order_id).push(it);
  }
  return map;
}

// ==================== 조회 로직 (공통) ====================

async function listOrders(headerTable, itemTable, { dedup }) {
  const { data: headers, error } = await supabase
    .from(headerTable)
    .select('*')
    .order('arrival_date', { ascending: true })
    .order('logistics_center', { ascending: true })
    .order('order_number', { ascending: true });
  if (error) throw error;

  const ids = headers.map((h) => h.id);
  const items = await fetchAllItems(itemTable, ids);
  const grouped = groupItems(items);

  return headers.map((h) => {
    const its = grouped.get(h.id) || [];
    const itemsKorean = dedup ? dedupRocket(its) : its.map(itemToKorean);
    return headerToKorean(h, itemsKorean);
  });
}

async function getOrder(headerTable, itemTable, orderNumber, { dedup }) {
  const { data: headers, error } = await supabase
    .from(headerTable)
    .select('*')
    .eq('order_number', orderNumber)
    .limit(1);
  if (error) throw error;
  if (!headers || headers.length === 0) return null;

  const h = headers[0];
  const items = await fetchAllItems(itemTable, [h.id]);
  const itemsKorean = dedup ? dedupRocket(items) : items.map(itemToKorean);
  return headerToKorean(h, itemsKorean);
}

// ==================== 엔드포인트 ====================

// 전체 발주서 목록
router.get('/api/v2/orders', async (req, res) => {
  try {
    res.json(await listOrders('rk_orders', 'rk_order_items', { dedup: true }));
  } catch (e) {
    console.error('[v2] 발주서 목록 조회 오류:', e);
    res.status(500).json({ error: '발주서 목록을 불러오는데 실패했습니다.' });
  }
});

// 전체 발주서 상세
router.get('/api/v2/orders/:orderNumber', async (req, res) => {
  try {
    const order = await getOrder('rk_orders', 'rk_order_items', req.params.orderNumber, { dedup: true });
    if (!order) return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
    res.json(order);
  } catch (e) {
    console.error('[v2] 발주서 상세 조회 오류:', e);
    res.status(500).json({ error: '발주서를 불러오는데 실패했습니다.' });
  }
});

// 신규 발주서 목록
router.get('/api/v2/neworders', async (req, res) => {
  try {
    res.json(await listOrders('rk_new_orders', 'rk_new_order_items', { dedup: false }));
  } catch (e) {
    console.error('[v2] 신규 발주서 목록 조회 오류:', e);
    res.status(500).json({ error: '신규 발주서 목록을 불러오는데 실패했습니다.' });
  }
});

// 신규 발주서 상세
router.get('/api/v2/neworders/:orderNumber', async (req, res) => {
  try {
    const order = await getOrder('rk_new_orders', 'rk_new_order_items', req.params.orderNumber, { dedup: false });
    if (!order) return res.status(404).json({ error: '신규 발주서를 찾을 수 없습니다.' });
    res.json(order);
  } catch (e) {
    console.error('[v2] 신규 발주서 상세 조회 오류:', e);
    res.status(500).json({ error: '신규 발주서를 불러오는데 실패했습니다.' });
  }
});

module.exports = router;
