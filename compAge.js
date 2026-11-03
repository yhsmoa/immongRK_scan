/**
 * 혼용률 · 권장연령 채우기 — 규칙 계산기 (DB 없음, node tests/compAge.test.js 로 검증)
 *
 * 상품관리(/inventory) [혼용률/권장연령] 드롭다운이 쓴다 (routes/rkCompAge.js).
 *
 *   혼용률: 업로드 엑셀(시트 작업리스트BR · 작업리스트ER, D열 = 모델명, I열 = 혼용률)의 모델명이
 *           상품명의 "모델명 부분" 과 같으면 그 혼용률을 넣는다.
 *           모델명 부분 = 첫 콤마 앞의 마지막 단어
 *             "이유몽 아동용 루즈핏 라운드넥 스트라이프 긴팔 티셔츠 E6S107, 블루, 140" → E6S107
 *             "아이엠몽 여성 라엘 플레어 리본 롱 원피스, 화이트, FREE" → 원피스 (엑셀에 없으면 매칭 안 됨)
 *           그 단어에 '_' 가 있으면 뒷부분도 후보 ("티셔츠_슈에므" → 슈에므), 한글에 붙은 영문+숫자 코드도 후보
 *           ("티셔츠E6S161" → E6S161). 단어 전체가 먼저, 후보는 그다음. 대소문자 무시.
 *           같은 모델이 엑셀에 서로 다른 혼용률로 여러 번 나오면 "충돌" — 어느 쪽인지 알 수 없으니 그 모델은 건너뛴다.
 *           (공백만 다른 값 "폴리 70% + 아크릴 30%" / "폴리 70%+아크릴 30%" 은 같은 값으로 본다)
 *           기본은 혼용률이 빈 상품만 채운다. overwrite 면 값이 다른 상품도 엑셀 값으로 바꾼다.
 *
 *   권장연령: 상품명이 "이유몽" 으로 시작하는 상품만, 사이즈 숫자로 정한다. 빈 상품만 채운다 (기존 값은 건드리지 않는다).
 *           표는 상품관리 DB 에 이미 들어 있는 값 그대로 (2026-11-03 집계: 120 → 5-7세 1126건 … 예외 없음).
 *           범위 사이즈("110~120", "120-130")는 큰 쪽 숫자 기준 — DB 의 110~120 → 5-7세, 120~130 → 7-9세 와 같다.
 *           사이즈 = 첫 콤마 뒤 조각들 중 숫자로 시작하는 것 (뒤에서부터). 콤마가 없으면 마지막 단어.
 *           표에 없는 숫자(110 단독, 170 …)는 "사이즈로 못 정함" 으로 돌려준다 (추측해서 넣지 않는다).
 */

const AGE_BY_SIZE = { 120: '5-7세', 130: '7-9세', 140: '9-11세', 150: '11-12세', 160: '12-14세' };
const EYOUMONG = '이유몽';

/** 줄바꿈·연속 공백 정리 */
const normText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
/** 같은 값 비교용 — 공백 무시 */
const sameKey = (v) => normText(v).replace(/\s+/g, '');
const isBlank = (v) => normText(v) === '';

/** 상품명 → 모델명 후보 (대문자). 콤마가 없으면 [] */
function modelKeys(name) {
  const s = String(name == null ? '' : name);
  const i = s.indexOf(',');
  if (i < 0) return [];
  const words = s.slice(0, i).trim().split(/\s+/);
  const last = (words[words.length - 1] || '').replace(/^[[(（]+|[\])）.]+$/g, '').toUpperCase();
  if (!last) return [];
  const out = [last];
  const u = last.lastIndexOf('_');
  if (u >= 0 && u < last.length - 1) out.push(last.slice(u + 1));
  // 띄어쓰기 없이 붙은 모델 코드 — "티셔츠E6S161" → E6S161 (한글 바로 뒤의 영문+숫자 코드, 영문·숫자가 둘 다 있어야: "세트2" 는 아님)
  const g = /[가-힣]([A-Z0-9-]{4,})$/.exec(last);
  if (g && /[A-Z]/.test(g[1]) && /\d/.test(g[1]) && !out.includes(g[1])) out.push(g[1]);
  return out;
}

