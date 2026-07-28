/**
 * 광고 상품정보(가격/재고/리뷰/아이템위너) 매칭 — 저장 없이 엑셀로만 내보낸다.
 *
 * 광고 API 응답에는 SKU·바코드가 없고 vendoritemid/productid/itemid 뿐이라
 * 우리 rk_inventories 와 직접 이어붙일 키가 없다. 유일한 공통 정보가 상품명인데
 * 광고 쪽은 카테고리 단어를 다르게 쓴다(주니어→삭제, 아동→아동용). 그래서
 *   ① 모델코드 뒤쪽(예: "E6F283, 블루, 130")  — 있는 경우 100% 고유
 *   ② 카테고리 단어를 양쪽에서 제거한 이름     — 14,406건 중 99.9% 고유
 * 두 단계로 매칭한다.
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;

// 광고/우리 이름에서 서로 다르게 쓰이는 카테고리 단어
const CATEGORY = /(여성용|여성|남성용|남성|아동용|아동|주니어|여아용|여아|남아용|남아|유아용|유아|베이비|키즈)/g;
// 모델코드: 영문1 + 숫자1 + 영문1 + 숫자3~4  (E6F283, R6H087 …)
const MODEL = /[A-Z][0-9][A-Z][0-9]{3,4}.*$/;

const norm = (s) => String(s == null ? '' : s).replace(CATEGORY, '').replace(/\s+/g, '').toLowerCase();
const modelKey = (s) => {
  const m = MODEL.exec(String(s == null ? '' : s));
  return m ? m[0].replace(/\s+/g, '').toLowerCase() : '';
};

// 업로드 파일 → 행 배열 (csv 는 UTF-8 로 직접 디코딩: buffer 로 넘기면 SheetJS 가 latin1 으로 읽어 한글이 깨짐)
function parseUpload(buf) {
  const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
  const isOle = buf.length > 3 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  let wb;
  if (isZip || isOle) {
    wb = xlsx.read(buf, { type: 'buffer' });
  } else {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    wb = xlsx.read(text, { type: 'string' });
  }
  return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

const pick = (o, keys) => {
  for (const k of keys) if (o[k] != null && String(o[k]).trim() !== '') return o[k];
  return '';
};

// CSV 는 전부 문자열로 들어오므로 타입을 맞춰 넣는다
const str = (v) => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
const toNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : null; };
const toInt = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/,/g, '').trim(), 10); return Number.isFinite(n) ? n : null; };
const toBool = (v) => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'y') return true;
  if (s === 'false' || s === '0' || s === 'n') return false;
  return null;
};

router.post('/api/shortage/ad-match', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });

    const raw = parseUpload(req.file.buffer);
    const adRows = raw.map((o) => ({
      itemName: String(pick(o, ['item_name', 'itemnm', '상품명', '광고상품명'])).trim(),
      price: pick(o, ['price', 'sales_price', '가격']),
      stockQty: pick(o, ['stock_qty', 'stockQuantity', '재고']),
      isSoldOut: pick(o, ['is_sold_out', 'isSoldOut', '품절여부']),
      reviewCount: pick(o, ['review_count', '리뷰수']),
      ratingAvg: pick(o, ['rating_avg', '평점']),
      itemWinner: pick(o, ['item_winner', 'buyboxStatus', '아이템위너']),
      isInvalid: pick(o, ['is_invalid', 'isInvalid']),
      vendorItemId: pick(o, ['vendor_item_id', 'vendoritemid']),
      productId: pick(o, ['product_id', 'productid']),
      itemId: pick(o, ['item_id', 'itemid']),
    })).filter((r) => r.itemName);

    if (!adRows.length) return res.status(400).json({ error: '상품명 열을 찾지 못했습니다. 콘솔에서 받은 CSV 를 그대로 올려주세요.' });

    // 광고 데이터 → 키별 색인 (중복 키는 첫 건만)
    const byModel = new Map();
    const byName = new Map();
    for (const r of adRows) {
      const mk = modelKey(r.itemName);
      if (mk && !byModel.has(mk)) byModel.set(mk, r);
      const nk = norm(r.itemName);
      if (nk && !byName.has(nk)) byName.set(nk, r);
    }

    // 우리 상품 전량
    const ours = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('rk_inventories')
        .select('sku_id, name, barcode, location').range(from, from + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      ours.push(...data);
      if (data.length < 1000) break;
    }

    let matched = 0, mByModel = 0, mByName = 0;
    const upserts = [];
    const out = ours.map((o) => {
      const mk = modelKey(o.name);
      let hit = mk ? byModel.get(mk) : null;
      let how = hit ? '모델코드' : '';
      if (!hit) { hit = byName.get(norm(o.name)) || null; if (hit) how = '이름'; }
      if (hit) {
        matched++;
        if (how === '모델코드') mByModel++; else mByName++;
        if (o.sku_id) upserts.push({
          sku_id: String(o.sku_id), barcode: o.barcode || null,
          item_name: hit.itemName || null,
          price: toNum(hit.price), stock_qty: toInt(hit.stockQty),
          is_sold_out: toBool(hit.isSoldOut),
          review_count: toInt(hit.reviewCount), rating_avg: toNum(hit.ratingAvg),
          item_winner: str(hit.itemWinner), is_invalid: toBool(hit.isInvalid),
          vendor_item_id: str(hit.vendorItemId), product_id: str(hit.productId), item_id: str(hit.itemId),
          matched_by: how, updated_at: new Date().toISOString(),
        });
      }
      return {
        'SKU ID': o.sku_id || '',
        '바코드': o.barcode || '',
        '위치': o.location || '',
        '상품명': o.name || '',
        '매칭': how || '실패',
        '광고상품명': hit ? hit.itemName : '',
        '가격': hit ? hit.price : '',
        '재고': hit ? hit.stockQty : '',
        '품절': hit ? hit.isSoldOut : '',
        '리뷰수': hit ? hit.reviewCount : '',
        '평점': hit ? hit.ratingAvg : '',
        '아이템위너': hit ? hit.itemWinner : '',
        '광고불가': hit ? hit.isInvalid : '',
        'vendor_item_id': hit ? hit.vendorItemId : '',
        'product_id': hit ? hit.productId : '',
      };
    });

    // 매칭된 건만 rk_coupang_info 에 저장(sku_id 기준 덮어쓰기)
    let saved = 0;
    for (let i = 0; i < upserts.length; i += 500) {
      const chunk = upserts.slice(i, i + 500);
      const { error } = await sb.from('rk_coupang_info').upsert(chunk, { onConflict: 'sku_id' });
      if (error) throw error;
      saved += chunk.length;
    }

    const ws = xlsx.utils.json_to_sheet(out);
    ws['!cols'] = [{ wch: 11 }, { wch: 15 }, { wch: 10 }, { wch: 52 }, { wch: 8 }, { wch: 52 },
      { wch: 9 }, { wch: 7 }, { wch: 7 }, { wch: 8 }, { wch: 7 }, { wch: 12 }, { wch: 9 }, { wch: 14 }, { wch: 13 }];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '광고상품정보');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const summary = { adRows: adRows.length, ourRows: ours.length, matched, byModel: mByModel, byName: mByName, unmatched: ours.length - matched, saved };
    res.setHeader('X-Match-Summary', encodeURIComponent(JSON.stringify(summary)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Match-Summary, Content-Disposition');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('광고상품정보.xlsx'));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    console.error('[rk] shortage/ad-match:', e);
    res.status(500).json({ error: '광고결과 매칭 중 오류: ' + e.message });
  }
});

// 저장된 광고정보 조회 — 배지 표시용. { "sku_id": {price, stock, review, rating}, ... }
router.get('/api/coupang-info', async (req, res) => {
  try {
    const map = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('rk_coupang_info')
        .select('sku_id, price, stock_qty, review_count, rating_avg, is_sold_out, item_winner, product_id, item_id')
        .range(from, from + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      for (const r of data) {
        if (!r.sku_id) continue;
        map[r.sku_id] = {
          price: r.price, stock: r.stock_qty,
          review: r.review_count, rating: r.rating_avg,
          soldOut: r.is_sold_out, winner: r.item_winner,
          pid: r.product_id, iid: r.item_id,          // 상품 페이지 링크용
        };
      }
      if (data.length < 1000) break;
    }
    res.json(map);
  } catch (e) {
    console.error('[rk] coupang-info:', e);
    res.status(500).json({ error: '광고정보 조회 실패: ' + e.message });
  }
});

module.exports = router;
