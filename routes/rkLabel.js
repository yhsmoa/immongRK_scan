/**
 * 라벨 출력 연동 — 별도 서비스(label-service) 에 상품 데이터를 넘겨 QZ Tray 로 인쇄한다.
 *
 * 이 앱은 라벨을 직접 그리지 않는다. 상품관리 페이지의 [라벨출력] 이 선택한 바코드를 보내면
 * 여기서 coupang_items(쿠팡 상품 마스터) 를 조회해 라벨 서비스가 기대하는 필드 묶음으로 만들어 돌려주고,
 * 브라우저가 그것을 iframe(label-service /print-embed) 에 postMessage 로 전달한다.
 *
 *   GET  /labelSettings          → 라벨 서비스의 양식 편집기로 이동 (헤더 메뉴 · 홈 카드)
 *   GET  /api/label/config       → { url, source, userId }  라벨 서비스 주소 + 이 앱의 사업자 계정
 *   POST /api/label/items        → { barcodes } → { items:[{ data, qty }], missing:[barcode] }      상품 라벨 (상품관리 · 발주서 관리)
 *   POST /api/label/order-boxes  → { orderNumbers } → { items:[{ data, qty }], noBox, notFound }   박스 라벨 (쉽먼트)
 *
 * env: LABEL_SERVICE_URL (필수), LABEL_ACCOUNT_USERNAME (si_users.username, 기본 immong)
 * 필드 이름은 label-service 의 lib/labelTypes.ts 와 맞춰야 한다 — 상품은 SOURCE_PRODUCT_FIELDS.rocket,
 * 박스 라벨은 ORDER_FIELDS(po_*) · BOX_FIELDS(bx_*).
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

// ── 발주서 박스 라벨 데이터 (쉽먼트 /shipment · 발주서 관리 /rocket 의 [박스라벨출력]) ──
//   출고스캔이 저장한 박스(rk_ship_boxes)마다 라벨 1장. 상품이 담기지 않은 빈 박스는 쉽먼트·CJ 운송장과 같은 기준으로 뺀다.
//   출고스캔 전(박스 없음) 발주서는 제외하지 않고 박스 1/1 · 크기 없음으로 1장 만든다 (noBox 에 발주번호를 돌려줘 호스트가 안내).
//   bx_order_box 는 CJ 운송장 접수 엑셀의 발주번호 열("144287071 - 1")과 같은 형식 — 운송장과 박스 라벨을 맞춰 볼 수 있게.
//   라벨 서비스로는 labelType:'box' 로 보낸다 (성인/키즈 구분 없음).
//   skipPrinted(기본 true, 2026-10-15): "이미 뽑힌 라벨" 로 보는 박스는 뺀다 — 실제 스캔 박스(가상 0, 옛 흐름은 스캔 후 라벨) 와
//   가상확정된 박스(라벨 확정 또는 모바일 입고로 다 찾음 = 라벨을 이미 붙이고 찾은 것). 아직 미확정인 가상 박스만 남는다.
//   모달의 체크박스를 풀면 skipPrinted:false 로 전부 만든다.
router.post('/api/label/order-boxes', async (req, res) => {
  try {
    const orderNumbers = [...new Set((Array.isArray(req.body.orderNumbers) ? req.body.orderNumbers : [])
      .map((v) => String(v == null ? '' : v).trim()).filter(Boolean))];
    if (!orderNumbers.length) return res.status(400).json({ error: '발주번호가 없습니다.' });
    const skipPrinted = req.body.skipPrinted !== false;

    // 1000행씩 나눠 읽으므로 id 순 정렬 (정렬 없는 range 는 행이 빠지거나 겹칠 수 있다)
    const [headers, boxes, boxItems, found] = await Promise.all([
      S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_orders')
        .select('order_number, logistics_center, arrival_date, order_qty').in('order_number', nos).order('id', { ascending: true }))),
      S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_ship_boxes')
        .select('id, order_number, box_no, box_size, virtual_confirmed_qty').in('order_number', nos).order('id', { ascending: true }))),
      S.chunked(orderNumbers, 200, (nos) => S.pageAll(() => sb.from('rk_ship_box_items')
        .select('box_id, order_number, barcode, qty, virtual_qty').in('order_number', nos).order('id', { ascending: true }))),
      skipPrinted ? S.mobileFoundByKey(orderNumbers) : Promise.resolve(new Map()),
    ]);
    // 가상 준비완료 판정(가상확정 ✅ 통합 규칙) — 라벨 확정 또는 모바일 입고로 그 박스의 가상 상품을 다 찾음
    const readiness = S.virtualReadiness(boxItems, found);
    const alreadyPrinted = (b, sum) => {
      const vSum = readiness.virtualSumByBox.get(b.id) || 0;
      if (vSum <= 0 && sum && sum.qty > 0) return '실제 스캔';        // 실제로 스캔해 담은 박스 (옛 흐름: 스캔 후 라벨)
      if (vSum > 0 && readiness.boxOk(b)) return '가상확정';           // 라벨 붙여 찾기까지 끝난 가상 박스
      return null;
    };

    const headerByNo = new Map();
    for (const h of headers) { const k = String(h.order_number); if (!headerByNo.has(k)) headerByNo.set(k, h); }
    // 박스별 상품 합계 — box_id → { qty, barcodes }
    const sumByBox = new Map();
    for (const it of boxItems) {
      const q = parseInt(it.qty, 10) || 0;
      if (q <= 0) continue;
      const s = sumByBox.get(it.box_id) || { qty: 0, barcodes: new Set() };
      s.qty += q;
      if (it.barcode) s.barcodes.add(it.barcode);
      sumByBox.set(it.box_id, s);
    }
    const boxesByOrder = new Map();
    for (const b of boxes) {
      const k = String(b.order_number);
      if (!boxesByOrder.has(k)) boxesByOrder.set(k, []);
      boxesByOrder.get(k).push(b);
    }

    const items = [];
    const noBox = [];      // 발주서는 있는데 상품이 담긴 박스가 없음 (출고스캔 전) — 제외하지 않고 박스 1개 기준으로 1장 만든다
    const notFound = [];   // rk_orders 에 없는 발주번호
    const skipped = [];    // 이미 뽑힌 라벨로 보고 뺀 박스 [{orderNo, boxNo, reason}] (skipPrinted 일 때)
    const allPrinted = []; // 박스는 있는데 전부 이미 뽑힌 발주서 (라벨 0장)
    let orderCount = 0;
    for (const no of orderNumbers) {
      const h = headerByNo.get(no);
      if (!h) { notFound.push(no); continue; }
      const full = (boxesByOrder.get(no) || [])
        .filter((b) => sumByBox.has(b.id))
        .sort((a, b) => ((parseInt(a.box_no, 10) || 0) - (parseInt(b.box_no, 10) || 0)) || (a.id - b.id));
      // 이미 뽑힌 박스 제외 — 순번(bx_seq)·박스 수(po_box_count)는 전체 박스 기준으로 유지한다 (3/5 처럼 실제 자리)
      const list = skipPrinted
        ? full.filter((b) => { const r = alreadyPrinted(b, sumByBox.get(b.id)); if (r) skipped.push({ orderNo: no, boxNo: b.box_no, reason: r }); return !r; })
        : full;
      if (full.length && !list.length) { allPrinted.push(no); continue; }
      orderCount++;
      if (!full.length) {
        // 출고스캔 전: 박스 정보가 없어도 발주번호 라벨은 필요하다(2026-10-14 요청). 박스는 "1/1" 로 두고 크기·수량은 비운다.
        //   라벨 서비스의 "발주서당 1장" 템플릿이면 어차피 발주번호만 찍힌다.
        noBox.push(no);
        items.push({
          qty: 1,
          data: {
            po_order_number: no,
            po_center: S.str(h.logistics_center),
            po_arrival_date: S.dateToYmd(h.arrival_date),
            po_order_qty: h.order_qty == null ? '' : h.order_qty,
            po_scan_qty: 0,
            po_box_count: 0,
            bx_order_box: `${no} - 1`,
            bx_no: '1',
            bx_size: '',
            bx_seq: '1/1',
            bx_qty: '',
            bx_item_count: '',
          },
        });
        continue;
      }
      const scanQty = full.reduce((s, b) => s + sumByBox.get(b.id).qty, 0);
      for (const b of list) {
        const sum = sumByBox.get(b.id);
        const i = full.indexOf(b);
        items.push({
          qty: 1,
          data: {
            po_order_number: no,
            po_center: S.str(h.logistics_center),
            po_arrival_date: S.dateToYmd(h.arrival_date),
            po_order_qty: h.order_qty == null ? '' : h.order_qty,
            po_scan_qty: scanQty,
            po_box_count: full.length,
            bx_order_box: `${no} - ${b.box_no}`,
            bx_no: String(b.box_no),
            bx_size: S.str(b.box_size),
            bx_seq: `${i + 1}/${full.length}`,
            bx_qty: sum.qty,
            bx_item_count: sum.barcodes.size,
          },
        });
      }
    }
    res.json({ items, orderCount, noBox, notFound, skipPrinted, skipped, allPrinted });
  } catch (e) {
    console.error('[rk] label/order-boxes:', e);
    res.status(500).json({ error: '박스 라벨 데이터 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
