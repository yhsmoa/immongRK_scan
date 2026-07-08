/**
 * 발주서 도메인 - 엑셀 내보내기 & 중국입고 연동(입고1/2) — Supabase 전환
 * XlsxPopulate 생성 로직은 원본 그대로 유지, 데이터 소스만 rk_* 로 교체.
 */
const express = require('express');
const XlsxPopulate = require('xlsx-populate');
const S = require('./rkShared');

const router = express.Router();

// 스캔된(헤더 스캔수량>0) 발주서만, orderNumbers 지정 시 해당만
async function scannedOrders(orderNumbers) {
  const all = await S.listOrdersFull('rk_orders', 'rk_order_items');
  const has = Array.isArray(orderNumbers) && orderNumbers.length > 0;
  return all.filter((o) => (!has || orderNumbers.includes(o.발주번호)) && o.스캔수량 > 0);
}

// ── 쉽먼트 내보내기 ──
router.post('/api/shipment/export', async (req, res) => {
  try {
    const { orderNumbers, invoiceNumbers } = req.body;
    const orders = await scannedOrders(orderNumbers);

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
    orders.forEach((order) => {
      const scannedProducts = order.상품정보.filter((p) => p.스캔수량 > 0 && p.박스정보 && p.박스정보 !== '-');
      scannedProducts.forEach((product) => {
        const boxNumber = product.박스정보.split('-')[0];
        const invoiceNumber = (invoiceNumbers && invoiceNumbers[order.발주번호]?.[boxNumber]) || '';
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
  } catch (e) {
    console.error('[rk] shipment/export:', e);
    res.status(500).json({ error: '데이터 내보내기에 실패했습니다.' });
  }
});

// ── CJ 운송장 내보내기 ──
router.post('/api/shipment/export-cj', async (req, res) => {
  try {
    const { orderNumbers } = req.body;
    const orders = await scannedOrders(orderNumbers);

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
          cjData.push({ 물류센터: order.물류센터, 연락처: centerInfo?.contact || '', 주소: centerInfo?.address || '', 박스타입: boxType, 발주번호: `${order.발주번호} - ${boxNumber}` });
        }
      });
    });

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
  } catch (e) {
    console.error('[rk] shipment/export-cj:', e);
    res.status(500).json({ error: 'CJ 엑셀 다운로드에 실패했습니다.' });
  }
});

// ── 발주리스트 확정 내보내기 ──
router.post('/api/orders/export', async (req, res) => {
  try {
    const { orderNumbers } = req.body;
    const all = await S.listOrdersFull('rk_orders', 'rk_order_items');
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
