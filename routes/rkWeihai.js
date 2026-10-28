/**
 * 위해 주문·장바구니 — purchase-agent DB(별도 Supabase) 연동 (2026-10-28)
 *
 * 상품부족(/shortage) 의 '주문' 열은 세 출처를 바코드 기준으로 더한다 (배송유형 무관):
 *   · 이우 📦  — 우리 DB yiwu_br_orders (server.js 5.5단계, 기존 그대로)
 *   · 위해 🛒  — ft_carts.status NEW(편집 중)·ORDER(주문대기) 카트의 ft_cart_items.order_qty 합
 *                DONE 카트는 이미 ft_order_items 로 넘어간 것이라 세지 않는다 (위해 📦 에서 센다)
 *   · 위해 📦  — ft_order_items.status PROCESSING 의 (주문 − 취소/반품 − 출고완료) 합
 *                취소/반품 = ft_fulfillment_inbounds type CANCEL·RETURN
 *                출고완료  = ft_fulfillment_outbounds type PACKED 이면서 쉽먼트에 실린 것(shipment_id 있음)
 *                          — 포장만 하고 아직 안 나간 것(shipment_id 없음)은 주문으로 계속 센다
 *                주문 품목 하나가 음수가 되지 않게 0 에서 자른 뒤 바코드별로 더한다
 *   세트 상품은 stock_management 와 같이 set_seq 가 1(또는 없음)인 행만 센다 (세트 구성 행 중복 방지)
 *
 * 계정: 서버가 ORDER_ACCOUNT_USERNAME(immongbr) 으로 ft_users.id 를 찾아 고정한다. 화면이 보낸 계정 값은 받지 않는다.
 *
 *   GET  /api/shortage/weihai-carts  → { account, shipmentTypes, carts:[{ id, cart_name, status, created_at }] }  (NEW 카트만, 최신순)
 *   POST /api/shortage/weihai-cart   { mode:'new'|'existing', cartName?, cartId?, shipmentType, items:[{ barcode, qty, skuId, name }] }
 *        → { success, count, cartId, cartName }
 *        stock_management [주문 ▸ 장바구니] 와 같은 방식 — 같은 상품이 이미 있어도 합치지 않고 새 행으로 이어 붙인다.
 *        상품명·옵션명은 상품이름을 첫 쉼표로 나눈 앞/뒤, vendor_option_id = sku_id,
 *        혼용률(composition)·권장연령(recommanded_age)은 우리 rk_inventories 에서 바코드로 찾아 넣는다.
 *        가격·1688 링크·쿠팡 사이즈 등은 비워 둔다 (purchase-agent 장바구니 화면에서 채움).
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const S = require('./rkShared');

const router = express.Router();
const sb = S.supabase;

const ORDER_URL = process.env.ORDER_SUPABASE_URL || '';
const ORDER_KEY = process.env.ORDER_SUPABASE_KEY || '';
const ACCOUNT = String(process.env.ORDER_ACCOUNT_USERNAME || '').trim();
const odb = ORDER_URL && ORDER_KEY ? createClient(ORDER_URL, ORDER_KEY) : null;

// 장바구니에 담을 때 고르는 배송유형 — 첫 값이 기본. immongbr 은 PERSONAL 이 없다. STOCK 이 생기면 여기에 추가
const SHIPMENT_TYPES = ['DIRECT', 'COUPANG'];
const CART_COUNT_STATUSES = ['NEW', 'ORDER'];
const CHUNK = 100;          // .in() 한 번에 넣는 개수 (URL 길이)
const INSERT_CHUNK = 500;
const ACCOUNT_TTL_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cartLocks = new Map();   // cartId → 그 카트에 대한 마지막 담기 요청이 끝나는 Promise

// 우리 DB 등 다른 클라이언트에도 같은 방식 (정렬은 pageAll 이 id 로 붙인다)
const pageAllOn = (client, build) => pageAll(() => build(client));
const isSetChild = (r) => r.set_seq != null && Number(r.set_seq) !== 1;
const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };

// 읽기 재시도 — 일시적 네트워크 오류는 같은 요청을 다시 보낸다 (읽기라 안전). 3번 모두 실패하면 오류를 돌려준다
async function readPage(makeQuery) {
  let lastError = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await makeQuery();
      if (!r.error) return r;
      lastError = r.error;
    } catch (e) {
      lastError = e;
    }
    if (i < 2) await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
  }
  return { data: null, error: lastError };
}
// 1000행 넘게 이어 읽기 — 페이지 사이 겹침/빠짐이 없도록 id 로 정렬, 페이지마다 재시도
async function pageAll(build) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await readPage(() => build().order('id', { ascending: true }).range(from, from + 999));
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

let accountCache = null;   // { id, at }
async function accountId() {
  if (!odb) throw new Error('위해 주문 DB 설정이 없습니다 (ORDER_SUPABASE_URL · ORDER_SUPABASE_KEY)');
  if (!ACCOUNT) throw new Error('위해 계정 설정이 없습니다 (ORDER_ACCOUNT_USERNAME)');
  if (accountCache && Date.now() - accountCache.at < ACCOUNT_TTL_MS) return accountCache.id;
  const { data, error } = await readPage(() => odb.from('ft_users').select('id').eq('username', ACCOUNT));
  if (error) throw error;
  if (!data || data.length !== 1) {
    throw new Error(`위해 계정 '${ACCOUNT}' 을 ${data && data.length ? '하나로 특정할 수 없습니다' : '찾을 수 없습니다'}`);
  }
  accountCache = { id: data[0].id, at: Date.now() };
  return accountCache.id;
}

/**
 * 바코드별 위해 🛒·📦 수량. 실패하면 throw — 부르는 쪽이 0 으로 덮지 않고 "못 불러왔다" 를 알려야 한다
 * (0 으로 두면 재고부족 판정이 조용히 틀어진다).
 * @returns {{ cart: Map<string, number>, order: Map<string, number> }}
 */
