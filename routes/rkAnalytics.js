/**
 * 데이터 분석 — 발주수량·확정수량을 일·주·월·연도로 (/analytics)
 * 설계: docs/plan-analytics.md
 *
 * 집계는 DB 함수 rk_order_stats 가 한 번에 한다 (정의: supabase/rk_order_stats.sql).
 *   확정수량 = 출고스캔(rk_ship_box_items) 합 — rk_order_items.confirmed_qty 는 업로드 시점 값이라 발주수량과 같다.
 *
 *   GET /analytics                                  → 화면 (analytics.html)
 *   GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=reg|arrival&brand=&center=&fresh=1
 *        → rk_order_stats 결과 + { generatedAt, cached }
 *
 * 같은 조건은 5분 동안 서버 메모리에 담아 둔다 (집계가 1~2초 걸리고, 발주 데이터는 하루 몇 번만 바뀐다).
 * fresh=1 이면 담아 둔 값을 무시하고 다시 계산한다 (화면의 [새로고침]).
 */
const path = require('path');
const express = require('express');
const S = require('./rkShared');

const router = express.Router();
const sb = S.supabase;

const BASES = ['reg', 'arrival'];
const BRANDS = ['아이엠몽', '이유몽', '기타'];
const MAX_DAYS = 1100;            // DB 함수와 같은 상한 (3년)
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 60;

const cache = new Map();          // key → { at, data }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v) {
  const s = String(v || '').trim();
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

router.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'analytics.html'));
});

router.get('/api/analytics', async (req, res) => {
  try {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to) return res.status(400).json({ error: '기간(from, to)을 YYYY-MM-DD 로 주세요.' });
    if (from > to) return res.status(400).json({ error: '시작일이 종료일보다 늦습니다.' });
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
    if (days > MAX_DAYS) return res.status(400).json({ error: '기간은 3년 이내로 고르세요.' });

    const basis = req.query.basis === undefined ? 'reg' : String(req.query.basis);
    if (!BASES.includes(basis)) return res.status(400).json({ error: `basis 는 ${BASES.join(', ')} 중 하나여야 합니다.` });
    const brand = req.query.brand ? String(req.query.brand) : null;
    if (brand && !BRANDS.includes(brand)) return res.status(400).json({ error: `brand 는 ${BRANDS.join(', ')} 중 하나여야 합니다.` });
    const center = req.query.center ? String(req.query.center).slice(0, 60) : null;

    const key = JSON.stringify([from, to, basis, brand, center]);
    const hit = cache.get(key);
    if (hit && req.query.fresh !== '1' && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json(Object.assign({}, hit.data, { cached: true }));
    }

    const { data, error } = await sb.rpc('rk_order_stats', {
      p_from: from, p_to: to, p_basis: basis, p_brand: brand, p_center: center,
    });
    if (error) throw error;

    const out = Object.assign({}, data || {}, {
      filters: { from, to, basis, brand, center },
      generatedAt: new Date().toISOString(),
    });
    cache.set(key, { at: Date.now(), data: out });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // 가장 먼저 넣은 것부터 버린다
    res.json(Object.assign({}, out, { cached: false }));
  } catch (e) {
    console.error('[rk] analytics:', e);
    res.status(500).json({ error: '분석 데이터를 불러오는 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
