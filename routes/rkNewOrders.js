/**
 * 신규 발주서 도메인 — Supabase 전환 (rk_new_orders / rk_new_order_items)
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const XlsxPopulate = require('xlsx-populate');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// 엑셀 숫자 파싱: 천단위 콤마(예: "6,300") 제거 후 숫자화. parseFloat 콤마 절단 방지.
const num = (v) => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;

// 신규발주서 목록 (원본은 dedup 없이 그대로 반환)
router.get('/api/neworders', async (req, res) => {
  try {
    res.json(await S.listOrdersFull('rk_new_orders', 'rk_new_order_items'));
  } catch (e) {
    console.error('[rk] neworders 목록:', e);
    res.status(500).json({ error: '신규 발주서 목록을 불러오는데 실패했습니다.' });
  }
});

// 신규발주서 엑셀 업로드
router.post('/api/neworder/upload', upload.single('file'), async (req, res) => {
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
        groupedData[orderNumber] = { 발주번호: orderNumber, 입고예정일: row['U'] || '', 물류센터: row['B'] || '', 상품수: 0, 발주수량: 0, 확정수량: 0, 스캔수량: 0, 상품정보: [] };
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

    const { added, duplicates } = await S.insertKoreanOrders('rk_new_orders', 'rk_new_order_items', Object.values(groupedData), 'nup');
    let message = '';
    if (added.length > 0) message += `${added.length}개의 신규발주서가 추가되었습니다.`;
    if (duplicates.length > 0) message += `\n다음 발주서는 이미 존재합니다:\n${duplicates.join(', ')}`;
    res.json({ message, added: added.length, duplicates });
  } catch (e) {
    console.error('[rk] neworder/upload:', e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다.' });
  }
});

// 삭제 (비밀번호)
router.post('/api/neworders/delete', async (req, res) => {
  try {
    const { orderNumbers, password } = req.body;
    if (password !== 'djajskek1!') return res.status(403).json({ error: '패스워드가 올바르지 않습니다.' });
    const { error } = await S.supabase.from('rk_new_orders').delete().in('order_number', orderNumbers || []);
    if (error) throw error;
    res.json({ message: '발주서가 성공적으로 삭제되었습니다.' });
  } catch (e) {
    console.error('[rk] neworders/delete:', e);
    res.status(500).json({ error: '신규 발주서 삭제에 실패했습니다.' });
  }
});

// 위치 수정 (단건)
router.post('/api/neworders/update-location', async (req, res) => {
  try {
    const { orderNumber, barcode, location } = req.body;
    const orderId = await S.getOrderId('rk_new_orders', orderNumber);
    if (!orderId) return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
    const { data, error } = await S.supabase.from('rk_new_order_items')
      .update({ location }).eq('order_id', orderId).eq('barcode', barcode).is('box_info', null).select('id');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (e) {
    console.error('[rk] neworders/update-location:', e);
    res.status(500).json({ error: '위치 정보 업데이트 중 오류가 발생했습니다.' });
  }
});

// 위치 일괄 수정
router.post('/api/neworders/batch-update-location', async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) return res.status(400).json({ error: '업데이트할 데이터가 없습니다.' });
    let successCount = 0;
    const orderIds = {};
    for (const u of updates) {
      if (!(u.orderNumber in orderIds)) orderIds[u.orderNumber] = await S.getOrderId('rk_new_orders', u.orderNumber);
      const oid = orderIds[u.orderNumber];
      if (!oid) continue;
      const { data } = await S.supabase.from('rk_new_order_items')
        .update({ location: u.location }).eq('order_id', oid).eq('barcode', u.barcode).is('box_info', null).select('id');
      if (data && data.length) successCount += data.length;
    }
    res.json({ success: true, updated: successCount });
  } catch (e) {
    console.error('[rk] neworders/batch-update-location:', e);
    res.status(500).json({ error: '배치 위치 정보 업데이트 중 오류가 발생했습니다.' });
  }
});

// 등록 (신규 → 전체, RPC)
router.post('/api/neworders/register', async (req, res) => {
  try {
    const { orderNumbers } = req.body;
    if (!Array.isArray(orderNumbers) || orderNumbers.length === 0)
      return res.status(400).json({ message: '등록할 발주서가 선택되지 않았습니다.' });
    const { data, error } = await S.supabase.rpc('rk_register_neworders', { p_order_numbers: orderNumbers });
    if (error) throw error;
    const registered = data.registered || 0;
    const duplicates = data.duplicates || 0;
    let message = '';
    if (registered > 0) message += `${registered}개의 발주서가 성공적으로 등록되었습니다.`;
    if (duplicates > 0) message += `\n${duplicates}개의 발주서는 이미 존재합니다.`;
    res.json({ message, registered, duplicates, errors: [] });
  } catch (e) {
    console.error('[rk] neworders/register:', e);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// 신규발주 내보내기
router.post('/api/neworders/export', async (req, res) => {
  try {
    const { orderNumbers } = req.body;
    const all = await S.listOrdersFull('rk_new_orders', 'rk_new_order_items');
    const has = Array.isArray(orderNumbers) && orderNumbers.length > 0;
    const orders = all.filter((o) => !has || orderNumbers.includes(o.발주번호));

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
        exportData.push({
          발주번호: order.발주번호, 물류센터: order.물류센터, 입고유형: product.입고유형 || '', 발주상태: product.발주상태 || '',
          상품번호: product.상품번호, 상품바코드: product.상품바코드, 상품이름: product.상품이름,
          발주수량: product.발주수량, 확정수량: product.스캔수량 || 0,
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
    mainSheet.name('신규발주리스트');
    const hiddenSheet = workbook.addSheet('hiddenSheet');
    dropdownOptions.forEach((option, index) => { hiddenSheet.cell(index + 1, 1).value(option); });

    const headers = ['발주번호', '물류센터', '입고유형', '발주상태', '상품번호', '상품바코드', '상품이름', '발주수량', '확정수량', '유통(소비)기한',
      '제조일자', '생산년도', '납품부족사유', '회송담당자', '회송담당자 연락처', '회송지주소', '매입가', '공급가', '부가세', '총발주 매입금',
      '입고예정일', '발주등록일시', '입고1', '입고2', '위치'];
    headers.forEach((header, index) => { mainSheet.cell(1, index + 1).value(header); });

    exportData.forEach((row, rowIndex) => {
      Object.values(row).forEach((value, colIndex) => { mainSheet.cell(rowIndex + 2, colIndex + 1).value(value); });
    });

    const lastRow = exportData.length + 1;
    mainSheet.range(`M2:M${lastRow}`).dataValidation({ type: 'list', formula1: 'hiddenSheet!$A$1:$A$20', allowBlank: true });
    hiddenSheet.hidden(true);

    let filename;
    if (orderNumbers && orderNumbers.length === 1) filename = `신규발주리스트 (${orderNumbers[0]}).xlsx`;
    else if (orderNumbers && orderNumbers.length > 1) filename = `신규발주리스트 (${orderNumbers[0]} 외 ${orderNumbers.length - 1}건).xlsx`;
    else filename = '신규발주리스트 (전체).xlsx';

    const buffer = await workbook.outputAsync();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    console.error('[rk] neworders/export:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