const SIZE_RE = /^(\d{2,3})(?:\s*[~-]\s*(\d{2,3}))?(?:\s*cm)?(?=$|\s|\()/i;
/**
 * 이유몽 상품명 → { eyoumong, size, age }
 *   eyoumong=false  : 이유몽 상품이 아님 (권장연령 대상 아님)
 *   size=null        : 사이즈 숫자를 못 찾음
 *   age=null         : 숫자는 있는데 표에 없음
 */
function sizeAge(name) {
  const s = normText(name);
  if (!s.startsWith(EYOUMONG)) return { eyoumong: false, size: null, age: null };
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  const cands = parts.length > 1 ? parts.slice(1).reverse() : [s.split(' ').pop()];
  let first = null;
  for (const c of cands) {
    const m = SIZE_RE.exec(c);
    if (!m) continue;
    const size = m[2] ? `${m[1]}~${m[2]}` : m[1];
    const age = AGE_BY_SIZE[Number(m[2] || m[1])] || null;
    if (age) return { eyoumong: true, size, age };
    if (!first) first = size;
  }
  return { eyoumong: true, size: first, age: null };
}

/**
 * 엑셀 행 → 모델별 혼용률
 *   rows: [{ sheet, row, model, comp }]  (D열·I열 값 그대로)
 *   → { map: Map(모델 대문자 → 혼용률), conflicts: [{ model, key, values:[{comp, sheet, row}] }], models, rows, blankComp, header, blankModel }
 *     models = 혼용률이 있는 모델 수 (map + conflicts) · rows = 모델이 있는 행 · blankComp = 모델은 있는데 혼용률이 빈 행
 *   머리글 행(D = '상품명' 또는 I = '제품소재')과 모델이 빈 행은 센 뒤 건너뛴다.
 */
function buildCompositionMap(rows) {
  const by = new Map();   // KEY → { model, values: Map(sameKey → {comp, sheet, row}) }
  let used = 0, blankComp = 0, header = 0, blankModel = 0;
  for (const r of rows || []) {
    const model = normText(r && r.model);
    const comp = normText(r && r.comp);
    if (model === '상품명' || comp === '제품소재') { header++; continue; }
    if (!model) { blankModel++; continue; }
    used++;
    if (!comp) { blankComp++; continue; }
    const key = model.toUpperCase();
    const e = by.get(key) || by.set(key, { model, values: new Map() }).get(key);
    const k = sameKey(comp);
    if (!e.values.has(k)) e.values.set(k, { comp, sheet: r.sheet || '', row: r.row || 0 });
  }
  const map = new Map();
  const conflicts = [];
  for (const [key, e] of by) {
    const vals = [...e.values.values()];
    if (vals.length === 1) map.set(key, vals[0].comp);
    else conflicts.push({ model: e.model, key, values: vals });
  }
  conflicts.sort((a, b) => a.model.localeCompare(b.model, 'ko', { numeric: true }));
  return { map, conflicts, models: by.size, rows: used, blankComp, header, blankModel };
}

/**
 * 계획 — 상품마다 무엇을 할지
 *   inventories: [{ id, sku_id, name, barcode, composition, recommanded_age }]
 *   comp: buildCompositionMap 결과 (null 이면 혼용률은 계산하지 않는다 = 권장연령만)
 *   → {
 *       comp: { fill[], change[], keep[], same, conflict[], noModel, noMatch, excelUnused } | null
 *         fill   = 빈칸 → 엑셀 값 (적용)
 *         change = 다른 값 → 엑셀 값 (overwrite 일 때만 여기에, 적용)
 *         keep   = 다른 값인데 overwrite 가 아니라 그대로 둠
 *       age:  { fill[], unresolved[], differ[], has }
 *         has    = 이미 값이 있음 (규칙과 같거나 규칙으로 못 정하는 사이즈) · differ = 이미 값이 있는데 규칙과 다름 (바꾸지 않는다)
 *       updates: { comp: Map(값 → {fill:[id], change:[id]}), age: Map(값 → [id]) }
 *     }
 *   목록 항목 = { id, sku, name, barcode, before, after, model?, size? }
 */
function planCompAge({ inventories, comp, overwrite }) {
  const compUpd = new Map();
  const ageUpd = new Map();
  const c = comp ? { fill: [], change: [], keep: [], same: 0, conflict: [], noModel: 0, noMatch: 0, excelUnused: 0 } : null;
  const a = { fill: [], unresolved: [], differ: [], has: 0 };
  const conflictKeys = comp ? new Set(comp.conflicts.map((x) => x.key)) : null;
  const usedKeys = new Set();
  const item = (r, extra) => ({ id: r.id, sku: normText(r.sku_id), name: normText(r.name), barcode: normText(r.barcode), ...extra });

  for (const r of inventories || []) {
    // ── 혼용률 ──
    if (c) {
      const keys = modelKeys(r.name);
      if (!keys.length) c.noModel++;
      else {
        let hit = null, conflictKey = null;
        for (const k of keys) {
          if (comp.map.has(k)) { hit = k; break; }
          if (conflictKeys.has(k)) { conflictKey = k; break; }
        }
        const before = normText(r.composition);
        if (hit) {
          usedKeys.add(hit);
          const after = comp.map.get(hit);
          if (!before) {
            c.fill.push(item(r, { model: hit, before, after }));
            (compUpd.get(after) || compUpd.set(after, { fill: [], change: [] }).get(after)).fill.push(r.id);
          } else if (sameKey(before) === sameKey(after)) c.same++;
          else if (overwrite) {
            c.change.push(item(r, { model: hit, before, after }));
            (compUpd.get(after) || compUpd.set(after, { fill: [], change: [] }).get(after)).change.push(r.id);
          } else c.keep.push(item(r, { model: hit, before, after }));
        } else if (conflictKey) {
          usedKeys.add(conflictKey);
          c.conflict.push(item(r, { model: conflictKey, before }));
        } else c.noMatch++;
      }
    }
    // ── 권장연령 (이유몽만, 빈칸만) ──
    const sa = sizeAge(r.name);
    if (!sa.eyoumong) continue;
    const before = normText(r.recommanded_age);
    if (before) {
      if (!sa.age || before === sa.age) a.has++;
      else a.differ.push(item(r, { size: sa.size, before, after: sa.age }));
      continue;
    }
    if (!sa.age) { a.unresolved.push(item(r, { size: sa.size, before })); continue; }
    a.fill.push(item(r, { size: sa.size, before, after: sa.age }));
    (ageUpd.get(sa.age) || ageUpd.set(sa.age, []).get(sa.age)).push(r.id);
  }
  if (c) {
    for (const k of comp.map.keys()) if (!usedKeys.has(k)) c.excelUnused++;
    for (const x of comp.conflicts) if (!usedKeys.has(x.key)) c.excelUnused++;
  }
  return { comp: c, age: a, updates: { comp: compUpd, age: ageUpd } };
}

module.exports = { AGE_BY_SIZE, EYOUMONG, normText, sameKey, isBlank, modelKeys, sizeAge, buildCompositionMap, planCompAge };
