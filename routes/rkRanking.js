/**
 * 발주 랭킹 — 상품 단위 발주수량 순위 (/ranking)
 *
 * 발주서(rk_orders / rk_order_items)에 들어온 발주수량을 상품 단위로 합쳐 순위를 매긴다.
 * 합계·순위 계산은 DB 함수 rk_order_ranking 이 한 번에 한다 (정의: supabase/rk_order_ranking.sql).
 * 품목 행을 서버로 받아 와 더하지 않으므로 1000행 페이지 루프가 필요 없고, 응답은 최대 LIMIT_MAX 행이다.
 *
 *   GET /ranking                       → 랭킹 화면 (ranking.html)
 *   GET /api/ranking?basis=d7&limit=20 → { basis, items:[{ rank, productName, optionCount, d1, d7, d30, d90,
 *                                           confirmed, orderCount, stock, img, rating, reviewCount }], generatedAt }
 *
 * basis: d1(오늘) · d7(최근 7일) · d30 · d90 — 발주등록일시 기준, 한국 시간 달력 날짜, 오늘 포함.
 */
const path = require('path');
const express = require('express');
const S = require('./rkShared');

const router = express.Router();
const sb = S.supabase;

// ── 상수 ──
const BASES = ['d1', 'd7', 'd30', 'd90'];
const DEFAULT_BASIS = 'd7';
const LIMIT_DEFAULT = 20;   // 화면은 1~10위 + [더보기] 11~20위
const LIMIT_MAX = 100;      // DB 함수도 같은 상한으로 자른다

// 이미지: rk_inventories.img 는 쿠팡 CDN 원본(큰 파일)이다. 카드에는 썸네일 CDN 의 축소본을 쓴다.
const COUPANG_IMAGE_ORIGIN = /^https?:\/\/img\d*\.coupangcdn\.com\/image\//;
const COUPANG_THUMBNAIL_BASE = 'https://thumbnail6.coupangcdn.com/thumbnails/remote/230x230ex/image/';

/** 쿠팡 CDN 원본 주소 → 230px 썸네일 주소. 다른 곳의 주소는 그대로 둔다. */
function toThumbnailUrl(img) {
  const url = String(img || '').trim();
  if (!url) return '';
  return COUPANG_IMAGE_ORIGIN.test(url) ? url.replace(COUPANG_IMAGE_ORIGIN, COUPANG_THUMBNAIL_BASE) : url;
}

// ── 화면 ──
router.get('/ranking', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ranking.html'));
});

// ── 순위 조회 ──
router.get('/api/ranking', async (req, res) => {
  try {
    const basis = req.query.basis === undefined ? DEFAULT_BASIS : String(req.query.basis);
    if (!BASES.includes(basis)) {
      return res.status(400).json({ error: `basis 는 ${BASES.join(', ')} 중 하나여야 합니다.` });
    }
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isNaN(requested) ? LIMIT_DEFAULT : Math.min(Math.max(requested, 1), LIMIT_MAX);

    const { data, error } = await sb.rpc('rk_order_ranking', { p_basis: basis, p_limit: limit });
    if (error) throw error;

    res.json({
      basis,
      generatedAt: new Date().toISOString(),
      items: (data || []).map((r) => ({
        rank: r.rank,
        productName: r.product_name,
        optionCount: r.option_count,
        d1: Number(r.d1) || 0,
        d7: Number(r.d7) || 0,
        d30: Number(r.d30) || 0,
        d90: Number(r.d90) || 0,
        confirmed: Number(r.confirmed) || 0,
        orderCount: Number(r.order_count) || 0,
        stock: Number(r.stock) || 0,
        img: toThumbnailUrl(r.img),
        // 별점·리뷰 수는 상품부족 화면의 수집 결과(rk_coupang_info)라 아직 수집 안 된 상품은 null
        rating: r.rating_avg == null ? null : Number(r.rating_avg),
        reviewCount: r.review_count == null ? null : Number(r.review_count),
      })),
    });
  } catch (e) {
    console.error('[rk] ranking:', e);
    res.status(500).json({ error: '랭킹을 불러오는 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
