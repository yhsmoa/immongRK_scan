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

module.exports = router;