async function weihaiQtyByBarcode(barcodes) {
  const uid = await accountId();
  const list = [...new Set((barcodes || []).filter(Boolean).map(String))];
  const cart = new Map();
  const order = new Map();
  if (!list.length) return { cart, order };
  const add = (m, bc, q) => { if (q) m.set(bc, (m.get(bc) || 0) + q); };

  const [cartRows, orderItems] = await Promise.all([
    // 🛒 — NEW·ORDER 카트 → 그 카트의 행
    pageAll(() => odb.from('ft_carts').select('id').eq('user_id', uid).in('status', CART_COUNT_STATUSES)).then((carts) => {
      const ids = carts.map((c) => c.id);
      if (!ids.length) return [];
      return S.chunkedPool(list, CHUNK, (bcs) => S.chunkedPool(ids, CHUNK, (cids) => pageAll(() => odb.from('ft_cart_items')
        .select('id, barcode, order_qty, set_seq')
        .eq('user_id', uid).in('cart_id', cids).in('barcode', bcs)), 1), 4);
    }),
    // 📦 — 진행 중 주문 품목
    S.chunkedPool(list, CHUNK, (bcs) => pageAll(() => odb.from('ft_order_items')
      .select('id, barcode, order_qty, set_seq')
      .eq('user_id', uid).eq('status', 'PROCESSING').in('barcode', bcs)), 4),
  ]);

  cartRows.forEach((r) => { if (r.barcode && !isSetChild(r)) add(cart, r.barcode, toInt(r.order_qty)); });

  const live = orderItems.filter((r) => r.barcode && !isSetChild(r));
  const ids = live.map((r) => r.id);
  const minus = new Map();   // order_item_id → 취소/반품 + 출고완료
  if (ids.length) {
    const [inbounds, outbounds] = await Promise.all([
      S.chunkedPool(ids, CHUNK, (part) => pageAll(() => odb.from('ft_fulfillment_inbounds')
        .select('id, order_item_id, quantity').in('order_item_id', part).in('type', ['CANCEL', 'RETURN'])), 4),
      S.chunkedPool(ids, CHUNK, (part) => pageAll(() => odb.from('ft_fulfillment_outbounds')
        .select('id, order_item_id, quantity').in('order_item_id', part).eq('type', 'PACKED').not('shipment_id', 'is', null)), 4),
    ]);
    [...inbounds, ...outbounds].forEach((r) => minus.set(r.order_item_id, (minus.get(r.order_item_id) || 0) + toInt(r.quantity)));
  }
  live.forEach((r) => add(order, r.barcode, Math.max(0, toInt(r.order_qty) - (minus.get(r.id) || 0))));

  return { cart, order };
}

