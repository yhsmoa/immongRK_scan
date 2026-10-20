/**
 * 발주서 도메인 - 엑셀 내보내기 & 중국입고 연동(입고1/2) — Supabase 전환
 * XlsxPopulate 생성 로직은 원본 그대로 유지, 데이터 소스만 rk_* 로 교체.
 */
const express = require('express');
const XlsxPopulate = require('xlsx-populate');
const S = require('./rkShared');

const router = express.Router();

// 출고스캔(shipScan) 저장 데이터 기반 발주서 구성.
//   rk_ship_boxes(박스 헤더: box_no/box_size) + rk_ship_box_items(박스별 상품: barcode/qty) 를 읽어
//   기존 상품정보(박스행) 계약과 동일한 형태로 변환한다.
//   각 상품행: 박스정보=`${box_no}-${box_size}`, 스캔수량=qty, 상품메타(상품번호/이름/확정수량)는 원본 발주상품(바코드)에서.
//   출고스캔 저장분이 있는 발주서만 반환. (scanned_qty·rk_order_items 박스정보 미사용)
async function shipScanOrders(orderNumbers) {
  // 처리완료(DONE) 발주서는 제외 (DB 조회 단계에서)
  const all = await S.listOrdersFull('rk_orders', 'rk_order_items', { excludeDone: true });
  const has = Array.isArray(orderNumbers) && orderNumbers.length > 0;
  const orders = all.filter((o) => !has || orderNumbers.includes(o.발주번호));
  const orderNos = [...new Set(orders.map((o) => o.발주번호).filter(Boolean))];
  if (!orderNos.length) return [];

  // 1000행씩 나눠 읽으므로 반드시 id 순 정렬 — 정렬 없이 range 를 넘기면 행이 빠지거나 중복될 수 있다
  const [boxes, boxItems, seqRows, found] = await Promise.all([
    S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_boxes')
      .select('id, order_number, box_no, box_size, virtual_confirmed_qty').in('order_number', nos).order('id', { ascending: true }))),
    S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_box_items')
      .select('order_number, box_id, barcode, qty, product_name, virtual_qty').in('order_number', nos).order('id', { ascending: true }))),
    // 출고 순서(rk_ship_seq, [순서저장] 스캔 순서) — 발주서 순서 = 그 발주서 행들의 최소 seq, 박스 순서 = (발주번호, 박스번호) 행의 seq
    S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_seq')
      .select('order_number, box_no, seq').in('order_number', nos).order('id', { ascending: true }))),
    S.mobileFoundByKey(orderNos),   // 모바일 입고([스캔]) 찾음 합 — 가상확정 ✅ 통합 판정용
  ]);
  const orderSeq = new Map();   // order_number → min seq
  const boxSeq = new Map();     // `${order_number}|${box_no}` → seq
  for (const r of seqRows) {
    const cur = orderSeq.get(r.order_number);
    if (cur == null || r.seq < cur) orderSeq.set(r.order_number, r.seq);
    if (r.box_no != null) boxSeq.set(`${r.order_number}|${r.box_no}`, r.seq);
  }

  // 박스 헤더: box_id → { order_number, box_no, box_size }
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  // 가상확정 여부 — 통합 규칙(S.virtualReadiness): 박스 라벨 가상확정 OR 모바일 입고로 그 상품(발주번호|바코드)의 가상 분량을 다 찾음
  const { keyOk, boxOk } = S.virtualReadiness(boxItems, found);

  // 박스 아이템: order_number → [{ box_id, barcode, qty, product_name }]
  const itemsByOrder = new Map();
  for (const r of boxItems) {
    if (!itemsByOrder.has(r.order_number)) itemsByOrder.set(r.order_number, []);
    itemsByOrder.get(r.order_number).push(r);
  }

  const result = [];
  for (const order of orders) {
    const items = itemsByOrder.get(order.발주번호) || [];
    if (!items.length) continue;
    // 원본 상품 메타(바코드 기준): 상품번호/상품이름/발주수량/확정수량
    const metaByBc = new Map();
    for (const p of (order.상품정보 || [])) {
      if (p.박스정보) continue; // 원본(박스행 아님)만
      if (!metaByBc.has(p.상품바코드)) metaByBc.set(p.상품바코드, p);
    }
    const 상품정보 = [];
    for (const it of items) {
      const box = boxById.get(it.box_id);
      if (!box) continue;
      const qty = parseInt(it.qty) || 0;
      if (qty <= 0) continue;
      const meta = metaByBc.get(it.barcode) || {};
      상품정보.push({
        상품번호: meta.상품번호 || '',
        상품바코드: it.barcode,
        상품이름: meta.상품이름 || it.product_name || '',
        발주수량: meta.발주수량 || 0,
        확정수량: meta.확정수량 || 0,
        스캔수량: qty,
        가상수량: parseInt(it.virtual_qty, 10) || 0,   // 이 중 [가상스캔]으로 들어온 개수 (쉽먼트 화면 '가상' 태그)
        가상확정: boxOk(box) || keyOk.has(`${order.발주번호}|${it.barcode}`),   // 박스 라벨 가상확정 또는 모바일 입고로 다 찾음
        박스정보: `${box.box_no}-${box.box_size}`,
        박스순서: boxSeq.get(`${order.발주번호}|${box.box_no}`) ?? null,   // 박스 단위로 스캔했을 때만 값이 있다
      });
    }
    if (!상품정보.length) continue;
    result.push({ ...order, 상품정보, 순서: orderSeq.get(order.발주번호) ?? null });
  }
  return result;
}

