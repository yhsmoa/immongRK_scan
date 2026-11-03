/**
 * 상품관리(/inventory) [혼용률/권장연령] — 엑셀로 혼용률 채우기 + 이유몽 사이즈로 권장연령 채우기 (2026-11-03)
 *
 *   POST /api/inventory/comp-age
 *     body { rows:[{sheet,row,model,comp}] | null, overwrite?: bool, apply?: bool }
 *       rows = 엑셀 작업리스트BR · 작업리스트ER 의 D열(모델명) · I열(혼용률). 화면이 엑셀을 읽어 보낸다.
 *              null(또는 생략)이면 혼용률은 건드리지 않고 권장연령만 (이유몽 미입력 화면의 [사이즈로 권장연령 채우기]).
 *       apply=false(기본) → 미리보기만 (읽기만). apply=true → 같은 계산을 그 시점 DB 로 다시 해서 저장.
 *     → { excel, comp, age, applied? }   각 목록은 앞 LIST_MAX 개만, 개수는 전부
 *
 *   GET  /api/inventory/eyoumong-missing
 *     → { rows:[{ id, sku, name, barcode, composition, age, model, size, sizeAge }], counts }
 *       상품명이 "이유몽" 으로 시작하는데 혼용률 또는 권장연령이 빈 상품
 *
 * 규칙은 전부 ../compAge.js (테스트: tests/compAge.test.js). 여기서는 DB 읽기·쓰기만 한다.
 * 저장은 값별로 묶어 id 200개씩 update. "빈칸 채우기" 는 저장 순간에도 빈칸인 행만 바꾼다(그 사이 누가 넣은 값은 덮지 않는다).
 */
const express = require('express');
const S = require('./rkShared');
const C = require('../compAge');

const router = express.Router();
const sb = S.supabase;
const LIST_MAX = 300;
const ID_CHUNK = 200;
const MAX_ROWS = 50000;

// 상품관리 전체 — 1000행씩, id 순 (정렬 없는 range 는 행이 빠지거나 겹칠 수 있다)
//   이유몽 미입력 목록도 DB 의 접두어 검색이 아니라 전체를 읽어 compAge 의 같은 판정(앞뒤 공백 무시)을 쓴다 — 채우기 계획과 목록이 어긋나지 않게
async function loadInventories() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const q = sb.from('rk_inventories').select('id, sku_id, name, barcode, composition, recommanded_age').order('id', { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

const cut = (list) => list.slice(0, LIST_MAX);
// 빈칸 = NULL 또는 공백뿐 (''·'  ' 포함) — compAge.isBlank 와 같은 기준이라 "채울 것" 으로 센 행이 저장에서 빠지지 않는다
const blankGuard = (col) => `${col}.is.null,${col}.match.^\\s*$`;

// 값 하나를 id 들에 저장. onlyBlank 면 그 칸이 빈 행만. → 실제로 바뀐 행 수
async function writeValue(col, value, ids, onlyBlank) {
  let n = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    let q = sb.from('rk_inventories').update({ [col]: value }).in('id', ids.slice(i, i + ID_CHUNK));
    if (onlyBlank) q = q.or(blankGuard(col));
    const { data, error } = await q.select('id');
    if (error) throw error;
    n += (data || []).length;
  }
  return n;
}

router.post('/api/inventory/comp-age', async (req, res) => {
  try {
    const body = req.body || {};
    const hasRows = Array.isArray(body.rows);
    if (body.rows != null && !hasRows) return res.status(400).json({ error: 'rows 형식이 올바르지 않습니다.' });
    if (hasRows && body.rows.length > MAX_ROWS) return res.status(400).json({ error: `엑셀 행이 너무 많습니다 (${body.rows.length}행, 최대 ${MAX_ROWS}).` });
    const overwrite = body.overwrite === true;
    const apply = body.apply === true;

    const comp = hasRows ? C.buildCompositionMap(body.rows) : null;
    if (comp && !comp.models) return res.status(400).json({ error: '엑셀에서 모델명(D열)과 혼용률(I열)이 있는 행을 찾지 못했습니다.' });

    const inventories = await loadInventories();
    const plan = C.planCompAge({ inventories, comp, overwrite });

    let applied = null;
    if (apply) {
      applied = { compFill: 0, compChange: 0, age: 0 };
      for (const [value, g] of plan.updates.comp) {
        if (g.fill.length) applied.compFill += await writeValue('composition', value, g.fill, true);
        if (g.change.length) applied.compChange += await writeValue('composition', value, g.change, false);
      }
      for (const [value, ids] of plan.updates.age) applied.age += await writeValue('recommanded_age', value, ids, true);
    }

    const c = plan.comp;
    res.json({
      overwrite,
      excel: comp ? {
        rows: comp.rows, models: comp.models, blankComp: comp.blankComp,
        conflicts: comp.conflicts.slice(0, LIST_MAX).map((x) => ({ model: x.model, values: x.values })), conflictCount: comp.conflicts.length,
      } : null,
      comp: c ? {
        fill: cut(c.fill), fillCount: c.fill.length,
        change: cut(c.change), changeCount: c.change.length,
        keep: cut(c.keep), keepCount: c.keep.length,
        conflict: cut(c.conflict), conflictCount: c.conflict.length,
        same: c.same, noModel: c.noModel, noMatch: c.noMatch, excelUnused: c.excelUnused,
      } : null,
      age: {
        fill: cut(plan.age.fill), fillCount: plan.age.fill.length,
        unresolved: cut(plan.age.unresolved), unresolvedCount: plan.age.unresolved.length,
        differ: cut(plan.age.differ), differCount: plan.age.differ.length,
        has: plan.age.has,
      },
      applied,
    });
  } catch (e) {
    console.error('[rk] inventory/comp-age:', e);
    res.status(500).json({ error: '혼용률/권장연령 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

router.get('/api/inventory/eyoumong-missing', async (req, res) => {
  try {
    const rows = (await loadInventories())
      .filter((r) => C.sizeAge(r.name).eyoumong && (C.isBlank(r.composition) || C.isBlank(r.recommanded_age)))
      .map((r) => {
        const sa = C.sizeAge(r.name);
        return {
          id: r.id, sku: C.normText(r.sku_id), name: C.normText(r.name), barcode: C.normText(r.barcode),
          composition: C.normText(r.composition), age: C.normText(r.recommanded_age),
          // 모델명 표시는 가장 좁은 후보 ("티셔츠E6S161" → E6S161, "티셔츠_슈에므" → 슈에므) — 엑셀 D열에 적힐 값
          model: C.modelKeys(r.name).slice(-1)[0] || '', size: sa.size || '', sizeAge: sa.age || '',
        };
      });
    const counts = {
      total: rows.length,
      noComp: rows.filter((r) => !r.composition).length,
      noAge: rows.filter((r) => !r.age).length,
      ageFillable: rows.filter((r) => !r.age && r.sizeAge).length,
    };
    res.json({ rows, counts });
  } catch (e) {
    console.error('[rk] inventory/eyoumong-missing:', e);
    res.status(500).json({ error: '이유몽 미입력 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
