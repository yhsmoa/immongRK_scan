/**
 * 발주서/스캔 도메인 — Supabase 전환 (rk_orders / rk_order_items)
 * 기존 /api/orders·/api/scan 응답 계약을 그대로 유지 (referer 분기·dedup 포함).
 * socket.io 실시간 알림은 기존대로 Node에서 emit → factory(io) 형태.
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });

// 엑셀 숫자 파싱: 천단위 콤마(예: "6,300") 제거 후 숫자화. parseFloat 콤마 절단 방지.
const num = (v) => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;

// ── dedup: 원본(박스정보 없음) 우선, 바코드별 1행 (server.js 원본 로직 재현) ──
function dedupUnique(items, { withInboundDefault = false } = {}) {
  const unique = [];
  const seen = new Set();
  items.filter((p) => !p.박스정보).forEach((product) => {
    unique.push(withInboundDefault ? { ...product, 입고1: product.입고1 || '-', 입고2: product.입고2 || '-' } : product);
    seen.add(product.상품바코드);
  });
  items.forEach((product) => {
    if (!seen.has(product.상품바코드)) {
      const np = { ...product };
      delete np.박스정보;
      unique.push(withInboundDefault ? { ...np, 입고1: np.입고1 || '-', 입고2: np.입고2 || '-' } : np);
      seen.add(product.상품바코드);
    }
  });
  return unique;
}

// 목록용 가공 (server.js:90-137)
function processListOrder(orderObj, referer) {
  if (referer.includes('/shipment')) {
    orderObj.상품정보 = orderObj.상품정보.filter(
      (p) => p.박스정보 && p.박스정보 !== 'undefined' && p.스캔수량 > 0
    );
    return orderObj;
  }
  orderObj.상품정보 = dedupUnique(orderObj.상품정보, { withInboundDefault: true });
  return orderObj;
}

// 상세용 가공 (server.js:159-254)
function processDetailOrder(order, referer) {
  if (referer.includes('/shipment')) {
    order.상품정보 = order.상품정보.filter((p) => p.박스정보 && p.박스정보 !== '-' && p.스캔수량 > 0);
    return order;
  }
  if (referer.includes('/rocket')) {
    order.상품정보 = dedupUnique(order.상품정보);
    return order;
  }
  if (referer.includes('/scan')) {
    const originals = order.상품정보.filter((p) => !p.박스정보);
    const boxes = order.상품정보.filter((p) => p.박스정보).sort((a, b) =>
      a.박스정보.split('-')[0].localeCompare(b.박스정보.split('-')[0]));
    order.상품정보 = [...originals, ...boxes];
    return order;
  }
  return order;
}

// 스캔 응답 가공 (server.js:472-522) — rocket=dedup, scan=원본+박스정렬
function processScanResponse(order, referer) {
  if (referer.includes('/rocket')) {
    order.상품정보 = dedupUnique(order.상품정보);
  } else if (referer.includes('/scan')) {
    const originals = order.상품정보.filter((p) => !p.박스정보);
    const boxes = order.상품정보.filter((p) => p.박스정보).sort((a, b) =>
      a.박스정보.split('-')[0].localeCompare(b.박스정보.split('-')[0]));
    order.상품정보 = [...originals, ...boxes];
  }
  return order;
}

// 한글 발주서 배열 → Supabase insert (중복 order_number skip). 반환: {added, duplicates[]}
async function insertKoreanOrders(koreanOrders, prefix) {
  const added = [];
  const duplicates = [];
  for (const o of koreanOrders) {
    const exists = await S.getOrderId('rk_orders', o['발주번호']);
    if (exists) { duplicates.push(o['발주번호']); continue; }
    const { data: hdr, error: hErr } = await S.supabase
      .from('rk_orders').insert(S.koreanHeaderToRow(o, prefix)).select('id').single();
    if (hErr) throw hErr;
    const items = (o['상품정보'] || []).map((p) => S.koreanItemToRow(hdr.id, p));
    if (items.length) {
      const { error: iErr } = await S.supabase.from('rk_order_items').insert(items);
      if (iErr) throw iErr;
    }
    added.push(o['발주번호']);
  }
  return { added, duplicates };
}

module.exports = (io) => {
  const router = express.Router();

  // ⚠️ /logistics-centers 를 /:orderNumber 보다 먼저 등록
  router.get('/api/orders/logistics-centers', async (req, res) => {
    try {
      const { data, error } = await S.supabase.from('rk_orders').select('logistics_center');
      if (error) throw error;
      const centers = [...new Set(data.map((r) => r.logistics_center).filter((v) => v != null))];
      res.json({ success: true, centers });
    } catch (e) {
      console.error('[rk] logistics-centers:', e);
      res.status(500).json({ success: false, error: '물류센터 목록을 가져오는 중 오류가 발생했습니다.' });
    }
  });

  // 발주서 목록
  router.get('/api/orders', async (req, res) => {
    try {
      const referer = req.headers.referer || '';
      const orders = await S.listOrdersFull('rk_orders', 'rk_order_items');
      res.json(orders.map((o) => processListOrder(o, referer)));
    } catch (e) {
      console.error('[rk] 발주서 목록:', e);
      res.status(500).json({ error: '발주서 목록을 불러오는데 실패했습니다.' });
    }
  });

  // 발주서 상세
  router.get('/api/orders/:orderNumber', async (req, res) => {
    try {
      const referer = req.headers.referer || '';
      const order = await S.getOrderFull('rk_orders', 'rk_order_items', req.params.orderNumber);
      if (!order) return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
      res.json(processDetailOrder(order, referer));
    } catch (e) {
      console.error('[rk] 발주서 상세:', e);
      res.status(500).json({ error: '발주서를 불러오는데 실패했습니다.' });
    }
  });

  // 엑셀 업로드
  router.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(worksheet, { header: 'A' });
      const dataRows = data.slice(1);

      const groupedData = {};
      dataRows.forEach((row) => {
        const orderNumber = row['A'];
        if (!orderNumber) return;
        if (!groupedData[orderNumber]) {
          groupedData[orderNumber] = {
            발주번호: orderNumber, 입고예정일: row['U'] || '', 물류센터: row['B'] || '',
            상품수: 0, 발주수량: 0, 확정수량: 0, 스캔수량: 0, 상품정보: [],
          };
        }
        groupedData[orderNumber].상품수++;
        groupedData[orderNumber].발주수량 += parseInt(row['H']) || 0;
        groupedData[orderNumber].확정수량 += parseInt(row['I']) || 0;
        groupedData[orderNumber].상품정보.push({
          상품번호: row['E'] || '', 상품바코드: row['F'] || '', 상품이름: row['G'] || '',
          발주수량: parseInt(row['H']) || 0, 확정수량: parseInt(row['I']) || 0, 스캔수량: 0,
          '유통(소비)기한': row['J'] || '', 제조일자: row['K'] || '', 생산년도: row['L'] || '',
          납품부족사유: row['M'] || '', 회송담당자: row['N'] || '', '회송담당자 연락처': row['O'] || '',
          회송지주소: row['P'] || '', 매입가: num(row['Q']), 공급가: num(row['R']),
          부가세: num(row['S']), '총발주 매입금': num(row['T']),
          입고유형: row['C'] || '', 발주상태: row['D'] || '', 발주등록일시: row['V'] || '',
        });
      });

      const { added, duplicates } = await insertKoreanOrders(Object.values(groupedData), 'up');
      let message = '';
      if (added.length > 0) message += `${added.length}개의 발주서가 추가되었습니다.`;
      if (duplicates.length > 0) message += `\n다음 발주서는 이미 존재합니다:\n${duplicates.join(', ')}`;
      res.json({ message, added: added.length, duplicates });
    } catch (e) {
      console.error('[rk] upload:', e);
      res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다.' });
    }
  });

  // 발주서 삭제 (비밀번호)
  router.post('/api/orders/delete', async (req, res) => {
    try {
      const { orderNumbers, password } = req.body;
      if (password !== 'cheoqkr1!') return res.status(403).json({ error: '패스워드가 올바르지 않습니다.' });
      const { error } = await S.supabase.from('rk_orders').delete().in('order_number', orderNumbers || []);
      if (error) throw error;
      res.json({ message: '발주서가 성공적으로 삭제되었습니다.' });
    } catch (e) {
      console.error('[rk] orders/delete:', e);
      res.status(500).json({ error: '발주서 삭제에 실패했습니다.' });
    }
  });

  // 발주서 등록 (parse-excel 미리보기 → 등록)
  router.post('/api/orders/register', async (req, res) => {
    try {
      const { orders } = req.body;
      if (!orders || !Array.isArray(orders) || orders.length === 0)
        return res.status(400).json({ message: '등록할 발주서 정보가 없습니다.' });
      const { added, duplicates } = await insertKoreanOrders(orders, 'reg');
      res.status(200).json({ registered: added.length, duplicates: duplicates.length });
    } catch (e) {
      console.error('[rk] orders/register:', e);
      res.status(500).json({ message: '발주서 등록 중 오류가 발생했습니다.' });
    }
  });

  // 위치 수정 (단건)
  router.post('/api/orders/update-location', async (req, res) => {
    try {
      const { orderNumber, barcode, location } = req.body;
      const orderId = await S.getOrderId('rk_orders', orderNumber);
      if (!orderId) return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
      const { data, error } = await S.supabase.from('rk_order_items')
        .update({ location: location }).eq('order_id', orderId).eq('barcode', barcode).is('box_info', null).select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
      res.json({ success: true });
    } catch (e) {
      console.error('[rk] update-location:', e);
      res.status(500).json({ error: '위치 정보 업데이트 중 오류가 발생했습니다.' });
    }
  });

  // 입고일 변경 (벌크)
  router.post('/api/orders/update-date', async (req, res) => {
    try {
      const { orderNumbers, newDate } = req.body;
      if (!Array.isArray(orderNumbers) || orderNumbers.length === 0)
        return res.status(400).json({ success: false, message: '변경할 발주서가 선택되지 않았습니다.' });
      if (!newDate || !/^\d{8}$/.test(newDate))
        return res.status(400).json({ success: false, message: '올바른 날짜 형식이 아닙니다. YYYYMMDD 형식으로 입력해주세요.' });
      const { data, error } = await S.supabase.from('rk_orders')
        .update({ arrival_date: S.ymdToDate(newDate) }).in('order_number', orderNumbers).select('id');
      if (error) throw error;
      res.json({ success: true, message: '입고일이 성공적으로 변경되었습니다.', updatedCount: data.length });
    } catch (e) {
      console.error('[rk] update-date:', e);
      res.status(500).json({ success: false, message: '입고일 변경 중 오류가 발생했습니다.' });
    }
  });

  // 물류센터 변경 (벌크)
  router.post('/api/orders/update-center', async (req, res) => {
    try {
      const { orderNumbers, newCenter } = req.body;
      if (!Array.isArray(orderNumbers) || orderNumbers.length === 0)
        return res.status(400).json({ success: false, message: '변경할 발주서가 선택되지 않았습니다.' });
      if (!newCenter || newCenter.trim() === '')
        return res.status(400).json({ success: false, message: '변경할 물류센터 정보가 없습니다.' });
      const { data, error } = await S.supabase.from('rk_orders')
        .update({ logistics_center: newCenter }).in('order_number', orderNumbers).select('id');
      if (error) throw error;
      res.json({ success: true, message: '물류센터가 성공적으로 변경되었습니다.', updatedCount: data.length });
    } catch (e) {
      console.error('[rk] update-center:', e);
      res.status(500).json({ success: false, message: '물류센터 변경 중 오류가 발생했습니다.' });
    }
  });

  // 바코드로 상품 조회
  router.get('/api/products/barcode/:barcode', async (req, res) => {
    try {
      const barcode = req.params.barcode;
      const { data, error } = await S.supabase.from('rk_order_items')
        .select('product_name, product_number, box_info').eq('barcode', barcode);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ message: '해당 바코드의 상품을 찾을 수 없습니다.' });
      const orig = data.find((d) => d.box_info == null) || data[0];
      res.json({ 상품바코드: barcode, 상품이름: S.str(orig.product_name), 상품번호: S.str(orig.product_number) });
    } catch (e) {
      console.error('[rk] products/barcode:', e);
      res.status(500).json({ error: '상품 정보를 조회하는데 실패했습니다.' });
    }
  });

  // ── 스캔 ──
  router.post('/api/scan', async (req, res) => {
    try {
      const { orderNumber, barcode, boxNumber, boxSize, quantity } = req.body;
      const scanQuantity = quantity ? parseInt(quantity) : 1;
      const boxInfo = boxNumber && boxSize ? `${boxNumber}-${boxSize}` : null;
      if (!boxInfo) return res.status(400).json({ message: '박스 정보가 필요합니다.' });

      const { data, error } = await S.supabase.rpc('rk_scan', {
        p_order_number: orderNumber, p_barcode: barcode, p_box_info: boxInfo, p_qty: scanQuantity,
      });
      if (error) throw error;
      if (data && data.error) return res.status(data.status || 400).json({ message: data.error });

      io.emit('scan-update', { orderNumber, productBarcode: barcode, boxInfo, newScanCount: data.newScanCount });

      const referer = req.headers.referer || '';
      const order = await S.getOrderFull('rk_orders', 'rk_order_items', orderNumber);
      res.json(processScanResponse(order, referer));
    } catch (e) {
      console.error('[rk] scan:', e);
      res.status(500).json({ message: '바코드 스캔 처리 중 오류가 발생했습니다.' });
    }
  });

  router.post('/api/scan/update', async (req, res) => {
    try {
      const { orderNumber, barcode, boxInfo, scanCount } = req.body;
      const { data, error } = await S.supabase.rpc('rk_scan_update', {
        p_order_number: orderNumber, p_barcode: barcode, p_box_info: boxInfo, p_scan_count: scanCount,
      });
      if (error) throw error;
      if (data && data.error) return res.status(data.status || 400).json({ message: data.error });
      res.json({ message: data.deleted ? '항목이 삭제되었습니다.' : '스캔수량이 업데이트되었습니다.', deleted: data.deleted });
    } catch (e) {
      console.error('[rk] scan/update:', e);
      res.status(500).json({ error: '스캔수량 업데이트에 실패했습니다.' });
    }
  });

  router.post('/api/scan/delete', async (req, res) => {
    try {
      const { orderNumber, barcode } = req.body;
      const { data, error } = await S.supabase.rpc('rk_scan_delete', { p_order_number: orderNumber, p_barcode: barcode });
      if (error) throw error;
      if (data && data.error) return res.status(data.status || 400).json({ message: data.error });
      io.emit('scan-update', { orderNumber, message: '스캔 기록이 삭제되었습니다.' });
      res.json({ message: '스캔 기록이 삭제되었습니다.' });
    } catch (e) {
      console.error('[rk] scan/delete:', e);
      res.status(500).json({ message: '스캔 기록 삭제 중 오류가 발생했습니다.' });
    }
  });

  router.post('/api/scan/updateBox', async (req, res) => {
    try {
      const { orderNumber, oldBoxNumber, oldBoxSize, newBoxNumber, newBoxSize } = req.body;
      const oldBoxInfo = `${oldBoxNumber}-${oldBoxSize}`;
      const newBoxInfo = `${newBoxNumber}-${newBoxSize}`;
      const { data, error } = await S.supabase.rpc('rk_update_box', {
        p_order_number: orderNumber, p_old_box: oldBoxInfo, p_new_box: newBoxInfo, p_new_box_number: newBoxNumber,
      });
      if (error) throw error;
      if (data && data.error) return res.status(data.status || 400).json({ message: data.error });
      io.emit('scan-update', { orderNumber, message: '박스 정보가 업데이트되었습니다.' });
      res.json({ message: '박스 정보가 성공적으로 수정되었습니다.' });
    } catch (e) {
      console.error('[rk] scan/updateBox:', e);
      res.status(500).json({ message: '박스 정보 수정 중 오류가 발생했습니다.' });
    }
  });

  return router;
};