// ── 내보내기 이력 (rk_export_logs / rk_export_log_items, supabase/rk_export_logs.sql) ──
//   파일을 만들 때마다 "언제 어떤 파일에 어떤 값으로 들어갔는지" 를 남긴다 — 어느 시점의 파일을 쿠팡에 올렸는지
//   앱에 기록이 없어 Railway 로그 시각으로 추정해야 했던 문제(발주서 144286429, 2026-10-16).
//   기록이 실패해도 파일 응답은 그대로 — 호출하는 쪽은 res.send 뒤에 await 없이 부르고, 여기서 console.error 만 남긴다.
//   kind: '확정' | '쉽먼트' | 'CJ'
//   items: [{ order_number, barcode, order_qty, confirmed_qty(파일에 적힌 값), virtual_qty(그중 가상 분량), box_info }]
async function recordExport(kind, filename, items) {
  try {
    const rows = (items || []).filter((it) => it && it.order_number);
    const orderCount = new Set(rows.map((it) => it.order_number)).size;
    const { data: log, error } = await S.supabase.from('rk_export_logs')
      .insert({ kind, filename, order_count: orderCount, row_count: rows.length }).select('id').single();
    if (error) throw error;
    const toInt = (v) => (v == null || v === '' ? null : (parseInt(v, 10) || 0));
    const payload = rows.map((it) => ({
      log_id: log.id,
      order_number: String(it.order_number),
      barcode: it.barcode == null ? null : String(it.barcode),
      order_qty: toInt(it.order_qty),
      confirmed_qty: toInt(it.confirmed_qty),
      virtual_qty: toInt(it.virtual_qty),
      box_info: it.box_info || null,
    }));
    for (let i = 0; i < payload.length; i += 500) {
      const { error: e2 } = await S.supabase.from('rk_export_log_items').insert(payload.slice(i, i + 500));
      if (e2) throw e2;
    }
    return log.id;
  } catch (e) {
    console.error(`[rk] 내보내기 이력 기록 실패(무시) kind=${kind}:`, e.message || e);
    return null;
  }
}

