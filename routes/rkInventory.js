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

// 엑셀 업로드 (SKU ID 기준 upsert: 있으면 상품명/바코드/상태 갱신, 없으면 삽입)
// 기존 행의 수량/위치는 보존 (엑셀업로드2/위치저장으로 관리)
router.post('/api/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 'A' });
    const dataRows = data.slice(1);

    // 기존 SKU/바코드 → id 매핑 (바코드도 unique 제약이 있어 함께 매칭)
    const existing = await fetchAll(() => sb.from('rk_inventories').select('id, sku_id, barcode'));
    const bySku = new Map();
    const byBarcode = new Map();
    for (const x of existing) {
      if (x.sku_id != null && x.sku_id !== '') bySku.set(String(x.sku_id), x.id);
      if (x.barcode != null && x.barcode !== '') byBarcode.set(String(x.barcode), x.id);
    }

    const now = new Date().toISOString();
    const seenSku = new Set();      // 파일 내 중복 SKU 방지 (첫 행 우선)
    const seenBarcode = new Set();  // 파일 내 중복 바코드 방지
    const toInsert = [];
    const toUpdate = [];
    for (const row of dataRows) {
      const skuId = row['A'] != null ? String(row['A']).trim() : '';
      if (!skuId || seenSku.has(skuId)) continue;
      seenSku.add(skuId);
      const barcode = row['D'] != null ? String(row['D']).trim() : '';
      const fields = { name: row['C'] || '', barcode, order_status: row['E'] || '' };
      // 기존 매칭: SKU 우선, 없으면 바코드
      const existId = bySku.has(skuId) ? bySku.get(skuId) : (barcode ? byBarcode.get(barcode) : undefined);
      if (existId != null) {
        toUpdate.push({ id: existId, fields });
      } else {
        if (barcode && seenBarcode.has(barcode)) continue; // 파일 내 바코드 중복 skip
        if (barcode) seenBarcode.add(barcode);
        toInsert.push({
          mongo_id: `inv_${skuId}_${Date.now()}_${toInsert.length}`,
          sku_id: skuId, ...fields, quantity: '-', location: '-', last_update: now,
        });
      }
    }

    // 신규 삽입 (배치 → 실패 시 해당 배치만 개별 삽입, 중복은 skip)
    let added = 0, skipped = 0;
    const BATCH = 1000;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      const { error } = await sb.from('rk_inventories').insert(chunk);
      if (!error) { added += chunk.length; continue; }
      // 배치 실패(주로 중복 제약) → 한 건씩 재시도
      for (const row of chunk) {
        const { error: e1 } = await sb.from('rk_inventories').insert(row);
        if (e1) { skipped++; } else { added++; }
      }
    }

    // 기존 갱신 (수량/위치는 건드리지 않음). 건별 순차 대신 병렬 청크(40)로 처리 → 대량도 빠름.
    // (id 기준 배치 upsert는 barcode unique 제약과 충돌해 사용 불가)
    let updated = 0;
    const CONC = 40; // 동시 실행 수 (커넥션 과부하 방지)
    for (let i = 0; i < toUpdate.length; i += CONC) {
      const chunk = toUpdate.slice(i, i + CONC);
      const results = await Promise.all(chunk.map((u) =>
        sb.from('rk_inventories').update({ ...u.fields, last_update: now }).eq('id', u.id)
          .then((r) => (r.error ? 'err' : 'ok')).catch(() => 'err')
      ));
      updated += results.filter((x) => x === 'ok').length;
      skipped += results.filter((x) => x === 'err').length;
    }

    res.json({
      success: true,
      message: `재고 데이터 업로드 완료 (신규 ${added}건, 갱신 ${updated}건${skipped ? `, 건너뜀 ${skipped}건` : ''})`,
      added, updated, skipped,
    });
  } catch (e) {
    console.error('[rk] inventory/upload:', e);
    res.status(500).json({ error: '재고 데이터 업로드 중 오류가 발생했습니다.' });
  }
});

