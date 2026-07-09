/**
 * rk_* (Supabase) 공유 헬퍼 — 전체 전환용
 * SQL(정규화) ↔ 기존 프론트가 기대하는 한글 Mongo 형태 상호 변환.
 * 응답 계약을 100% 유지하기 위해, 조회는 "모든 상품(박스행 포함)"을 담은 한글 order 를 돌려주고
 * referer 분기/dedup 은 각 라우터가 기존 server.js 로직 그대로 적용한다.
 */
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── SQL → 화면 값 복원 ──
function dateToYmd(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}
function tsToKst(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}
const dash = (v) => (v === null || v === undefined || v === '' ? '-' : v);
const str = (v) => (v === null || v === undefined ? '' : v);

// ── 화면 값 → SQL (쓰기용) ──
function ymdToDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function kstToTs(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00` : null;
}
const emptyToNull = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
};
const placeholderToNull = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t === '' || t === '-' || t === '.' ? null : t;
};
const toInt = (n) => {
  if (n === undefined || n === null || n === '') return null;
  const v = parseInt(n, 10);
  return Number.isNaN(v) ? null : v;
};
const toNum = (n) => {
  if (n === undefined || n === null || n === '') return null;
  const v = Number(n);
  return Number.isNaN(v) ? null : v;
};

// ── 한 상품행(SQL) → 한글 객체 (박스행이면 박스정보 포함) ──
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
function headerToKorean(h, items) {
  return {
    _id: h.mongo_id,
    발주번호: str(h.order_number),
    입고예정일: dateToYmd(h.arrival_date),
    물류센터: str(h.logistics_center),
    상품수: h.product_count,
    발주수량: h.order_qty,
    확정수량: h.confirmed_qty,
    스캔수량: h.scanned_qty,
    created_at: h.created_at,
    상품정보: items,
  };
}

// ── 1000행 제한 우회: order_id 목록으로 items 전체 조회 (id 순) ──
async function fetchAllItems(itemTable, orderIds) {
  if (!orderIds.length) return [];
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(itemTable).select('*').in('order_id', orderIds)
      .order('order_id', { ascending: true }).order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// ── 전체 발주서 목록 (한글, 모든 상품 포함, 정렬 입고예정일>물류센터>발주번호) ──
async function listOrdersFull(headerTable, itemTable) {
  const { data: headers, error } = await supabase
    .from(headerTable).select('*')
    .order('arrival_date', { ascending: true })
    .order('logistics_center', { ascending: true })
    .order('order_number', { ascending: true });
  if (error) throw error;
  const ids = headers.map((h) => h.id);
  const items = await fetchAllItems(itemTable, ids);
  const grouped = new Map();
  for (const it of items) {
    if (!grouped.has(it.order_id)) grouped.set(it.order_id, []);
    grouped.get(it.order_id).push(it);
  }
  return headers.map((h) => headerToKorean(h, (grouped.get(h.id) || []).map(itemToKorean)));
}

// ── 단일 발주서 (한글, 모든 상품 포함) / 없으면 null ──
async function getOrderFull(headerTable, itemTable, orderNumber) {
  const { data: headers, error } = await supabase
    .from(headerTable).select('*').eq('order_number', orderNumber).limit(1);
  if (error) throw error;
  if (!headers || !headers.length) return null;
  const h = headers[0];
  const items = await fetchAllItems(itemTable, [h.id]);
  return headerToKorean(h, items.map(itemToKorean));
}

// ── 헤더 id 조회 ──
async function getOrderId(headerTable, orderNumber) {
  const { data, error } = await supabase.from(headerTable).select('id').eq('order_number', orderNumber).limit(1);
  if (error) throw error;
  return data && data.length ? data[0].id : null;
}

// ── 발주서 헤더 집계값 재계산 (상품수/발주수량/확정수량, 원본 상품 기준) ──
async function recalcHeaderAggregates(headerTable, itemTable, orderId) {
  const items = await fetchAllItems(itemTable, [orderId]);
  const originals = items.filter((i) => !i.box_info);
  const 상품수 = originals.length;
  const 발주수량 = originals.reduce((s, i) => s + (Number(i.order_qty) || 0), 0);
  const 확정수량 = originals.reduce((s, i) => s + (Number(i.confirmed_qty) || 0), 0);
  await supabase.from(headerTable).update({ product_count: 상품수, order_qty: 발주수량, confirmed_qty: 확정수량 }).eq('id', orderId);
}

// ── 한글 상품 배열 → SQL item row (upload/register 용) ──
function koreanItemToRow(orderId, p) {
  return {
    order_id: orderId,
    product_number: emptyToNull(p['상품번호']),
    barcode: emptyToNull(p['상품바코드']),
    product_name: emptyToNull(p['상품이름']),
    order_qty: toInt(p['발주수량']),
    confirmed_qty: toInt(p['확정수량']),
    scanned_qty: toInt(p['스캔수량']) ?? 0,
    receiving_type: emptyToNull(p['입고유형']),
    order_status: emptyToNull(p['발주상태']),
    expiry_date: emptyToNull(p['유통(소비)기한']),
    manufacture_date: emptyToNull(p['제조일자']),
    production_year: emptyToNull(p['생산년도']),
    shortage_reason: emptyToNull(p['납품부족사유']),
    return_manager: emptyToNull(p['회송담당자']),
    return_manager_phone: emptyToNull(p['회송담당자 연락처']),
    return_address: emptyToNull(p['회송지주소']),
    purchase_price: toNum(p['매입가']),
    supply_price: toNum(p['공급가']),
    vat: toNum(p['부가세']),
    total_purchase_amount: toNum(p['총발주 매입금']),
    registered_at: kstToTs(p['발주등록일시']),
    box_info: emptyToNull(p['박스정보']),
    receiving_1: placeholderToNull(p['입고1']),
    receiving_2: placeholderToNull(p['입고2']),
    location: placeholderToNull(p['위치']),
  };
}
function koreanHeaderToRow(o, mongoIdPrefix) {
  return {
    mongo_id: `${mongoIdPrefix}_${o['발주번호']}_${Date.now()}`,
    order_number: emptyToNull(o['발주번호']) ?? '',
    arrival_date: ymdToDate(o['입고예정일']),
    logistics_center: emptyToNull(o['물류센터']),
    product_count: toInt(o['상품수']),
    order_qty: toInt(o['발주수량']),
    confirmed_qty: toInt(o['확정수량']),
    scanned_qty: toInt(o['스캔수량']) ?? 0,
  };
}

// ── 한글 발주서 배열 → Supabase insert (중복 order_number skip) ──
async function insertKoreanOrders(headerTable, itemTable, koreanOrders, prefix) {
  const added = [];
  const duplicates = [];
  for (const o of koreanOrders) {
    const exists = await getOrderId(headerTable, o['발주번호']);
    if (exists) { duplicates.push(o['발주번호']); continue; }
    const { data: hdr, error: hErr } = await supabase.from(headerTable).insert(koreanHeaderToRow(o, prefix)).select('id').single();
    if (hErr) throw hErr;
    const items = (o['상품정보'] || []).map((p) => koreanItemToRow(hdr.id, p));
    if (items.length) {
      const { error: iErr } = await supabase.from(itemTable).insert(items);
      if (iErr) throw iErr;
    }
    added.push(o['발주번호']);
  }
  return { added, duplicates };
}

module.exports = {
  supabase,
  insertKoreanOrders,
  dateToYmd, tsToKst, dash, str, ymdToDate, kstToTs,
  emptyToNull, placeholderToNull, toInt, toNum,
  itemToKorean, headerToKorean, fetchAllItems,
  listOrdersFull, getOrderFull, getOrderId, recalcHeaderAggregates,
  koreanItemToRow, koreanHeaderToRow,
};
