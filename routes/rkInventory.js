/**
 * 재고 도메인 — Supabase 전환 (rk_inventories)
 * generate-discontinue-doc / parse-excel 은 DB 미사용 → 기존 라우트로 통과.
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;

// SQL → Mongo(inventory) 형태 복원
function invToKorean(r) {
  return {
    _id: r.mongo_id,
    skuId: S.str(r.sku_id),
    name: S.str(r.name),
    barcode: S.str(r.barcode),
    orderStatus: S.str(r.order_status),
    quantity: r.quantity == null ? '-' : r.quantity,
    location: r.location == null ? '-' : r.location,
    lastUpdate: r.last_update,
  };
}

// 페이지네이션 조회 (쿼리 빌더 팩토리를 받아 1000행씩)
async function fetchAll(buildQuery) {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// 재고 목록 (전체)
router.get('/api/inventory/list', async (req, res) => {
  try {
    const rows = await fetchAll(() => sb.from('rk_inventories').select('*').order('id', { ascending: true }));
    res.json(rows.map(invToKorean));
  } catch (e) {
    console.error('[rk] inventory/list:', e);
    res.status(500).json({ error: '재고 목록을 불러오는 중 오류가 발생했습니다.' });
  }
});

// 엑셀 업로드 (skuId 중복 제외 삽입, quantity/location='-')
router.post('/api/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 'A' });
    const dataRows = data.slice(1);

    const existing = await fetchAll(() => sb.from('rk_inventories').select('sku_id'));
    const existingSku = new Set(existing.map((x) => x.sku_id));

    const toInsert = [];
    for (const row of dataRows) {
      const skuId = row['A'] || '';
      if (skuId && !existingSku.has(skuId)) {
        toInsert.push({
          mongo_id: `inv_${skuId}_${Date.now()}_${toInsert.length}`,
          sku_id: skuId, name: row['C'] || '', barcode: row['D'] || '', order_status: row['E'] || '',
          quantity: '-', location: '-', last_update: new Date().toISOString(),
        });
        existingSku.add(skuId);
      }
    }
    const BATCH = 1000;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const { error } = await sb.from('rk_inventories').insert(toInsert.slice(i, i + BATCH));
      if (error) throw error;
    }
    res.json({ success: true, message: '재고 데이터가 성공적으로 업로드되었습니다.', added: toInsert.length });
  } catch (e) {
    console.error('[rk] inventory/upload:', e);
    res.status(500).json({ error: '재고 데이터 업로드 중 오류가 발생했습니다.' });
  }
});

// 선택 삭제
router.post('/api/inventory/delete-selected', async (req, res) => {
  try {
    const { skuIds } = req.body;
    if (!Array.isArray(skuIds) || skuIds.length === 0) return res.status(400).json({ error: '삭제할 항목이 선택되지 않았습니다.' });
    const { error } = await sb.from('rk_inventories').delete().in('sku_id', skuIds);
    if (error) throw error;
    res.json({ success: true, message: '선택된 재고 데이터가 성공적으로 삭제되었습니다.' });
  } catch (e) {
    console.error('[rk] inventory/delete-selected:', e);
    res.status(500).json({ error: '재고 데이터 삭제 중 오류가 발생했습니다.' });
  }
});

// 검색 (발주상태 필터 + 콤마구분 검색어 → sku/barcode/name ilike)
router.post('/api/inventory/search', async (req, res) => {
  try {
    const { orderStatus, searchTerm } = req.body;
    const terms = (searchTerm || '').split(',').map((t) => t.trim()).filter(Boolean);
    const rows = await fetchAll(() => {
      let q = sb.from('rk_inventories').select('*').order('id', { ascending: true });
      if (orderStatus) q = q.eq('order_status', orderStatus);
      if (terms.length) {
        const ors = terms.flatMap((t) => {
          const v = t.replace(/[,()]/g, ' '); // .or 문법 깨짐 방지
          return [`sku_id.ilike.%${v}%`, `barcode.ilike.%${v}%`, `name.ilike.%${v}%`];
        }).join(',');
        q = q.or(ors);
      }
      return q;
    });
    res.json(rows.map(invToKorean));
  } catch (e) {
    console.error('[rk] inventory/search:', e);
    res.status(500).json({ error: '재고 검색 중 오류가 발생했습니다.' });
  }
});

// 로케이션 수정 (sku 단건)
router.post('/api/inventory/update-location', async (req, res) => {
  try {
    const { skuId, location } = req.body;
    if (!skuId) return res.status(400).json({ error: 'SKU ID가 필요합니다.' });
    const { data, error } = await sb.from('rk_inventories').update({ location }).eq('sku_id', skuId).select('id');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: '해당 SKU ID를 찾을 수 없습니다.' });
    res.json({ success: true, message: '로케이션이 성공적으로 업데이트되었습니다.' });
  } catch (e) {
    console.error('[rk] inventory/update-location:', e);
    res.status(500).json({ error: '로케이션 업데이트 중 오류가 발생했습니다.' });
  }
});

// 바코드 → 위치 조회 (rocket/newOrder '위치 불러오기'). 200개씩 배치.
router.post('/api/inventory/locations', async (req, res) => {
  try {
    const { barcodes } = req.body;
    if (!Array.isArray(barcodes) || barcodes.length === 0) return res.status(400).json({ error: '바코드 목록이 제공되지 않았습니다.' });
    const out = [];
    const BATCH = 200;
    for (let i = 0; i < barcodes.length; i += BATCH) {
      const chunk = barcodes.slice(i, i + BATCH);
      const { data, error } = await sb.from('rk_inventories').select('barcode, location').in('barcode', chunk);
      if (error) throw error;
      data.forEach((item) => out.push({ barcode: item.barcode, location: item.location || '-' }));
    }
    res.json(out);
  } catch (e) {
    console.error('[rk] inventory/locations:', e);
    res.status(500).json({ error: '위치 정보 조회 중 오류가 발생했습니다.' });
  }
});

// 바코드-로케이션 일괄 업로드
router.post('/api/inventory/upload-locations', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '업로드할 데이터가 없습니다.' });
    let updated = 0;
    for (const item of items) {
      if (!item.barcode || !item.location) continue;
      const { data, error } = await sb.from('rk_inventories').update({ location: item.location }).eq('barcode', item.barcode).select('id');
      if (error) throw error;
      updated += (data ? data.length : 0);
    }
    res.json({ success: true, message: '위치 정보가 성공적으로 업데이트되었습니다.', updated });
  } catch (e) {
    console.error('[rk] inventory/upload-locations:', e);
    res.status(500).json({ error: '위치 정보 업로드 중 오류가 발생했습니다.' });
  }
});

// 직접 등록 (sku/barcode 중복 체크)
router.post('/api/inventory/register', async (req, res) => {
  try {
    const { skuId, name, barcode, orderStatus, quantity, location } = req.body;
    if (!name || !barcode) return res.status(400).json({ success: false, error: '상품명과 바코드는 필수 입력 항목입니다.' });

    const ors = [];
    if (skuId) ors.push(`sku_id.eq.${skuId}`);
    if (barcode) ors.push(`barcode.eq.${barcode}`);
    const { data: existing } = await sb.from('rk_inventories').select('sku_id, barcode').or(ors.join(',')).limit(1);
    if (existing && existing.length) {
      const msg = existing[0].sku_id === skuId ? '이미 등록된 SKU ID입니다.' : '이미 등록된 바코드입니다.';
      return res.status(400).json({ success: false, error: msg });
    }

    const row = {
      mongo_id: `invreg_${barcode}_${Date.now()}`,
      sku_id: skuId || null, name, barcode, order_status: orderStatus || '정상',
      quantity: quantity || '-', location: location || '-', last_update: new Date().toISOString(),
    };
    const { data, error } = await sb.from('rk_inventories').insert(row).select('*').single();
    if (error) throw error;
    res.json({ success: true, message: '상품이 성공적으로 등록되었습니다.', item: invToKorean(data) });
  } catch (e) {
    console.error('[rk] inventory/register:', e);
    res.status(500).json({ success: false, error: '상품 등록 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
