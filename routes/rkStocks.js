/**
 * 재고관리 도메인 — Supabase (rk_stocks / rk_stock_histories)
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const XlsxPopulate = require('xlsx-populate');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;

// 업로드/양식 공통 헤더
const TEMPLATE_HEADERS = ['위치', '상품번호', '바코드', '상품명', '수량', '시즌', '비고'];

// SQL row → 화면용 객체
function stockToKorean(r) {
  return {
    id: r.id,
    location: r.location,
    skuId: r.sku_id,
    barcode: r.barcode,
    itemName: r.item_name,
    qty: r.qty,
    season: r.season,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 1000행 제한 우회 조회
async function fetchAllStocks() {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await sb
      .from('rk_stocks').select('*')
      .order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// 재고 목록 (전체)
router.get('/api/stocks', async (req, res) => {
  try {
    const rows = await fetchAllStocks();
    res.json(rows.map(stockToKorean));
  } catch (e) {
    console.error('[rk] stocks 목록:', e);
    res.status(500).json({ error: '재고 목록을 불러오는데 실패했습니다.' });
  }
});

// 업로드용 엑셀 양식 다운로드
router.get('/api/stocks/template', async (req, res) => {
  try {
    const wb = await XlsxPopulate.fromBlankAsync();
    const sheet = wb.sheet(0);
    sheet.name('재고양식');
    TEMPLATE_HEADERS.forEach((h, i) => {
      sheet.cell(1, i + 1).value(h).style({ bold: true, fill: 'F1F3F6' });
    });
    // 예시 행 (참고용, 삭제하고 사용)
    ['A-01-01', 'SKU-0001', '8800000000001', '예시 상품명', 10, '2026SS', '메모(선택)']
      .forEach((v, i) => sheet.cell(2, i + 1).value(v));
    // 열 너비
    [12, 14, 16, 40, 8, 10, 20].forEach((w, i) => sheet.column(i + 1).width(w));

    const buffer = await wb.outputAsync();
    const filename = '재고업로드양식.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    console.error('[rk] stocks/template:', e);
    res.status(500).json({ error: '양식 생성 중 오류가 발생했습니다.' });
  }
});

// 재고 추가/차감 업로드 (mode: add | deduct)
// 매칭 기준: (바코드 + 위치) 조합. add 는 없으면 신규 생성, deduct 는 없으면 미매칭 처리.
router.post('/api/stocks/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    const mode = String(req.body.mode || '').toLowerCase();
    if (!['add', 'deduct'].includes(mode)) return res.status(400).json({ error: 'mode(add/deduct)가 올바르지 않습니다.' });

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = xlsx.utils.sheet_to_json(ws, { defval: '' });

    const parsed = raw.map(r => ({
      location: String(r['위치'] ?? '').trim(),
      sku_id: String(r['상품번호'] ?? '').trim(),
      barcode: String(r['바코드'] ?? '').trim(),
      item_name: String(r['상품명'] ?? '').trim(),
      qty: parseInt(r['수량'], 10),
      season: String(r['시즌'] ?? '').trim(),
      note: String(r['비고'] ?? '').trim(),
    })).filter(r => r.barcode && Number.isFinite(r.qty) && r.qty > 0);

    if (!parsed.length) {
      return res.json({ message: '처리할 유효한 행이 없습니다. (바코드/수량 확인)', updated: 0, inserted: 0, skipped: 0 });
    }

    const existing = await fetchAllStocks();
    const key = (b, l) => `${b}|${l || ''}`;
    const map = new Map(existing.map(s => [key(s.barcode, s.location), s]));

    const histories = [];
    let updated = 0, inserted = 0;
    const skipped = [];

    for (const row of parsed) {
      const k = key(row.barcode, row.location);
      const cur = map.get(k);

      if (mode === 'add') {
        if (cur) {
          const before = cur.qty || 0;
          const after = before + row.qty;
          const { error } = await sb.from('rk_stocks').update({
            qty: after,
            item_name: row.item_name || cur.item_name,
            sku_id: row.sku_id || cur.sku_id,
            season: row.season || cur.season,
            note: row.note || cur.note,
          }).eq('id', cur.id);
          if (error) throw error;
          cur.qty = after;
          histories.push({ stock_id: cur.id, sku_id: cur.sku_id, barcode: cur.barcode, location: cur.location, change_type: 'add', qty: row.qty, qty_before: before, qty_after: after, note: row.note || null });
          updated++;
        } else {
          const { data, error } = await sb.from('rk_stocks').insert({
            location: row.location || null, sku_id: row.sku_id || null, barcode: row.barcode,
            item_name: row.item_name || null, qty: row.qty, season: row.season || null, note: row.note || null,
          }).select('id').single();
          if (error) throw error;
          map.set(k, { id: data.id, barcode: row.barcode, location: row.location, qty: row.qty, sku_id: row.sku_id, item_name: row.item_name, season: row.season, note: row.note });
          histories.push({ stock_id: data.id, sku_id: row.sku_id || null, barcode: row.barcode, location: row.location || null, change_type: 'add', qty: row.qty, qty_before: 0, qty_after: row.qty, note: row.note || null });
          inserted++;
        }
      } else { // deduct
        if (cur) {
          const before = cur.qty || 0;
          const after = Math.max(0, before - row.qty); // 재고는 0 미만으로 내려가지 않음
          const actual = before - after;
          const { error } = await sb.from('rk_stocks').update({ qty: after, note: row.note || cur.note }).eq('id', cur.id);
          if (error) throw error;
          cur.qty = after;
          histories.push({ stock_id: cur.id, sku_id: cur.sku_id, barcode: cur.barcode, location: cur.location, change_type: 'deduct', qty: actual, qty_before: before, qty_after: after, note: row.note || null });
          updated++;
        } else {
          skipped.push(row.barcode);
        }
      }
    }

    if (histories.length) {
      const BATCH = 500;
      for (let i = 0; i < histories.length; i += BATCH) {
        const { error } = await sb.from('rk_stock_histories').insert(histories.slice(i, i + BATCH));
        if (error) throw error;
      }
    }

    let message = mode === 'add'
      ? `재고 추가 완료 (갱신 ${updated}건, 신규 ${inserted}건)`
      : `재고 차감 완료 (${updated}건)`;
    if (skipped.length) message += `\n미매칭 ${skipped.length}건(재고 없음): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ' 외' : ''}`;
    res.json({ message, updated, inserted, skipped: skipped.length });
  } catch (e) {
    console.error('[rk] stocks/upload:', e);
    res.status(500).json({ error: '업로드 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 위치 인라인 수정 (셀 클릭 편집)
router.patch('/api/stocks/:id/location', async (req, res) => {
  try {
    const id = req.params.id;
    const location = String(req.body.location ?? '').trim();
    if (!location) return res.status(400).json({ error: '위치를 입력하세요.' });
    const { data, error } = await sb
      .from('rk_stocks')
      .update({ location })
      .eq('id', id)
      .select('id')
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '재고를 찾을 수 없습니다.' });
    res.json({ ok: true, id: data.id, location });
  } catch (e) {
    console.error('[rk] stocks/location:', e);
    res.status(500).json({ error: '위치 수정 실패: ' + e.message });
  }
});

// 상품명 인라인 수정 — 같은 바코드가 여러 위치에 있으면 이름이 갈리지 않도록 함께 반영
router.patch('/api/stocks/:id/item-name', async (req, res) => {
  try {
    const id = req.params.id;
    const itemName = String(req.body.itemName ?? '').trim();
    if (!itemName) return res.status(400).json({ error: '상품명을 입력하세요.' });

    const { data: cur, error: findErr } = await sb
      .from('rk_stocks').select('id, barcode').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!cur) return res.status(404).json({ error: '재고를 찾을 수 없습니다.' });

    const q = sb.from('rk_stocks').update({ item_name: itemName });
    const { data, error } = cur.barcode
      ? await q.eq('barcode', cur.barcode).select('id')
      : await q.eq('id', id).select('id');
    if (error) throw error;
    res.json({ ok: true, itemName, barcode: cur.barcode, updated: (data || []).length });
  } catch (e) {
    console.error('[rk] stocks/item-name:', e);
    res.status(500).json({ error: '상품명 수정 실패: ' + e.message });
  }
});

// 재고 삭제 (체크박스 선택 → 삭제)
router.post('/api/stocks/delete', async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(x => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: '삭제할 항목이 없습니다.' });
    const { error } = await sb.from('rk_stocks').delete().in('id', ids);
    if (error) throw error;
    res.json({ ok: true, deleted: ids.length });
  } catch (e) {
    console.error('[rk] stocks/delete:', e);
    res.status(500).json({ error: '재고 삭제 실패: ' + e.message });
  }
});

// 바코드 → 상품명 조회 (재고스캔용) — rk_inventories 우선, 없으면 rk_stocks.item_name
router.post('/api/stocks/lookup', async (req, res) => {
  try {
    const barcodes = [...new Set((Array.isArray(req.body.barcodes) ? req.body.barcodes : []).map(b => String(b || '').trim()).filter(Boolean))];
    if (!barcodes.length) return res.json([]);
    const map = new Map();
    const BATCH = 200;
    for (let i = 0; i < barcodes.length; i += BATCH) {
      const chunk = barcodes.slice(i, i + BATCH);
      const { data, error } = await sb.from('rk_inventories').select('barcode, name, sku_id').in('barcode', chunk);
      if (error) throw error;
      for (const x of (data || [])) if (!map.has(x.barcode)) map.set(x.barcode, { barcode: x.barcode, name: x.name || '', skuId: x.sku_id || '' });
    }
    const missing = barcodes.filter(b => !map.has(b));
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const { data, error } = await sb.from('rk_stocks').select('barcode, item_name, sku_id').in('barcode', chunk);
      if (error) throw error;
      for (const x of (data || [])) if (!map.has(x.barcode)) map.set(x.barcode, { barcode: x.barcode, name: x.item_name || '', skuId: x.sku_id || '' });
    }
    res.json([...map.values()]);
  } catch (e) {
    console.error('[rk] stocks/lookup:', e);
    res.status(500).json({ error: '바코드 조회 실패: ' + e.message });
  }
});

// 재고스캔 저장 — 같은 위치+바코드가 있으면 수량 합산, 없으면 신규
// 바코드별 재고 위치 목록 (수량이 0/NULL 이어도 위치가 있으면 포함).
// 출고준비 화면에서 출고예정 저장분이 없을 때 '재고 위치'를 잡아주는 용도.
// 반환: { "바코드": [{ location, qty }] }  — location 오름차순
router.post('/api/stocks/locations', async (req, res) => {
  try {
    const barcodes = [...new Set((Array.isArray(req.body.barcodes) ? req.body.barcodes : [])
      .map(b => String(b || '').trim()).filter(Boolean))];
    if (!barcodes.length) return res.json({});
    const out = {};
    const BATCH = 200;
    for (let i = 0; i < barcodes.length; i += BATCH) {
      const chunk = barcodes.slice(i, i + BATCH);
      let from = 0; const PAGE = 1000;
      while (true) {
        const { data, error } = await sb.from('rk_stocks')
          .select('barcode, location, qty').in('barcode', chunk).range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        for (const s of data) {
          const loc = String(s.location || '').trim();
          if (!loc || loc === '-') continue;
          if (!out[s.barcode]) out[s.barcode] = [];
          out[s.barcode].push({ location: loc, qty: (s.qty == null ? null : (parseInt(s.qty, 10) || 0)) });
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
    }
    for (const k in out) out[k].sort((a, b) => a.location.localeCompare(b.location, 'ko', { numeric: true }));
    res.json(out);
  } catch (e) {
    console.error('[rk] stocks/locations:', e);
    res.status(500).json({ error: '재고 위치 조회 실패: ' + e.message });
  }
});

router.post('/api/stocks/scan-save', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const clean = [];
    for (const it of items) {
      const location = String(it.location || '').trim();
      const barcode = String(it.barcode || '').trim();
      const qty = parseInt(it.qty, 10);
      if (location && barcode && Number.isFinite(qty) && qty > 0) {
        clean.push({ location, barcode, qty, productName: String(it.productName || '').trim(), skuId: String(it.skuId || '').trim() });
      }
    }
    if (!clean.length) return res.status(400).json({ error: '저장할 유효한 항목이 없습니다.' });

    // 상품명/상품번호 해석: rk_inventories 우선 → 기존 rk_stocks 값 → 클라이언트 표시값 (스캔 화면과 동일)
    async function resolveMeta(barcode, fallbackName, fallbackSku) {
      let skuId = null, itemName = null;
      const { data: inv } = await sb.from('rk_inventories').select('sku_id, name').eq('barcode', barcode).limit(1);
      if (inv && inv.length) { skuId = inv[0].sku_id; itemName = inv[0].name; }
      if (!itemName || !skuId) {
        const { data: st } = await sb.from('rk_stocks').select('sku_id, item_name').eq('barcode', barcode).limit(50);
        if (!itemName) { const r = (st || []).find(x => x.item_name); if (r) itemName = r.item_name; }
        if (!skuId) { const r = (st || []).find(x => x.sku_id); if (r) skuId = r.sku_id; }
      }
      if (!itemName && fallbackName) itemName = fallbackName;
      if (!skuId && fallbackSku) skuId = fallbackSku;
      return { skuId: skuId || null, itemName: itemName || null };
    }

    let updated = 0, inserted = 0;
    for (const it of clean) {
      const meta = await resolveMeta(it.barcode, it.productName, it.skuId);
      const { data: ex, error: eSel } = await sb.from('rk_stocks').select('id, qty, sku_id, item_name').eq('barcode', it.barcode).eq('location', it.location).limit(1);
      if (eSel) throw eSel;
      if (ex && ex.length) {
        const patch = { qty: (parseInt(ex[0].qty) || 0) + it.qty };
        if (!ex[0].item_name && meta.itemName) patch.item_name = meta.itemName; // 비어있으면 백필
        if (!ex[0].sku_id && meta.skuId) patch.sku_id = meta.skuId;
        const { error } = await sb.from('rk_stocks').update(patch).eq('id', ex[0].id);
        if (error) throw error;
        updated++;
      } else {
        const { error } = await sb.from('rk_stocks').insert({
          barcode: it.barcode, location: it.location, qty: it.qty, sku_id: meta.skuId, item_name: meta.itemName,
        });
        if (error) throw error;
        inserted++;
      }
    }
    res.json({ ok: true, updated, inserted });
  } catch (e) {
    console.error('[rk] stocks/scan-save:', e);
    res.status(500).json({ error: '재고 저장 실패: ' + e.message });
  }
});

// 수량 일괄 수정 (저장 버튼) — 변경분은 rk_stock_histories 에 'edit' 기록
router.post('/api/stocks/batch-update-qty', async (req, res) => {
  try {
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ error: '수정할 항목이 없습니다.' });

    // 현재 값 일괄 조회 (이력 before 기록용)
    const ids = updates.map((u) => parseInt(u.id, 10)).filter(Number.isFinite);
    const curById = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from('rk_stocks').select('id, sku_id, barcode, location, qty').in('id', ids.slice(i, i + 200));
      if (error) throw error;
      for (const s of (data || [])) curById.set(s.id, s);
    }

    let updated = 0;
    const histories = [];
    for (const u of updates) {
      if (!u.id) continue;
      let qty; // null = 빈칸(미입력), 0과 구별
      if (u.qty === null || u.qty === '') { qty = null; }
      else {
        qty = parseInt(u.qty, 10);
        if (!Number.isFinite(qty) || qty < 0) continue;
      }
      const { data, error } = await sb.from('rk_stocks').update({ qty }).eq('id', u.id).select('id');
      if (error) throw error;
      updated += (data ? data.length : 0);
      const cur = curById.get(parseInt(u.id, 10));
      if (cur && (cur.qty ?? null) !== (qty ?? null)) {
        histories.push({
          stock_id: cur.id, sku_id: cur.sku_id || null, barcode: cur.barcode, location: cur.location,
          change_type: 'adjust', qty: (qty ?? 0) - (parseInt(cur.qty) || 0),  // 'adjust' = 직접수정 (DB CHECK: add/deduct/adjust)
          qty_before: cur.qty ?? null, qty_after: qty ?? null, note: '전체재고 직접수정',
        });
      }
    }
    for (let i = 0; i < histories.length; i += 500) {
      const { error } = await sb.from('rk_stock_histories').insert(histories.slice(i, i + 500));
      if (error) console.error('[rk] batch-update-qty 이력 기록 실패(계속):', error.message);
    }
    res.json({ ok: true, updated });
  } catch (e) {
    console.error('[rk] stocks/batch-update-qty:', e);
    res.status(500).json({ error: '수량 저장 실패: ' + e.message });
  }
});

// 바코드별 재고 변경 이력 조회 (전체재고 상품명 클릭 팝업용)
router.get('/api/stocks/history', async (req, res) => {
  try {
    const barcode = String(req.query.barcode || '').trim();
    if (!barcode) return res.status(400).json({ error: '바코드가 필요합니다.' });
    const all = [];
    let from = 0; const PAGE = 1000;
    while (true) {
      const { data, error } = await sb.from('rk_stock_histories')
        .select('*').eq('barcode', barcode)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    res.json(all.map((h) => ({
      id: h.id, stockId: h.stock_id, barcode: h.barcode, location: h.location,
      changeType: h.change_type, qty: h.qty, qtyBefore: h.qty_before, qtyAfter: h.qty_after,
      note: h.note, createdAt: h.created_at,
    })));
  } catch (e) {
    console.error('[rk] stocks/history:', e);
    res.status(500).json({ error: '이력 조회 실패: ' + e.message });
  }
});

// 위치 일괄 저장 (선택 항목의 location 을 지정값으로 변경)
router.post('/api/stocks/batch-update-location', async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((v) => parseInt(v, 10)).filter(Number.isFinite);
    const location = String(req.body.location == null ? '' : req.body.location).trim();
    if (!ids.length) return res.status(400).json({ error: '대상 항목이 없습니다.' });
    if (!location) return res.status(400).json({ error: '위치가 입력되지 않았습니다.' });
    const { data, error } = await sb.from('rk_stocks').update({ location }).in('id', ids).select('id');
    if (error) throw error;
    res.json({ ok: true, updated: data ? data.length : 0 });
  } catch (e) {
    console.error('[rk] stocks/batch-update-location:', e);
    res.status(500).json({ error: '위치 저장 실패: ' + e.message });
  }
});

// 서식 편집용 통합문서 로드. xlsx-populate 가 못 읽는 파일(예: Excel 이 아닌 도구가 쓴 빈 inline 문자열 셀)은
// SheetJS 로 값만 옮긴 새 통합문서로 다시 만들어 진행한다 — 이때 원본 서식(열 너비·색)은 잃고, rebuilt=true 로 알린다.
async function loadWorkbookForStyling(buffer) {
  try {
    return { wb: await XlsxPopulate.fromDataAsync(buffer), rebuilt: false };
  } catch (e) {
    console.warn('[rk] xlsx-populate 로드 실패 → SheetJS 로 재작성:', e.message);
    const book = xlsx.read(buffer, { type: 'buffer' });
    const clean = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
    return { wb: await XlsxPopulate.fromDataAsync(clean), rebuilt: true };
  }
}

// 프로모션 대상조회 — 쿠팡 프로모션 엑셀(SKUID 열)을 받아 재고(rk_stocks.sku_id, qty>0)가 있는 행을
// 노란 배경 + 상단 정렬한 엑셀을 돌려준다. 원본 양식(머리글·안내 행)은 그대로 둔다.
// 재고정리건(남은상품) 수량을 SKU ID 별로 — /api/inbound/stock-arranges 의 대기 목록과 같은 계산
//   남은 = rk_cn_shipment_items.quantity − rk_cn_shipping.ship_qty 합 − rk_cn_stock_arranges.qty 합 (> 0 인 것만)
//   바코드 → SKU ID 는 rk_inventories (재고관리에 없는 바코드는 SKU 를 못 붙여 제외)
async function pendingArrangeQtyBySku() {
  const [items, shipping, arr] = await Promise.all([
    S.pageAll(() => sb.from('rk_cn_shipment_items').select('id, barcode, quantity').order('id', { ascending: true })),
    S.pageAll(() => sb.from('rk_cn_shipping').select('shipment_item_id, ship_qty').order('id', { ascending: true })),
    S.pageAll(() => sb.from('rk_cn_stock_arranges').select('shipment_item_id, qty').order('id', { ascending: true })),
  ]);
  const shipBy = new Map(), arrBy = new Map();
  for (const a of shipping) shipBy.set(a.shipment_item_id, (shipBy.get(a.shipment_item_id) || 0) + (parseInt(a.ship_qty, 10) || 0));
  for (const a of arr) arrBy.set(a.shipment_item_id, (arrBy.get(a.shipment_item_id) || 0) + (parseInt(a.qty, 10) || 0));
  const byBarcode = new Map();
  for (const it of items) {
    const remaining = (parseInt(it.quantity, 10) || 0) - (shipBy.get(it.id) || 0) - (arrBy.get(it.id) || 0);
    const bc = String(it.barcode || '').trim();
    if (remaining > 0 && bc) byBarcode.set(bc, (byBarcode.get(bc) || 0) + remaining);
  }
  const out = new Map();
  const barcodes = [...byBarcode.keys()];
  if (!barcodes.length) return out;
  const inv = await S.chunked(barcodes, 200, (part) => S.pageAll(() => sb.from('rk_inventories')
    .select('sku_id, barcode').in('barcode', part).order('id', { ascending: true })));
  for (const r of inv) {
    const sku = String(r.sku_id ?? '').trim(), bc = String(r.barcode || '').trim();
    if (sku && byBarcode.has(bc)) out.set(sku, (out.get(sku) || 0) + byBarcode.get(bc));
  }
  return out;
}

router.pendingArrangeQtyBySku = pendingArrangeQtyBySku;   // 스크립트·테스트용

router.post('/api/stocks/promo-check', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });

    // 쓰기·스타일은 xlsx-populate, 값 읽기는 SheetJS.
    // (xlsx-populate 는 '76358544' 같은 숫자 모양 텍스트를 숫자로 읽어, 그대로 다시 쓰면 텍스트 → 숫자로 바뀐다)
    const { wb, rebuilt } = await loadWorkbookForStyling(req.file.buffer);
    const sheet = wb.sheet(0);
    const used = sheet.usedRange();
    if (!used) return res.status(400).json({ error: '시트가 비어 있습니다.' });
    const lastRow = used.endCell().rowNumber();
    const lastCol = used.endCell().columnNumber();
    const sjBook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sjSheet = sjBook.Sheets[sjBook.SheetNames[0]];
    const valueAt = (r, c) => {
      const cell = sjSheet[xlsx.utils.encode_cell({ r: r - 1, c: c - 1 })];
      if (!cell || cell.t === 'z') return undefined;
      if (cell.t === 's') return String(cell.v);
      if (cell.t === 'e') return sheet.cell(r, c).value(); // 오류값은 원본 그대로
      return cell.v;
    };
    const textAt = (r, c) => String(valueAt(r, c) ?? '').trim();

    // SKUID 머리글 위치 찾기 (상단 10행 안)
    let headRow = 0, skuCol = 0;
    for (let r = 1; r <= Math.min(10, lastRow) && !skuCol; r++) {
      for (let c = 1; c <= lastCol; c++) {
        if (textAt(r, c).toUpperCase() === 'SKUID') { headRow = r; skuCol = c; break; }
      }
    }
    if (!skuCol) return res.status(400).json({ error: "'SKUID' 열을 찾을 수 없습니다." });
    // 결과 모달 표시용 상품명 열 (없으면 생략)
    let nameCol = 0;
    for (let c = 1; c <= lastCol; c++) {
      if (textAt(headRow, c).replace(/\s/g, '').toUpperCase() === 'SKU이름') { nameCol = c; break; }
    }

    // 머리글 아래 안내/예시 행은 건너뛰고, SKUID 가 숫자인 첫 행부터 데이터로 본다
    const skuOf = (r) => textAt(r, skuCol);
    let dataStart = headRow + 1;
    while (dataStart <= lastRow && !/^\d+$/.test(skuOf(dataStart))) dataStart++;
    if (dataStart > lastRow) return res.status(400).json({ error: '데이터 행(SKUID)이 없습니다.' });

    // 재고 있는 상품번호별 수량 합계 (위치가 여러 개면 합산)
    const stockQty = new Map();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('rk_stocks').select('id,sku_id,qty')
        .gt('qty', 0).order('id', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      for (const s of data) {
        const k = String(s.sku_id ?? '').trim();
        if (k) stockQty.set(k, (stockQty.get(k) || 0) + (Number(s.qty) || 0));
      }
      if (data.length < 1000) break;
    }

    // 재고정리건(남은상품) — 재고정리(/stockArrange) 대기 목록과 같은 계산: 입고 원본 − 출고 − 재고확정 (2026-10-20)
    //   재고확정이 끝난 분량은 이미 rk_stocks 에 들어가 위 "재고"에 잡히므로 중복되지 않는다.
    //   입고 데이터는 바코드 단위라 재고관리(rk_inventories)의 바코드 → SKU ID 로 붙인다.
    const arrangeQty = await pendingArrangeQtyBySku();

    // 행 값 읽기 → 재고(재고 + 재고정리건 총합) 있는 행을 위로 (원래 순서 유지)
    // 셀 스타일은 행과 함께 옮긴다. xlsx-populate 의 cell.style(name, v) 는 셀마다 새 스타일을 만들어
    // (조회만 해도 생성) 파일이 비대해지므로, 스타일 id(_styleId)를 직접 옮기고 노란 스타일은 원본 스타일별 1개만 만든다.
    const rows = [];
    for (let r = dataStart; r <= lastRow; r++) {
      const values = [], styleIds = [];
      for (let c = 1; c <= lastCol; c++) {
        values.push(valueAt(r, c));
        styleIds.push(sheet.cell(r, c)._styleId);
      }
      const sku = skuOf(r);
      const stock = stockQty.get(sku) || 0, arrange = arrangeQty.get(sku) || 0;
      rows.push({ values, styleIds, sku, stockQty: stock, arrangeQty: arrange, qty: stock + arrange });
    }
    const hits = rows.filter((x) => x.qty > 0);
    const sorted = hits.concat(rows.filter((x) => !(x.qty > 0)));

    // 마지막 열 뒤에 [재고] [재고정리건] [총합] 세 열 — 머리글은 파란 배경 (발주가능상태 조회와 같은 모양)
    const EXTRA = ['재고', '재고정리건', '총합'];
    const headStyle = wb.styleSheet().createStyle(sheet.cell(headRow, skuCol)._styleId);
    headStyle.style('fill', 'FFBDD7EE'); headStyle.style('bold', true);
    EXTRA.forEach((h, i) => { const cell = sheet.cell(headRow, lastCol + 1 + i); cell.value(h); cell._style = undefined; cell._styleId = headStyle.id(); });

    const yellowByBase = new Map();
    const yellowStyleId = (baseId) => {
      const key = baseId == null ? -1 : baseId;
      if (!yellowByBase.has(key)) {
        const st = wb.styleSheet().createStyle(baseId);
        st.style('fill', 'FFFFFF00');
        yellowByBase.set(key, st.id());
      }
      return yellowByBase.get(key);
    };

    sorted.forEach((row, i) => {
      const r = dataStart + i;
      row.values.forEach((v, j) => {
        const cell = sheet.cell(r, j + 1);
        cell.value(v == null ? undefined : v);
        cell._style = undefined;
        cell._styleId = row.qty > 0 ? yellowStyleId(row.styleIds[j]) : row.styleIds[j];
      });
      // 새 열: 재고 / 재고정리건 / 총합 — 총합이 있는 행만 세 값을 쓴다 (없는 행은 빈칸). 스타일은 그 행 SKU 칸과 같게 (매칭 행은 노란색)
      const baseId = row.styleIds[skuCol - 1];
      [row.stockQty, row.arrangeQty, row.qty].forEach((q, i2) => {
        const cell = sheet.cell(r, lastCol + 1 + i2);
        cell.value(row.qty > 0 ? q : undefined);
        cell._style = undefined;
        cell._styleId = row.qty > 0 ? yellowStyleId(baseId) : baseId;
      });
    });

    const buffer = await wb.outputAsync();
    const base = String(req.file.originalname || '프로모션').replace(/\.xlsx$/i, '');
    res.json({
      total: rows.length,
      matched: hits.length,
      totalQty: hits.reduce((s, x) => s + x.qty, 0),
      stockQty: hits.reduce((s, x) => s + x.stockQty, 0),
      arrangeQty: hits.reduce((s, x) => s + x.arrangeQty, 0),
      items: hits.map((x) => ({ sku: x.sku, name: nameCol ? String(x.values[nameCol - 1] ?? '') : '', qty: x.qty, stockQty: x.stockQty, arrangeQty: x.arrangeQty })),
      filename: `${base}_재고대상.xlsx`,
      rebuilt,
      file: Buffer.from(buffer).toString('base64'),
    });
  } catch (e) {
    console.error('[rk] stocks/promo-check:', e);
    res.status(500).json({ error: '프로모션 대상조회 실패: ' + e.message });
  }
});

// 발주가능상태 조회 — 쿠팡 '발주가능상태 확인' 엑셀(SKU ID 열)을 받아 재고(rk_stocks.sku_id, qty>0) 또는
// 재고정리건(재고정리 대기 남은상품)이 있는 행에 마지막 열 뒤로 [위치] [재고수량] [재고정리건] [총합] 네 열을 채워 돌려준다.
// 새 머리글은 파란 배경, 값이 들어간 행(총합 > 0)은 노란 배경. 조회 범위는 프로모션 대상조회와 같다 (2026-10-29)
// 양식이 조금씩 달라서 머리글은 위치가 아니라 이름으로 찾는다 (SKU ID / SKUID / 상품번호 …, 상단 15행 안).
// 원본 셀 값은 건드리지 않는다 (숫자/문자 변환 문제 없음) — 매칭 행은 스타일 id 만 바꾸고 새 열에만 값을 쓴다.
router.post('/api/stocks/order-status-check', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });

    const { wb, rebuilt } = await loadWorkbookForStyling(req.file.buffer);
    const sheet = wb.sheet(0);
    const used = sheet.usedRange();
    if (!used) return res.status(400).json({ error: '시트가 비어 있습니다.' });
    const lastRow = used.endCell().rowNumber();
    const lastCol = used.endCell().columnNumber();
    const sjBook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sjSheet = sjBook.Sheets[sjBook.SheetNames[0]];
    const valueAt = (r, c) => {
      const cell = sjSheet[xlsx.utils.encode_cell({ r: r - 1, c: c - 1 })];
      if (!cell || cell.t === 'z') return undefined;
      if (cell.t === 's') return String(cell.v);
      if (cell.t === 'e') return sheet.cell(r, c).value();
      return cell.v;
    };
    const textAt = (r, c) => String(valueAt(r, c) ?? '').trim();
    const norm = (s) => String(s || '').replace(/[\s_\-#]/g, '').toLowerCase();
    const SKU_HEADERS = new Set(['skuid', '상품번호', 'sku번호', 'skuno', 'sku']);
    const NAME_HEADERS = new Set(['skuname', 'sku이름', 'sku명', '상품명', '상품이름', 'productname']);

    // 머리글 행·SKU 열 찾기 (상단 15행)
    let headRow = 0, skuCol = 0;
    for (let r = 1; r <= Math.min(15, lastRow) && !skuCol; r++) {
      for (let c = 1; c <= lastCol; c++) {
        if (SKU_HEADERS.has(norm(textAt(r, c)))) { headRow = r; skuCol = c; break; }
      }
    }
    if (!skuCol) return res.status(400).json({ error: "'SKU ID' 머리글을 찾을 수 없습니다. (상단 15행 안에 SKU ID / 상품번호 열이 있어야 합니다)" });
    let nameCol = 0;
    for (let c = 1; c <= lastCol; c++) if (NAME_HEADERS.has(norm(textAt(headRow, c)))) { nameCol = c; break; }

    // 데이터 시작 = 머리글 아래에서 SKU 가 숫자인 첫 행 (안내/예시 행 건너뜀)
    const skuOf = (r) => textAt(r, skuCol).replace(/\.0$/, '');
    let dataStart = headRow + 1;
    while (dataStart <= lastRow && !/^\d+$/.test(skuOf(dataStart))) dataStart++;
    if (dataStart > lastRow) return res.status(400).json({ error: '데이터 행(SKU ID)이 없습니다.' });

    // 재고: 상품번호별 위치·수량 (qty>0 인 위치만)
    const stock = new Map(); // sku -> { qty, locs: [{location, qty}] }
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('rk_stocks').select('id,sku_id,location,qty')
        .gt('qty', 0).order('id', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      for (const s of data) {
        const k = String(s.sku_id ?? '').trim();
        if (!k) continue;
        if (!stock.has(k)) stock.set(k, { qty: 0, locs: [] });
        const e = stock.get(k);
        const q = Number(s.qty) || 0;
        e.qty += q;
        const loc = String(s.location ?? '').trim();
        const ex = e.locs.find((l) => l.location === loc);
        if (ex) ex.qty += q; else e.locs.push({ location: loc, qty: q });
      }
      if (data.length < 1000) break;
    }
    // 재고정리건(남은상품) — 프로모션 대상조회와 같은 계산 (재고확정분은 이미 위 재고에 있어 중복되지 않는다)
    const arrangeQty = await pendingArrangeQtyBySku();
    const sortLoc = (a, b) => String(a.location).localeCompare(String(b.location), 'ko', { numeric: true });
    const locText = (e) => {
      const locs = e.locs.slice().sort(sortLoc);
      if (locs.length === 1) return locs[0].location || '-';
      return locs.map((l) => `${l.location || '-'}(${l.qty})`).join(', ');
    };

    // 새 열: 마지막 열 뒤 [위치] [재고수량] [재고정리건] [총합]
    const locCol = lastCol + 1, qtyCol = lastCol + 2, arrCol = lastCol + 3, sumCol = lastCol + 4;
    const ss = wb.styleSheet();
    const styleCache = new Map(); // `${baseId}|${fill}` -> styleId
    const styled = (baseId, fill, bold) => {
      const key = `${baseId == null ? -1 : baseId}|${fill}|${bold ? 1 : 0}`;
      if (!styleCache.has(key)) {
        const st = ss.createStyle(baseId);
        st.style('fill', fill);
        if (bold) st.style('bold', true);
        styleCache.set(key, st.id());
      }
      return styleCache.get(key);
    };
    const setStyle = (cell, id) => { cell._style = undefined; cell._styleId = id; };
    const BLUE = 'FFBDD7EE', YELLOW = 'FFFFFF00';

    const headBase = sheet.cell(headRow, lastCol)._styleId;
    for (const [c, label] of [[locCol, '위치'], [qtyCol, '재고수량'], [arrCol, '재고정리건'], [sumCol, '총합']]) {
      const cell = sheet.cell(headRow, c);
      cell.value(label);
      setStyle(cell, styled(headBase, BLUE, true));
    }
    sheet.column(locCol).width(22);
    sheet.column(qtyCol).width(10);
    sheet.column(arrCol).width(11);
    sheet.column(sumCol).width(8);

    let total = 0;
    const hits = [];
    for (let r = dataStart; r <= lastRow; r++) {
      const sku = skuOf(r);
      if (!sku) continue;
      total++;
      const e = stock.get(sku);
      const stockQ = e && e.qty > 0 ? e.qty : 0, arrQ = arrangeQty.get(sku) || 0;
      if (!(stockQ + arrQ > 0)) continue;
      // 재고정리건만 있는 상품은 아직 위치가 없다 → 위치·재고수량 빈칸
      const loc = stockQ > 0 ? locText(e) : '';
      if (stockQ > 0) {
        sheet.cell(r, locCol).value(loc);
        sheet.cell(r, qtyCol).value(stockQ);
      }
      if (arrQ > 0) sheet.cell(r, arrCol).value(arrQ);
      sheet.cell(r, sumCol).value(stockQ + arrQ);
      for (let c = 1; c <= sumCol; c++) {
        const cell = sheet.cell(r, c);
        setStyle(cell, styled(cell._styleId, YELLOW, false));
      }
      hits.push({ sku, name: nameCol ? textAt(r, nameCol) : '', location: loc, qty: stockQ + arrQ, stockQty: stockQ, arrangeQty: arrQ });
    }

    const buffer = await wb.outputAsync();
    const base = String(req.file.originalname || '발주가능상태').replace(/\.xlsx$/i, '');
    res.json({
      total,
      matched: hits.length,
      totalQty: hits.reduce((s, x) => s + x.qty, 0),
      stockQty: hits.reduce((s, x) => s + x.stockQty, 0),
      arrangeQty: hits.reduce((s, x) => s + x.arrangeQty, 0),
      items: hits,
      headerRow: headRow,
      filename: `${base}_재고확인.xlsx`,
      rebuilt,
      file: Buffer.from(buffer).toString('base64'),
    });
  } catch (e) {
    console.error('[rk] stocks/order-status-check:', e);
    res.status(500).json({ error: '발주가능상태 조회 실패: ' + e.message });
  }
});

module.exports = router;