// ── 내보내기 이력 조회 — 그 발주서가 들어간 파일 목록 (최근 것부터), 파일별 바코드 수량 ──
//   GET /api/export-logs?orderNumber=144286429[&barcode=…]
//   (⚠ /api/orders/export-logs 로 두면 먼저 마운트된 rkOrders.js 의 GET /api/orders/:orderNumber 가 가로챈다)
//   응답: { logs:[{ id, kind, exportedAt, filename, orderCount, rowCount,
//                   items:[{ barcode, orderQty, confirmedQty, virtualQty, boxInfo }] }] }
router.get('/api/export-logs', async (req, res) => {
  try {
    const orderNumber = String(req.query.orderNumber || '').trim();
    if (!orderNumber) return res.status(400).json({ error: 'orderNumber 가 필요합니다.' });
    const barcode = String(req.query.barcode || '').trim();
    const rows = await S.pageAll(() => {
      let q = S.supabase.from('rk_export_log_items')
        .select('log_id, barcode, order_qty, confirmed_qty, virtual_qty, box_info, rk_export_logs!inner(id, kind, exported_at, filename, order_count, row_count)')
        .eq('order_number', orderNumber).order('id', { ascending: true });
      if (barcode) q = q.eq('barcode', barcode);
      return q;
    });
    const byLog = new Map();
    for (const r of rows) {
      const h = r.rk_export_logs;
      if (!h) continue;
      if (!byLog.has(h.id)) byLog.set(h.id, { id: h.id, kind: h.kind, exportedAt: h.exported_at, filename: h.filename, orderCount: h.order_count, rowCount: h.row_count, items: [] });
      byLog.get(h.id).items.push({ barcode: r.barcode, orderQty: r.order_qty, confirmedQty: r.confirmed_qty, virtualQty: r.virtual_qty, boxInfo: r.box_info });
    }
    const logs = [...byLog.values()].sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)) || (b.id - a.id));
    res.json({ logs });
  } catch (e) {
    console.error('[rk] export-logs:', e);
    res.status(500).json({ error: '내보내기 이력 조회에 실패했습니다.' });
  }
});

/** 출고 순서 정렬 키 — 박스 순서 > 발주서 순서 > 없음(맨 뒤). 같은 발주서 안에서 순서 없는 박스는 그 발주서 바로 뒤에 붙는다 */
function seqKeyOf(order, product) {
  if (product && product.박스순서 != null) return product.박스순서;
  if (order.순서 != null) return order.순서 + 0.5;
  return Number.POSITIVE_INFINITY;
}