// 청크 업로드 (클라이언트가 파싱한 행을 나눠 전송 → 진행률 표시 + write 최소화)
// body: { rows:[{skuId,name,barcode,orderStatus}] }  → 실제로 바뀐 행만 update, 나머지는 unchanged로 skip
router.post('/api/inventory/upload-chunk', async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const now = new Date().toISOString();
    // 파일 내 중복 SKU 제거 + 정리
    const items = [];
    const seenSku = new Set();
    for (const r of rows) {
      const skuId = String(r.skuId == null ? '' : r.skuId).trim();
      if (!skuId || seenSku.has(skuId)) continue;
      seenSku.add(skuId);
      items.push({
        skuId,
        name: String(r.name == null ? '' : r.name),
        barcode: String(r.barcode == null ? '' : r.barcode).trim(),
        order_status: String(r.orderStatus == null ? '' : r.orderStatus),
      });
    }
    if (!items.length) return res.json({ added: 0, updated: 0, unchanged: 0, skipped: 0 });

    // 이 청크 범위의 기존 데이터만 조회 (SKU·바코드 in) — 전체조회 대신 필요분만
    const skus = items.map((i) => i.skuId);
    const bcs = items.map((i) => i.barcode).filter(Boolean);
    const existing = [];
    for (let i = 0; i < skus.length; i += 200) {
      const { data, error } = await sb.from('rk_inventories').select('id, sku_id, barcode, name, order_status').in('sku_id', skus.slice(i, i + 200));
      if (error) throw error;
      existing.push(...(data || []));
    }
    for (let i = 0; i < bcs.length; i += 200) {
      const { data, error } = await sb.from('rk_inventories').select('id, sku_id, barcode, name, order_status').in('barcode', bcs.slice(i, i + 200));
      if (error) throw error;
      existing.push(...(data || []));
    }
    const bySku = new Map();
    const byBarcode = new Map();
    for (const x of existing) {
      if (x.sku_id != null && x.sku_id !== '') bySku.set(String(x.sku_id), x);
      if (x.barcode != null && x.barcode !== '') byBarcode.set(String(x.barcode), x);
    }

    const toInsert = [];
    const toUpdate = [];
    const seenBarcode = new Set();
    let unchanged = 0, skipped = 0;
    for (const it of items) {
      const cur = bySku.get(it.skuId) || (it.barcode ? byBarcode.get(it.barcode) : null);
      if (cur) {
        // 값이 완전히 같으면 write 하지 않음 (효율화 핵심)
        if ((cur.name || '') === it.name && (cur.barcode || '') === it.barcode && (cur.order_status || '') === it.order_status) {
          unchanged++;
          continue;
        }
        toUpdate.push({ id: cur.id, fields: { name: it.name, barcode: it.barcode, order_status: it.order_status } });
      } else {
        if (it.barcode && seenBarcode.has(it.barcode)) { skipped++; continue; }
        if (it.barcode) seenBarcode.add(it.barcode);
        toInsert.push({
          mongo_id: `inv_${it.skuId}_${Date.now()}_${toInsert.length}`,
          sku_id: it.skuId, name: it.name, barcode: it.barcode, order_status: it.order_status,
          quantity: '-', location: '-', last_update: now,
        });
      }
    }

    // 신규 삽입 (배치 → 실패 시 개별 재시도)
    let added = 0;
    const BATCH = 1000;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      const { error } = await sb.from('rk_inventories').insert(chunk);
      if (!error) { added += chunk.length; continue; }
      for (const row of chunk) {
        const { error: e1 } = await sb.from('rk_inventories').insert(row);
        if (e1) skipped++; else added++;
      }
    }
    // 변경분만 갱신 (병렬)
    let updated = 0;
    const CONC = 40;
    for (let i = 0; i < toUpdate.length; i += CONC) {
      const chunk = toUpdate.slice(i, i + CONC);
      const results = await Promise.all(chunk.map((u) =>
        sb.from('rk_inventories').update({ ...u.fields, last_update: now }).eq('id', u.id)
          .then((r) => (r.error ? 'err' : 'ok')).catch(() => 'err')
      ));
      updated += results.filter((x) => x === 'ok').length;
      skipped += results.filter((x) => x === 'err').length;
    }

    res.json({ added, updated, unchanged, skipped });
  } catch (e) {
    console.error('[rk] inventory/upload-chunk:', e);
    res.status(500).json({ error: '청크 업로드 오류: ' + e.message });
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

// 상품관리 → rk_stocks 위치 저장 (배치). 수량은 NULL로 저장.
// 같은 (바코드+위치)가 이미 있으면 건너뜀. body: { location, items:[{barcode, skuId, itemName}] }
router.post('/api/inventory/save-stock-location', async (req, res) => {
  try {
    const location = String(req.body.location || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!location) return res.status(400).json({ error: '위치가 입력되지 않았습니다.' });
    // 바코드 정리(중복 제거)
    const byBarcode = new Map();
    for (const it of items) {
      const bc = String(it.barcode || '').trim();
      if (!bc) continue;
      if (!byBarcode.has(bc)) byBarcode.set(bc, { barcode: bc, skuId: it.skuId || null, itemName: it.itemName || null });
    }
    const barcodes = [...byBarcode.keys()];
    if (!barcodes.length) return res.status(400).json({ error: '바코드가 있는 항목이 없습니다.' });

    // 이미 (바코드+위치)로 존재하는 것 조회 (배치)
    const existSet = new Set();
    for (let i = 0; i < barcodes.length; i += 200) {
      const { data, error } = await sb.from('rk_stocks')
        .select('barcode').eq('location', location).in('barcode', barcodes.slice(i, i + 200));
      if (error) throw error;
      for (const r of (data || [])) existSet.add(r.barcode);
    }

    // 없는 것만 insert (qty = NULL)
    const rows = [];
    for (const bc of barcodes) {
      if (existSet.has(bc)) continue;
      const m = byBarcode.get(bc);
      rows.push({ barcode: bc, location, qty: null, sku_id: m.skuId || null, item_name: m.itemName || null });
    }
    let saved = 0;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await sb.from('rk_stocks').insert(rows.slice(i, i + BATCH));
      if (error) throw error;
      saved += rows.slice(i, i + BATCH).length;
    }
    res.json({ ok: true, saved, skipped: barcodes.length - saved });
  } catch (e) {
    console.error('[rk] inventory/save-stock-location:', e);
    res.status(500).json({ error: '위치 저장 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