// ── 장바구니 목록 (NEW 만 — 담을 수 있는 카트) ──
router.get('/api/shortage/weihai-carts', async (req, res) => {
  try {
    const uid = await accountId();
    const carts = await pageAll(() => odb.from('ft_carts').select('id, cart_name, status, created_at').eq('user_id', uid).eq('status', 'NEW'));
    carts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ account: ACCOUNT, shipmentTypes: SHIPMENT_TYPES, carts });
  } catch (error) {
    console.error('위해 장바구니 목록 오류:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── 장바구니 담기 ──
router.post('/api/shortage/weihai-cart', async (req, res) => {
  const { mode, cartName, cartId, shipmentType, items } = req.body || {};
  // 1) 입력 검사 — 어느 하나라도 틀리면 아무것도 쓰지 않는다
  if (mode !== 'new' && mode !== 'existing') return res.status(400).json({ error: '카트를 고르세요.' });
  if (!SHIPMENT_TYPES.includes(shipmentType)) return res.status(400).json({ error: '배송유형을 고르세요.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '입력 값이 있는 행이 없습니다.' });
  const lines = [];
  const seen = new Set();
  for (const it of items) {
    const barcode = String((it && it.barcode) || '').trim();
    const qty = Number(it && it.qty);
    if (!barcode) return res.status(400).json({ error: '바코드가 없는 행이 있습니다.' });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: `${barcode} 수량이 올바르지 않습니다.` });
    if (seen.has(barcode)) return res.status(400).json({ error: `${barcode} 가 두 번 들어 있습니다.` });
    seen.add(barcode);
    lines.push({ barcode, qty, skuId: String((it && it.skuId) || '').trim(), name: String((it && it.name) || '').trim() });
  }
  const newName = String(cartName || '').trim();
  if (mode === 'new' && (!newName || newName.length > 100)) return res.status(400).json({ error: '새 카트 이름을 입력하세요 (100자 이하).' });
  if (mode === 'existing' && !UUID_RE.test(String(cartId || ''))) return res.status(400).json({ error: '카트를 고르세요.' });

  // 같은 카트에 두 요청이 겹치면 cart_seq 가 겹친다 — purchase-agent 는 같은 cart_seq 를 세트로 보므로 카트별로 줄 세운다
  const lockKey = mode === 'existing' ? String(cartId) : null;
  const prev = lockKey ? cartLocks.get(lockKey) || Promise.resolve() : Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  if (lockKey) cartLocks.set(lockKey, chain);
  await prev;

  let createdCartId = null;   // 새로 만든 카트 — 행 저장이 실패하면 지운다
  let insertedIds = [];       // 기존 카트에 넣은 행 — 실패하면 지운다
  try {
    const uid = await accountId();

    // 2) 상품 정보 — 우리 rk_inventories (sku_id · 상품명 · 혼용률 · 권장연령)
    const inv = await S.chunkedPool(lines.map((l) => l.barcode), 200, (bcs) => pageAllOn(sb, (c) => c.from('rk_inventories')
      .select('id, barcode, sku_id, name, composition, recommanded_age').in('barcode', bcs)));
    const invByBc = new Map();
    inv.forEach((r) => { if (!invByBc.has(r.barcode) || (!invByBc.get(r.barcode).sku_id && r.sku_id)) invByBc.set(r.barcode, r); });

    // 3) 카트 — 새로 만들거나, 기존 NEW 카트 뒤에 이어 붙인다
    let cid;
    let cname;
    let startSeq = 1;
    if (mode === 'new') {
      const { data, error } = await odb.from('ft_carts').insert({ user_id: uid, cart_name: newName, status: 'NEW' }).select('id, cart_name').single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: `이미 "${newName}" 카트가 존재합니다. 다른 이름을 쓰거나 목록에서 고르세요.` });
        throw error;
      }
      cid = data.id; cname = data.cart_name; createdCartId = cid;
    } else {
      const { data, error } = await odb.from('ft_carts').select('id, cart_name, status').eq('id', cartId).eq('user_id', uid).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: '카트를 찾을 수 없습니다. 목록을 다시 불러오세요.' });
      if (data.status !== 'NEW') return res.status(409).json({ error: `"${data.cart_name}" 카트는 이미 주문으로 넘어갔습니다 (${data.status}). 다른 카트를 고르세요.` });
      cid = data.id; cname = data.cart_name;
      const { data: last, error: seqErr } = await odb.from('ft_cart_items').select('cart_seq').eq('cart_id', cid).not('cart_seq', 'is', null).order('cart_seq', { ascending: false }).limit(1);
      if (seqErr) throw seqErr;
      startSeq = (last && last.length ? toInt(last[0].cart_seq) : 0) + 1;
    }

    // 4) 행 — 상품이름 "상품명, 옵션1, 옵션2" → item_name = 첫 쉼표 앞, option_name = 나머지
    const rows = lines.map((l, i) => {
      const iv = invByBc.get(l.barcode) || {};
      const full = String(iv.name || l.name || '');
      const ci = full.indexOf(',');
      return {
        item_name: (ci >= 0 ? full.slice(0, ci) : full).trim() || null,
        option_name: ci >= 0 ? full.slice(ci + 1).trim() || null : null,
        order_qty: l.qty,
        barcode: l.barcode,
        vendor_option_id: String(iv.sku_id || l.skuId || '').trim() || null,
        composition: iv.composition || null,
        recommanded_age: iv.recommanded_age || null,
        user_id: uid,
        cart_id: cid,
        cart_name: cname,
        shipment_type: shipmentType,
        cart_seq: startSeq + i,
        set_total: 1,     // 단품 — purchase-agent [저장] 정규화 결과와 같은 값
        set_seq: 1,
      };
    });
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const { data, error } = await odb.from('ft_cart_items').insert(rows.slice(i, i + INSERT_CHUNK)).select('id');
      if (error) throw error;
      insertedIds.push(...(data || []).map((d) => d.id));
    }
    res.json({ success: true, count: rows.length, cartId: cid, cartName: cname });
  } catch (error) {
    console.error('위해 장바구니 담기 오류:', error);
    // 절반만 들어간 상태를 남기지 않는다
    try {
      if (createdCartId) {
        await odb.from('ft_cart_items').delete().eq('cart_id', createdCartId);
        await odb.from('ft_carts').delete().eq('id', createdCartId);
      } else if (insertedIds.length) {
        for (let i = 0; i < insertedIds.length; i += CHUNK) await odb.from('ft_cart_items').delete().in('id', insertedIds.slice(i, i + CHUNK));
      }
    } catch (rbErr) { console.error('위해 장바구니 되돌리기 실패:', rbErr); }
    res.status(500).json({ error: error.message });
  } finally {
    release();
    if (lockKey && cartLocks.get(lockKey) === chain) cartLocks.delete(lockKey);   // 뒤에 기다리는 요청이 없으면 비운다
  }
});

module.exports = router;
module.exports.weihaiQtyByBarcode = weihaiQtyByBarcode;
module.exports.isConfigured = () => Boolean(odb && ACCOUNT);