// ── 출고 순서 저장 ([순서저장] 모달) ──
//   body: { codes:[ "144287071", "144287071-1", "144287071 - 2", … ] }  — 박스 라벨/발주서 바코드를 스캔한 순서
//   발주번호 = 앞의 숫자, 박스번호 = '-' 뒤 숫자(선택). rk_orders 에 있고 처리완료가 아닌 발주서만 저장.
//   저장할 때마다 기존 순서는 전부 지우고 새로 넣는다 (한 번에 한 회차 — 어제 순서가 오늘 목록에 섞이지 않게).
//   응답: { saved, invalid:[코드], orders:[발주번호…] }
router.post('/api/shipment/sequence', async (req, res) => {
  try {
    const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
    if (!codes.length) return res.status(400).json({ error: '스캔한 바코드가 없습니다.' });

    const parsed = [];
    const invalid = [];
    for (const code of codes) {
      const m = code.replace(/\s+/g, '').match(/^(\d+)(?:-(\d+))?$/);
      if (!m) { invalid.push(code); continue; }
      parsed.push({ code, orderNumber: m[1], boxNo: m[2] != null ? parseInt(m[2], 10) : null });
    }
    const orderNos = [...new Set(parsed.map((p) => p.orderNumber))];
    const headers = orderNos.length
      ? await S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_orders')
        .select('order_number, status').in('order_number', nos).order('id', { ascending: true })))
      : [];
    const validNos = new Set(headers.filter((h) => !S.isDoneOrder({ 상태: h.status })).map((h) => String(h.order_number)));

    // 같은 (발주번호, 박스번호)를 두 번 찍으면 처음 순서를 쓴다
    const rows = [];
    const seen = new Set();
    let seq = 0;
    for (const p of parsed) {
      if (!validNos.has(p.orderNumber)) { invalid.push(p.code); continue; }
      const k = `${p.orderNumber}|${p.boxNo == null ? 0 : p.boxNo}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ order_number: p.orderNumber, box_no: p.boxNo, seq: ++seq });
    }
    const savedNos = [...new Set(rows.map((r) => r.order_number))];
    if (savedNos.length) {
      const { error: eDel } = await S.supabase.from('rk_ship_seq').delete().gte('id', 0);   // 전체 초기화
      if (eDel) throw eDel;
      const { error: eIns } = await S.supabase.from('rk_ship_seq').insert(rows);
      if (eIns) throw eIns;
    }
    res.json({ saved: rows.length, orders: savedNos, invalid });
  } catch (e) {
    console.error('[rk] shipment/sequence:', e);
    res.status(500).json({ error: '순서 저장 실패: ' + e.message });
  }
});

// ── 쉽먼트 목록 (출고스캔 저장 데이터 기반) — 화면 테이블/송장 모달용 ──
router.get('/api/shipment/orders', async (req, res) => {
  try {
    const orders = await shipScanOrders(null);
    res.json(orders);
  } catch (e) {
    console.error('[rk] shipment/orders:', e);
    res.status(500).json({ error: '쉽먼트 목록을 불러오는데 실패했습니다.' });
  }
});

// ── 운송장번호 → 박스 저장 (rk_ship_boxes.invoice_no) ──
//   invoiceNumbers = { 발주번호: { 박스번호: '600785078033' } } (송장번호 입력 모달 형식, 한 박스에 둘 이상이면 ", " 로 이어진 문자열)
//   박스 행은 (order_number, box_no) 로 하나뿐이라 그 행만 갱신한다. 없는 박스는 건너뛴다.
async function saveBoxInvoices(invoiceNumbers) {
  const updates = [];
  for (const [orderNo, boxes] of Object.entries(invoiceNumbers || {})) {
    for (const [boxNo, inv] of Object.entries(boxes || {})) {
      const v = String(inv == null ? '' : inv).trim();
      const n = parseInt(boxNo, 10);
      if (!v || !Number.isFinite(n)) continue;
      updates.push({ orderNo: String(orderNo).trim(), boxNo: n, inv: v });
    }
  }
  if (!updates.length) return 0;
  // 박스 수십 개 규모라 순차 갱신으로 충분 (한 쉽먼트 저장당 1회)
  let saved = 0;
  for (const u of updates) {
    const { error } = await S.supabase.from('rk_ship_boxes')
      .update({ invoice_no: u.inv }).eq('order_number', u.orderNo).eq('box_no', u.boxNo);
    if (error) throw error;
    saved++;
  }
  return saved;
}

// ── 쉽먼트 내보내기 ──
router.post('/api/shipment/export', async (req, res) => {
  try {
    const { orderNumbers, invoiceNumbers } = req.body;
    const orders = await shipScanOrders(orderNumbers);

    // 운송장번호를 박스에 남긴다 (rk_ship_boxes.invoice_no, 2026-10-15) — [순서정리] 가 쿠팡 PDF 의 운송장번호로 우리 박스를 찾는 열쇠.
    //   엑셀 생성과 무관하게 먼저 저장하고, 실패해도 내보내기는 계속한다 (기록 저장 실패가 쉽먼트 저장을 막지 않게).
    try { await saveBoxInvoices(invoiceNumbers); }
    catch (e) { console.error('[rk] shipment/export 운송장번호 저장 실패(무시):', e.message); }

    const workbook = await XlsxPopulate.fromBlankAsync();
    const mainSheet = workbook.sheet(0);
    mainSheet.name('상품목록');
    const invoiceSheet = workbook.addSheet('송장번호입력');
    invoiceSheet.cell('A1').value('송장번호');

    const uniqueInvoiceNumbers = [];
    Object.values(invoiceNumbers || {}).forEach((boxInvoices) => {
      Object.values(boxInvoices).forEach((invoiceNumber) => {
        if (!uniqueInvoiceNumbers.includes(invoiceNumber)) uniqueInvoiceNumbers.push(invoiceNumber);
      });
    });
    uniqueInvoiceNumbers.forEach((invoiceNumber, index) => {
      invoiceSheet.cell(`A${index + 2}`).value(invoiceNumber);
    });

    const headers = ['발주번호(PO ID)', '물류센터(FC)', '입고유형(Transport Type)', '입고예정일(EDD)',
      '상품번호(SKU ID)', '상품바코드(SKU Barcode)', '상품이름(SKU Name)',
      '확정수량(Confirmed Qty)', '송장번호(Invoice Number)', '납품수량(Shipped Qty)'];
    headers.forEach((header, index) => { mainSheet.cell(1, index + 1).value(header); });

    let rowIndex = 2;
    const logItems = [];   // 내보내기 이력 — 파일의 행마다 (납품수량 = 박스별 스캔수량, 그중 가상 분량)
    orders.forEach((order) => {
      const scannedProducts = order.상품정보.filter((p) => p.스캔수량 > 0 && p.박스정보 && p.박스정보 !== '-');
      scannedProducts.forEach((product) => {
        const boxNumber = product.박스정보.split('-')[0];
        const invoiceNumber = (invoiceNumbers && invoiceNumbers[order.발주번호]?.[boxNumber]) || '';
        logItems.push({ order_number: order.발주번호, barcode: product.상품바코드, order_qty: product.발주수량,
          confirmed_qty: product.스캔수량, virtual_qty: product.가상수량, box_info: product.박스정보 });
        mainSheet.cell(rowIndex, 1).value(order.발주번호);
        mainSheet.cell(rowIndex, 2).value(order.물류센터);
        mainSheet.cell(rowIndex, 3).value('쉽먼트');
        mainSheet.cell(rowIndex, 4).value(order.입고예정일);
        mainSheet.cell(rowIndex, 5).value(product.상품번호);
        mainSheet.cell(rowIndex, 6).value(product.상품바코드);
        mainSheet.cell(rowIndex, 7).value(product.상품이름);
        mainSheet.cell(rowIndex, 8).value(product.확정수량);
        mainSheet.cell(rowIndex, 9).value(invoiceNumber);
        mainSheet.cell(rowIndex, 10).value(product.스캔수량);
        rowIndex++;
      });
    });

    let filename;
    if (orderNumbers && orderNumbers.length === 1) filename = `shipment (${orderNumbers[0]})`;
    else if (orderNumbers && orderNumbers.length > 1) filename = `shipment (${orderNumbers[0]} 외 ${orderNumbers.length - 1}건)`;
    else filename = 'shipment (전체)';

    const buffer = await workbook.outputAsync();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename + '.xlsx')}`);
    res.send(buffer);
    recordExport('쉽먼트', filename + '.xlsx', logItems);   // 응답 뒤 기록 — 실패해도 파일엔 영향 없음
  } catch (e) {
    console.error('[rk] shipment/export:', e);
    res.status(500).json({ error: '데이터 내보내기에 실패했습니다.' });
  }
});

