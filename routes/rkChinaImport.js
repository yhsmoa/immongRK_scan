/**
 * 중국입고 도메인 — Supabase 전환 (rk_china_imports)
 * organize 의 할당 로직은 원본 그대로 유지, DB 읽기/쓰기만 rk_* 로 교체.
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;

function chinaToKorean(r, withId) {
  const o = {
    shipmentCode: r.shipment_code, pallet: r.pallet, boxName: r.box_name, orderNumber: r.order_number,
    productName: r.product_name, quantity: r.quantity, barcode: r.barcode,
    availableOrders: r.available_orders, shippingDate: r.shipping_date,
  };
  if (withId) o._id = r.mongo_id;
  return o;
}
function chinaToRow(x, idx) {
  return {
    mongo_id: `ci_${x.shipmentCode || ''}_${x.barcode || ''}_${idx}_${Date.now()}`,
    shipment_code: x.shipmentCode || '', pallet: x.pallet ?? null, box_name: x.boxName ?? null,
    order_number: x.orderNumber ?? null, product_name: x.productName ?? null, quantity: x.quantity ?? null,
    barcode: x.barcode ?? null, available_orders: x.availableOrders ?? null, shipping_date: x.shippingDate ?? null,
  };
}
async function fetchAllChina() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('rk_china_imports').select('*').order('id', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}
async function insertChina(list) {
  const rows = list.map((x, i) => chinaToRow(x, i));
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb.from('rk_china_imports').insert(rows.slice(i, i + BATCH));
    if (error) throw error;
  }
}

// 업로드 (Sheet3, BR 박스만, 동일 shipmentCode 삭제 후 삽입)
router.post('/api/importChina/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: '파일이 업로드되지 않았습니다.' });
    const shipmentCode = req.body.shipmentCode;
    if (!shipmentCode) return res.status(400).json({ message: '출고코드가 입력되지 않았습니다.' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    if (!workbook.SheetNames.includes('Sheet3')) return res.status(400).json({ message: 'Sheet3를 찾을 수 없습니다.' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets['Sheet3'], { header: 'A' });
    const filteredData = data.filter((row) => { const b = row['B']; return b && b.toString().startsWith('BR'); });

    await sb.from('rk_china_imports').delete().eq('shipment_code', shipmentCode);
    const importData = filteredData.map((row) => ({
      shipmentCode, pallet: row['A'] || '', boxName: row['B'] || '', orderNumber: row['C'] || '',
      productName: row['H'] || '', quantity: row['J'] ? row['J'].toString() : '0', barcode: row['K'] || '',
    }));
    await insertChina(importData);
    res.json({ message: '파일이 성공적으로 업로드되었습니다.', count: filteredData.length });
  } catch (e) {
    console.error('[rk] importChina/upload:', e);
    res.status(500).json({ message: '파일 처리 중 오류가 발생했습니다.' });
  }
});

// 조회 (/data: boxName 정렬)
router.get('/api/importChina/data', async (req, res) => {
  try {
    const rows = await fetchAllChina();
    rows.sort((a, b) => String(a.box_name || '').localeCompare(String(b.box_name || '')));
    res.json(rows.map((r) => chinaToKorean(r, true)));
  } catch (e) {
    console.error('[rk] importChina/data:', e);
    res.status(500).json({ message: '데이터 조회 중 오류가 발생했습니다.' });
  }
});

// 조회 (/api/importChina: boxName,barcode 정렬, _id 제외)
router.get('/api/importChina', async (req, res) => {
  try {
    const rows = await fetchAllChina();
    rows.sort((a, b) => String(a.box_name || '').localeCompare(String(b.box_name || '')) || String(a.barcode || '').localeCompare(String(b.barcode || '')));
    res.json(rows.map((r) => chinaToKorean(r, false)));
  } catch (e) {
    console.error('[rk] importChina:', e);
    res.status(500).json({ error: '데이터 조회 중 오류가 발생했습니다.' });
  }
});

// 삭제 (shipmentCode)
router.delete('/api/importChina/delete/:shipmentCode', async (req, res) => {
  try {
    const { error } = await sb.from('rk_china_imports').delete().eq('shipment_code', req.params.shipmentCode);
    if (error) throw error;
    res.json({ message: '데이터가 성공적으로 삭제되었습니다.' });
  } catch (e) {
    console.error('[rk] importChina/delete:', e);
    res.status(500).json({ message: '데이터 삭제 중 오류가 발생했습니다.' });
  }
});

// 출고예정 업데이트
router.post('/api/importChina/updateAvailableOrders', async (req, res) => {
  try {
    const { shipmentCode, barcode, availableOrders } = req.body;
    if (!shipmentCode || !barcode) return res.status(400).json({ error: '필수 데이터가 누락되었습니다.' });
    const { data, error } = await sb.from('rk_china_imports')
      .update({ available_orders: availableOrders }).eq('shipment_code', shipmentCode).eq('barcode', barcode).select('id');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: '해당 데이터를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (e) {
    console.error('[rk] importChina/updateAvailableOrders:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 발주서 정리 (원본 할당 로직 유지)
router.post('/api/importChina/organize', async (req, res) => {
  try {
    const allChinaImports = (await fetchAllChina()).map((r) => chinaToKorean(r, false));

    const originalChinaImports = allChinaImports.filter((item) => {
      const a = item.availableOrders || '';
      return !a || !a.match(/^\d+-.*-\d+$/);
    });
    const processedShipmentData = allChinaImports.filter((item) => {
      const a = item.availableOrders || '';
      return a && a.match(/^\d+-.*-\d+$/);
    });

    const existingShipmentMap = new Map();
    processedShipmentData.forEach((item) => {
      const barcode = item.barcode;
      const match = (item.availableOrders || '').match(/^(\d+)-.*-(\d+)$/);
      if (match) {
        const orderNumber = match[1];
        const quantity = parseInt(match[2]) || 0;
        if (!existingShipmentMap.has(barcode)) existingShipmentMap.set(barcode, new Map());
        const bm = existingShipmentMap.get(barcode);
        bm.set(orderNumber, (bm.get(orderNumber) || 0) + quantity);
      }
    });

    const uniqueBarcodes = [...new Set(originalChinaImports.map((item) => item.barcode))];
    const allOrders = await S.listOrdersFull('rk_orders', 'rk_order_items');
    const orders = allOrders.filter((o) => (o.상품정보 || []).some((p) => uniqueBarcodes.includes(p.상품바코드)));

    const orderProductMap = new Map();
    let newShipmentCount = 0;
    orders.forEach((order) => {
      order.상품정보.forEach((product) => {
        if (!product.상품바코드 || product.박스정보) return;
        if (!orderProductMap.has(product.상품바코드)) orderProductMap.set(product.상품바코드, []);
        const 스캔수량 = parseInt(product.스캔수량) || 0;
        const 입고1 = product.입고1 && product.입고1 !== '-' ? parseInt(product.입고1) || 0 : 0;
        const 입고2 = product.입고2 && product.입고2 !== '-' ? parseInt(product.입고2) || 0 : 0;
        const totalAvailableQuantity = product.확정수량 - 스캔수량 - 입고1 - 입고2;
        const existingQuantity = existingShipmentMap.has(product.상품바코드) && existingShipmentMap.get(product.상품바코드).has(order.발주번호)
          ? existingShipmentMap.get(product.상품바코드).get(order.발주번호) : 0;
        const neededQuantity = Math.max(0, totalAvailableQuantity - existingQuantity);
        if (neededQuantity > 0) {
          orderProductMap.get(product.상품바코드).push({
            order: { 발주번호: order.발주번호, 물류센터: order.물류센터, 입고예정일: order.입고예정일 },
            product, availableQuantity: neededQuantity,
          });
        }
      });
    });

    const finalResults = [...processedShipmentData];
    for (const chinaImport of originalChinaImports) {
      const barcode = chinaImport.barcode;
      const totalQuantity = parseInt(chinaImport.quantity) || 0;
      if (!orderProductMap.has(barcode) || orderProductMap.get(barcode).length === 0) {
        finalResults.push({
          shipmentCode: chinaImport.shipmentCode, pallet: chinaImport.pallet, boxName: chinaImport.boxName,
          orderNumber: chinaImport.orderNumber, productName: chinaImport.productName, quantity: chinaImport.quantity,
          barcode, availableOrders: chinaImport.availableOrders || '',
        });
        continue;
      }
      const matchingEntries = [...orderProductMap.get(barcode)].sort((a, b) => new Date(a.order.입고예정일) - new Date(b.order.입고예정일));
      let remainingQuantity = totalQuantity;
      let allocatedQuantity = 0;
      for (const entry of matchingEntries) {
        if (remainingQuantity <= 0) break;
        const assignQuantity = Math.min(remainingQuantity, entry.availableQuantity);
        if (assignQuantity > 0) {
          finalResults.push({
            shipmentCode: chinaImport.shipmentCode, pallet: chinaImport.pallet, boxName: chinaImport.boxName,
            orderNumber: chinaImport.orderNumber, productName: chinaImport.productName, quantity: chinaImport.quantity,
            barcode, availableOrders: `${entry.order.발주번호}-${entry.order.물류센터}-${assignQuantity}`, shippingDate: entry.order.입고예정일 || '',
          });
          newShipmentCount++;
          entry.availableQuantity -= assignQuantity;
          remainingQuantity -= assignQuantity;
          allocatedQuantity += assignQuantity;
        }
      }
      const finalQuantity = totalQuantity - allocatedQuantity;
      if (finalQuantity > 0) {
        finalResults.push({
          shipmentCode: chinaImport.shipmentCode, pallet: chinaImport.pallet, boxName: chinaImport.boxName,
          orderNumber: chinaImport.orderNumber, productName: chinaImport.productName, quantity: finalQuantity.toString(),
          barcode, availableOrders: chinaImport.availableOrders || '', shippingDate: chinaImport.shippingDate || '',
        });
      }
    }

    await sb.from('rk_china_imports').delete().not('id', 'is', null);
    if (finalResults.length > 0) await insertChina(finalResults);
    console.log(`[rk] CN 입고 정리 완료: 총 ${finalResults.length}개, 새 출고 ${newShipmentCount}개`);
    res.json(finalResults);
  } catch (e) {
    console.error('[rk] importChina/organize:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
