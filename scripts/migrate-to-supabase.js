/**
 * MongoDB → Supabase(SQL) 데이터 복사 스크립트 (발주서 V2)
 *
 * - Mongo는 읽기(find)만 수행 → 기존 데이터 절대 변경 없음
 * - 대상: orders → rk_orders / rk_order_items
 *         newOrders → rk_new_orders / rk_new_order_items
 * - mongo_id 기준 upsert + items 재삽입 → 재실행해도 중복 안 생김
 *
 * 실행: node scripts/migrate-to-supabase.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

const MONGODB_URI = process.env.MONGODB_URI;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==================== 정제 헬퍼 (MIGRATION_V2_GUIDE.md 2-4) ====================

// "20260716" → "2026-07-16" / 형식 불일치 시 null
function parseArrivalDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// "2026-07-02 12:22:37" → KST 기준 timestamptz / 형식 불일치 시 null
function parseRegisteredAt(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00` : null;
}

// 빈 문자열 → null
function emptyToNull(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

// placeholder('-', '.') 및 빈 값 → null
function placeholderToNull(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return (t === '' || t === '-' || t === '.') ? null : t;
}

function toInt(n) {
  if (n === undefined || n === null || n === '') return null;
  const v = parseInt(n, 10);
  return Number.isNaN(v) ? null : v;
}

function toNum(n) {
  if (n === undefined || n === null || n === '') return null;
  const v = Number(n);
  return Number.isNaN(v) ? null : v;
}

// ==================== 변환 ====================

function toHeaderRow(doc) {
  return {
    mongo_id: String(doc._id),
    order_number: emptyToNull(doc['발주번호']) ?? '',
    arrival_date: parseArrivalDate(doc['입고예정일']),
    logistics_center: emptyToNull(doc['물류센터']),
    product_count: toInt(doc['상품수']),
    order_qty: toInt(doc['발주수량']),
    confirmed_qty: toInt(doc['확정수량']),
    scanned_qty: toInt(doc['스캔수량']) ?? 0,
  };
}

function toItemRow(orderId, p) {
  return {
    order_id: orderId,
    mongo_id: p._id ? String(p._id) : null,
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
    registered_at: parseRegisteredAt(p['발주등록일시']),
    box_info: emptyToNull(p['박스정보']),
    receiving_1: placeholderToNull(p['입고1']),
    receiving_2: placeholderToNull(p['입고2']),
    location: placeholderToNull(p['위치']),
  };
}

// ==================== 마이그레이션 실행 ====================

const CLEAN = process.env.CLEAN === '1'; // truncate 후 삽입 (정확한 최종 동기화용)

async function truncate(table) {
  const { error } = await supabase.from(table).delete().gt('id', 0);
  if (error) throw error;
  console.log(`  🧹 ${table} 비움`);
}

async function migrateCollection(collectionName, headerTable, itemTable) {
  console.log(`\n=== ${collectionName} → ${headerTable} / ${itemTable} ===`);
  if (CLEAN) await truncate(headerTable); // items 는 FK cascade 로 함께 삭제
  const db = mongoose.connection.db;
  const docs = await db.collection(collectionName).find({}).toArray(); // 읽기 전용
  console.log(`  Mongo 문서: ${docs.length}건`);

  let headerCount = 0;
  let itemCount = 0;

  for (const doc of docs) {
    // 1) 헤더 upsert (mongo_id 기준) → id 회수
    const { data: header, error: hErr } = await supabase
      .from(headerTable)
      .upsert(toHeaderRow(doc), { onConflict: 'mongo_id' })
      .select('id')
      .single();
    if (hErr) {
      console.error(`  ❌ 헤더 upsert 실패 (발주번호 ${doc['발주번호']}):`, hErr.message);
      continue;
    }
    headerCount++;
    const orderId = header.id;

    // 2) 기존 items 삭제 후 재삽입 (재실행 멱등성)
    const { error: dErr } = await supabase.from(itemTable).delete().eq('order_id', orderId);
    if (dErr) {
      console.error(`  ❌ items 삭제 실패 (order_id ${orderId}):`, dErr.message);
      continue;
    }

    const items = Array.isArray(doc['상품정보']) ? doc['상품정보'] : [];
    if (items.length > 0) {
      const rows = items.map((p) => toItemRow(orderId, p));
      const { error: iErr } = await supabase.from(itemTable).insert(rows);
      if (iErr) {
        console.error(`  ❌ items 삽입 실패 (order_id ${orderId}):`, iErr.message);
        continue;
      }
      itemCount += rows.length;
    }
  }

  console.log(`  ✅ 헤더 ${headerCount}건 / 상품 ${itemCount}건 복사 완료`);
  return { headerCount, itemCount };
}

// 날짜/타임스탬프 → ISO (형식 불명 시 null)
function toISO(d) {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

// ==================== 플랫(자식 없는) 컬렉션 배치 마이그레이션 ====================
async function migrateFlat(collectionName, table, mapFn) {
  console.log(`\n=== ${collectionName} → ${table} ===`);
  if (CLEAN) await truncate(table);
  const db = mongoose.connection.db;
  const docs = await db.collection(collectionName).find({}).toArray(); // 읽기 전용
  console.log(`  Mongo 문서: ${docs.length}건`);

  const rows = docs.map(mapFn);
  const BATCH = 1000;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'mongo_id' });
    if (error) {
      console.error(`  ❌ 배치 ${i / BATCH + 1} upsert 실패:`, error.message);
      throw error;
    }
    done += chunk.length;
    console.log(`  ... ${done}/${rows.length}`);
  }
  console.log(`  ✅ ${done}건 복사 완료`);
  return done;
}

const mapInventory = (d) => ({
  mongo_id: String(d._id),
  sku_id: emptyToNull(d.skuId),
  name: emptyToNull(d.name),
  barcode: emptyToNull(d.barcode),
  order_status: emptyToNull(d.orderStatus),
  quantity: d.quantity === undefined || d.quantity === null ? null : String(d.quantity), // '-' 등 placeholder 원본 유지
  location: emptyToNull(d.location),
  last_update: toISO(d.lastUpdate),
});

const mapChinaImport = (d) => ({
  mongo_id: String(d._id),
  shipment_code: emptyToNull(d.shipmentCode) ?? '',
  pallet: emptyToNull(d.pallet),
  box_name: emptyToNull(d.boxName),
  order_number: emptyToNull(d.orderNumber),
  product_name: emptyToNull(d.productName),
  quantity: d.quantity === undefined || d.quantity === null ? null : String(d.quantity),
  barcode: emptyToNull(d.barcode),
  available_orders: emptyToNull(d.availableOrders),
  shipping_date: emptyToNull(d.shippingDate),
  created_at: toISO(d.createdAt) ?? undefined,
});

(async () => {
  console.log('MongoDB 연결 중...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB 연결됨 (읽기 전용으로 사용)');

  const only = process.argv[2]; // 선택 실행: node migrate-to-supabase.js inventories
  if (!only || only === 'orders')       await migrateCollection('orders', 'rk_orders', 'rk_order_items');
  if (!only || only === 'neworders')    await migrateCollection('newOrders', 'rk_new_orders', 'rk_new_order_items');
  if (!only || only === 'inventories')  await migrateFlat('inventories', 'rk_inventories', mapInventory);
  if (!only || only === 'chinaimports') await migrateFlat('chinaimports', 'rk_china_imports', mapChinaImport);

  await mongoose.disconnect();
  console.log('\n🎉 마이그레이션 완료. MongoDB 연결 해제됨.');
  process.exit(0);
})().catch((e) => {
  console.error('마이그레이션 오류:', e);
  process.exit(1);
});
