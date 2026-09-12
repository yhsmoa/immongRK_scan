/**
 * 라벨 출력 연동 — 별도 서비스(label-service) 에 상품 데이터를 넘겨 QZ Tray 로 인쇄한다.
 *
 * 이 앱은 라벨을 직접 그리지 않는다. 상품관리 페이지의 [라벨출력] 이 선택한 바코드를 보내면
 * 여기서 coupang_items(쿠팡 상품 마스터) 를 조회해 라벨 서비스가 기대하는 필드 묶음으로 만들어 돌려주고,
 * 브라우저가 그것을 iframe(label-service /print-embed) 에 postMessage 로 전달한다.
 *
 *   GET  /labelSettings          → 라벨 서비스의 양식 편집기로 이동 (헤더 메뉴 · 홈 카드)
 *   GET  /api/label/config       → { url, source, userId }  라벨 서비스 주소 + 이 앱의 사업자 계정
 *   POST /api/label/items        → { barcodes } → { items:[{ data, qty }], missing:[barcode] }
 *
 * env: LABEL_SERVICE_URL (필수), LABEL_ACCOUNT_USERNAME (si_users.username, 기본 immong)
 * 필드 이름은 label-service 의 lib/labelTypes.ts SOURCE_PRODUCT_FIELDS.rocket 과 맞춰야 한다.
 */
const express = require('express');
const S = require('./rkShared');

const router = express.Router();
const sb = S.supabase;
const SOURCE = 'rocket';
const BATCH = 200;

function serviceUrl() {
  const raw = String(process.env.LABEL_SERVICE_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

/** 사업자 계정(si_users) id — 한 번 찾으면 프로세스 안에서 재사용 */
let cachedUserId = null;
async function accountUserId() {
  if (cachedUserId) return cachedUserId;
  const username = String(process.env.LABEL_ACCOUNT_USERNAME || 'immong').trim();
  const { data, error } = await sb.from('si_users').select('id').eq('username', username).limit(1);
  if (error) throw error;
  if (!data || !data.length) throw new Error(`si_users 에 계정 "${username}" 이 없습니다.`);
  cachedUserId = data[0].id;
  return cachedUserId;
}

// ── 양식 편집기로 이동 ──
router.get('/labelSettings', (req, res) => {
  const url = serviceUrl();
  if (!url) return res.status(500).send('LABEL_SERVICE_URL 환경변수가 설정되지 않았습니다.');
  res.redirect(`${url}/label-settings`);
});

// ── 임베드 설정 ──
router.get('/api/label/config', async (req, res) => {
  try {
    const url = serviceUrl();
    if (!url) return res.status(500).json({ error: 'LABEL_SERVICE_URL 환경변수가 설정되지 않았습니다.' });
    res.json({ url, source: SOURCE, userId: await accountUserId() });
  } catch (e) {
    console.error('[rk] label/config:', e);
    res.status(500).json({ error: '라벨 설정을 불러오는 중 오류가 발생했습니다: ' + e.message });
  }
});

// ── 바코드 → 라벨 데이터 (coupang_items 우선, 재고·위치는 rk_inventories) ──
router.post('/api/label/items', async (req, res) => {
  try {
    const barcodes = [...new Set((Array.isArray(req.body.barcodes) ? req.body.barcodes : [])
      .map((b) => String(b || '').replace(/\s+/g, '')).filter(Boolean))];
    if (!barcodes.length) return res.status(400).json({ error: '바코드가 없습니다.' });

    const items = new Map();   // barcode → coupang_items row
    const inv = new Map();     // barcode → rk_inventories row
    for (let i = 0; i < barcodes.length; i += BATCH) {
      const chunk = barcodes.slice(i, i + BATCH);
      const [ci, ri] = await Promise.all([
        sb.from('coupang_items').select('*').in('barcode', chunk),
        sb.from('rk_inventories').select('barcode, sku_id, name, order_status, quantity, location').in('barcode', chunk),
      ]);
      if (ci.error) throw ci.error;
      if (ri.error) throw ri.error;
      for (const r of ci.data || []) if (!items.has(r.barcode)) items.set(r.barcode, r);
      for (const r of ri.data || []) if (!inv.has(r.barcode)) inv.set(r.barcode, r);
    }

    const missing = [];
    const out = [];
    for (const barcode of barcodes) {
      const c = items.get(barcode);
      const r = inv.get(barcode);
      if (!c) missing.push(barcode);
      if (!c && !r) continue;   // 어디에도 없는 바코드는 보내지 않는다
      const name = (c && c.product_name) || (r && r.name) || '';
      out.push({
        qty: 1,
        data: {
          barcode,
          item_name: name,
          product_name: name,
          sku_id: (c && c.sku_id) || (r && r.sku_id) || '',
          request_number: c ? c.request_number : '',
          order_status: (c && c.order_status) || (r && r.order_status) || '',
          brand_manager: c ? c.brand_manager : '',
          instock_manager: c ? c.instock_manager : '',
          size_width: c ? c.size_width : null,
          size_length: c ? c.size_length : null,
          size_height: c ? c.size_height : null,
          weight: c ? c.weight : null,
          moq: c ? c.MOQ : null,
          inner_qty: c ? c.inner_qty : null,
          box_qty: c ? c.box_qty : null,
          box_barcode: c ? c.box_barcode : '',
          stock: r && r.quantity !== '-' ? r.quantity : '',
          location: r && r.location !== '-' ? r.location : '',
        },
      });
    }
    res.json({ items: out, missing });
  } catch (e) {
    console.error('[rk] label/items:', e);
    res.status(500).json({ error: '라벨 데이터 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