// ── CJ 운송장 내보내기 ──
router.post('/api/shipment/export-cj', async (req, res) => {
  try {
    const { orderNumbers, ordered } = req.body;   // ordered: 화면의 [순서대로] 가 켜져 있으면 출고 순서(rk_ship_seq)대로
    const orders = await shipScanOrders(orderNumbers);

    const { data: centerData } = await S.supabase.from('coupang_centers').select('center, contact, address');
    const centerMap = new Map();
    if (centerData) centerData.forEach((item) => centerMap.set(item.center, { contact: item.contact || '', address: item.address || '' }));

    const workbook = await XlsxPopulate.fromBlankAsync();
    const mainSheet = workbook.sheet(0);
    mainSheet.name('CJ운송장');
    const headers = ['물류센터', '연락처', '주소', '박스타입', '발주번호'];
    headers.forEach((header, index) => {
      const cell = mainSheet.cell(1, index + 1);
      cell.value(header);
      cell.style('fill', 'd3d3d3'); cell.style('border', true); cell.style('borderColor', '000000'); cell.style('borderStyle', 'thin');
    });
    mainSheet.column(1).width(15); mainSheet.column(2).width(30); mainSheet.column(3).width(75); mainSheet.column(4).width(15); mainSheet.column(5).width(25);

    const cjData = [];
    const processedBoxes = new Set();
    orders.forEach((order) => {
      const scannedProducts = order.상품정보.filter((p) => p.스캔수량 > 0 && p.박스정보 && p.박스정보 !== '-');
      scannedProducts.forEach((product) => {
        const boxParts = product.박스정보.split('-');
        const boxNumber = boxParts[0];
        const boxType = boxParts[1] || '';
        const uniqueKey = `${order.발주번호}-${boxNumber}`;
        if (!processedBoxes.has(uniqueKey)) {
          processedBoxes.add(uniqueKey);
          const centerInfo = centerMap.get(order.물류센터);
          cjData.push({ 물류센터: order.물류센터, 연락처: centerInfo?.contact || '', 주소: centerInfo?.address || '', 박스타입: boxType, 발주번호: `${order.발주번호} - ${boxNumber}`, _seq: seqKeyOf(order, product) });
        }
      });
    });
    // [순서대로] — 스캔 순서대로, 순서 없는 박스는 뒤에 (안정 정렬이라 원래 순서 유지)
    if (ordered === true) cjData.sort((a, b) => a._seq - b._seq);

    cjData.forEach((data, index) => {
      const rowIndex = index + 2;
      mainSheet.cell(rowIndex, 1).value(data.물류센터);
      mainSheet.cell(rowIndex, 2).value(data.연락처);
      mainSheet.cell(rowIndex, 3).value(data.주소);
      mainSheet.cell(rowIndex, 4).value(data.박스타입);
      mainSheet.cell(rowIndex, 5).value(data.발주번호);
      for (let col = 1; col <= 5; col++) {
        const cell = mainSheet.cell(rowIndex, col);
        cell.style('border', true); cell.style('borderColor', '000000'); cell.style('borderStyle', 'thin');
      }
    });

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const filename = `로켓배송 CJ 운송장 접수_${yy}${mm}${dd}_${hh}${min}`;

    const buffer = await workbook.outputAsync();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename + '.xlsx')}`);
    res.send(buffer);
    // 내보내기 이력 — 박스 단위(수량 없음), 발주번호 = '144286429 - 1' 의 앞부분, box_info = '박스번호-박스타입'
    recordExport('CJ', filename + '.xlsx', cjData.map((d) => {
      const boxNumber = String(d.발주번호).split(' - ')[1] || '';
      return { order_number: String(d.발주번호).split(' - ')[0], box_info: `${boxNumber}-${d.박스타입}` };
    }));
  } catch (e) {
    console.error('[rk] shipment/export-cj:', e);
    res.status(500).json({ error: 'CJ 엑셀 다운로드에 실패했습니다.' });
  }
});

// ── 발주리스트 확정 내보내기 ──
router.post('/api/orders/export', async (req, res) => {
  try {
    const { orderNumbers, items } = req.body;
    // items(체크된 행: 발주번호+바코드)가 오면 그 행만 내보낸다. 없으면 발주서 단위.
    const itemKeys = Array.isArray(items) && items.length > 0
      ? new Set(items.map((it) => `${it.orderNumber}|${it.barcode}`))
      : null;
    // 처리완료(DONE) 발주서는 내보내기에서 제외 (DB 조회 단계에서)
    const all = await S.listOrdersFull('rk_orders', 'rk_order_items', { excludeDone: true });
    const has = Array.isArray(orderNumbers) && orderNumbers.length > 0;
    const orders = all.filter((o) => !has || orderNumbers.includes(o.발주번호));

    // 확정수량 = 출고스캔(rk_ship_box_items)의 발주번호+바코드별 합 (scanned_qty 미사용, rocket 화면 스캔열과 동일)
    const shipScanMap = new Map();
    const virtualMap = new Map();   // 발주번호|바코드 → 그중 가상스캔 분량 (내보내기 이력용)
    const orderNos = [...new Set(orders.map((o) => o.발주번호).filter(Boolean))];
    const scanRows = await S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_box_items')
      .select('order_number, barcode, qty, virtual_qty').in('order_number', nos).order('id', { ascending: true })));
    for (const r of scanRows) {
      if (!r.order_number || !r.barcode) continue;
      const k = `${r.order_number}|${r.barcode}`;
      shipScanMap.set(k, (shipScanMap.get(k) || 0) + (parseInt(r.qty) || 0));
      virtualMap.set(k, (virtualMap.get(k) || 0) + (parseInt(r.virtual_qty, 10) || 0));
    }

    const dropdownOptions = [
      '제조사 생산중단 혹은 공급사 취급중단 - 제품 리뉴얼/모델 변경', '제조사 생산중단 혹은 공급사 취급중단 - 시장 단종',
      '제조사 생산중단 혹은 공급사 취급중단 - 사업자변경', '협력사 재고부족 - 수요예측 오류',
      '협력사 재고부족 - 생산캐파 부족 (설비라인/원자재/인력/휴무… 등등)', '협력사 재고부족 - 품질적 이슈 (유해물질 발견 / 유통기한 미달)',
      '협력사 재고부족 - 재고 할당정책', '협력사 재고부족 - 수입상품 입고지연 (선적/통관지연)', 'FC 입고기준 미달로 회송',
      '가격 이슈 (Price) - 매입가 인하 협상 중', '가격 이슈 (Price) - 매입가 인상 협상 중', '가격 이슈 (Price) - 쿠팡 최저가 매칭',
      '최소발주량 변경 필요 (MOQ)', '쿠팡 요청 미납', '시즌상품으로 다음 시즌전까지 생산 혹은 취급중단',
      '천재지변/재난과 같은 불가항력적인 사유로 미납', '업체 휴무', '재무 관련 사유', 'FC 입고 이슈 - FC 슬롯 예약 불가', 'FC 입고 이슈 - 밀크런 예약불가',
    ];

    const exportData = [];
    orders.forEach((order) => {
      order.상품정보.forEach((product) => {
        if (product.박스정보) return;
        if (itemKeys && !itemKeys.has(`${order.발주번호}|${product.상품바코드}`)) return;
        exportData.push({
          발주번호: order.발주번호, 물류센터: order.물류센터, 입고유형: product.입고유형 || '', 발주상태: product.발주상태 || '',
          상품번호: product.상품번호, 상품바코드: product.상품바코드, 상품이름: product.상품이름,
          발주수량: product.발주수량, 확정수량: shipScanMap.get(`${order.발주번호}|${product.상품바코드}`) || 0,
          '유통(소비)기한': product['유통(소비)기한'] || '', 제조일자: product.제조일자 || '', 생산년도: product.생산년도 || '',
          납품부족사유: product.납품부족사유 || '', 회송담당자: product.회송담당자 || '', '회송담당자 연락처': product['회송담당자 연락처'] || '',
          회송지주소: product.회송지주소 || '', 매입가: product.매입가 || 0, 공급가: product.공급가 || 0, 부가세: product.부가세 || 0,
          '총발주 매입금': product['총발주 매입금'] || 0, 입고예정일: order.입고예정일 || '', 발주등록일시: product.발주등록일시 || '',
          입고1: product.입고1 || '-', 입고2: product.입고2 || '-', 위치: product.위치 || '-',
        });
      });
    });

    const workbook = await XlsxPopulate.fromBlankAsync();
    const mainSheet = workbook.sheet(0);
    mainSheet.name('발주리스트');
    const hiddenSheet = workbook.addSheet('hiddenSheet');
    dropdownOptions.forEach((option, index) => { hiddenSheet.cell(index + 1, 1).value(option); });

    const headers = ['발주번호', '물류센터', '입고유형', '발주상태', '상품번호', '상품바코드', '상품이름', '발주수량', '확정수량',
      '유통(소비)기한', '제조일자', '생산년도', '납품부족사유', '회송담당자', '회송담당자 연락처', '회송지주소', '매입가', '공급가', '부가세',
      '총발주 매입금', '입고예정일', '발주등록일시', '입고1', '입고2', '위치'];
    headers.forEach((header, index) => {
      const cell = mainSheet.cell(1, index + 1);
      cell.value(header);
      cell.style('fill', { type: 'solid', color: 'D9D9D9' });
    });

    exportData.forEach((row, rowIndex) => {
      const isQuantityMismatch = row.발주수량 !== row.확정수량;
      Object.values(row).forEach((value, colIndex) => {
        const cell = mainSheet.cell(rowIndex + 2, colIndex + 1);
        cell.value(value);
        if (isQuantityMismatch) cell.style('fill', { type: 'solid', color: 'FFFF00' });
      });
    });

    const lastRow = exportData.length + 1;
    mainSheet.range(`M2:M${lastRow}`).dataValidation({ type: 'list', formula1: 'hiddenSheet!$A$1:$A$20', allowBlank: true });
    hiddenSheet.hidden(true);

    let filename;
    if (orderNumbers && orderNumbers.length === 1) filename = `발주리스트 확정 (${orderNumbers[0]}).xlsx`;
    else if (orderNumbers && orderNumbers.length > 1) filename = `발주리스트 확정 (${orderNumbers[0]} 외 ${orderNumbers.length - 1}건).xlsx`;
    else filename = '발주리스트 확정 (전체).xlsx';

    const buffer = await workbook.outputAsync();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.send(buffer);
    // 내보내기 이력 — 파일의 행마다 확정수량(파일에 적힌 값)과 그중 가상 분량
    recordExport('확정', filename, exportData.map((row) => ({
      order_number: row.발주번호, barcode: row.상품바코드, order_qty: row.발주수량,
      confirmed_qty: row.확정수량, virtual_qty: virtualMap.get(`${row.발주번호}|${row.상품바코드}`) || 0,
    })));
  } catch (e) {
    console.error('[rk] orders/export:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── 입고1/입고2 합산 업데이트 (중국입고 → 발주서) ──
async function updateImport(field, req, res) {
  const updateData = req.body;
  if (!Array.isArray(updateData) || updateData.length === 0) return res.status(400).json({ error: '유효하지 않은 데이터' });

  const consolidated = {};
  for (const item of updateData) {
    const { orderNumber, barcode, importValue } = item;
    if (!orderNumber || !barcode || !importValue) continue;
    const key = `${orderNumber}:${barcode}`;
    if (!consolidated[key]) consolidated[key] = { orderNumber, barcode, importValue: parseInt(importValue) || 0 };
    else consolidated[key].importValue += parseInt(importValue) || 0;
  }
  const merged = Object.values(consolidated);

  for (const { orderNumber, barcode, importValue } of merged) {
    const orderId = await S.getOrderId('rk_orders', orderNumber);
    if (!orderId) continue;
    // 첫 매칭 상품(원본 우선)
    const { data: rows } = await S.supabase.from('rk_order_items')
      .select('id, ' + field).eq('order_id', orderId).eq('barcode', barcode).order('box_info', { ascending: true, nullsFirst: true }).limit(1);
    if (!rows || !rows.length) continue;
    const cur = rows[0][field];
    const currentValue = cur && cur !== '-' ? (parseInt(cur) || 0) : 0;
    await S.supabase.from('rk_order_items').update({ [field]: String(currentValue + importValue) }).eq('id', rows[0].id);
  }
  res.json({ success: true, message: `${merged.length}개 항목이 성공적으로 업데이트되었습니다.` });
}

router.post('/api/orders/updateImport1', (req, res) => updateImport('receiving_1', req, res).catch((e) => { console.error('[rk] updateImport1:', e); res.status(500).json({ error: '입고1 업데이트 실패' }); }));
router.post('/api/orders/updateImport2', (req, res) => updateImport('receiving_2', req, res).catch((e) => { console.error('[rk] updateImport2:', e); res.status(500).json({ error: '입고2 업데이트 실패' }); }));

router.post('/api/orders/resetImport12', async (req, res) => {
  try {
    const { error } = await S.supabase.from('rk_order_items').update({ receiving_1: null, receiving_2: null }).not('id', 'is', null);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('[rk] resetImport12:', e);
    res.status(500).json({ error: '초기화 실패' });
  }
});

module.exports = router;
