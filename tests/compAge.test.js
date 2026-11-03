/**
 * 혼용률 · 권장연령 채우기 규칙 단위 테스트 — 프레임워크 없이 node 로 실행
 *   node tests/compAge.test.js
 */
const assert = require('assert');
const { modelKeys, sizeAge, buildCompositionMap, planCompAge } = require('../compAge');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }
const inv = (id, name, composition = null, age = null) => ({ id, sku_id: String(id), name, barcode: 'B' + id, composition, recommanded_age: age });
const xrow = (model, comp, sheet = '작업리스트ER', row = 2) => ({ sheet, row, model, comp });

test('모델명 = 첫 콤마 앞 마지막 단어 (대문자)', () => {
  assert.deepStrictEqual(modelKeys('이유몽 아동용 루즈핏 라운드넥 스트라이프 긴팔 티셔츠 E6S107, 블루, 140'), ['E6S107']);
  assert.deepStrictEqual(modelKeys('이유몽 아동 토이루 배색 나그랑 패치 티셔츠, 햄버거, 130~140'), ['티셔츠']);
  assert.deepStrictEqual(modelKeys('아이엠몽 여성 브이넥 민소매 티셔츠_슈에므, M, 화이트'), ['티셔츠_슈에므', '슈에므']);
  assert.deepStrictEqual(modelKeys('아이엠몽 여성 퍼프소매 베이직 긴팔 셔츠 블라우스'), []);   // 콤마 없음 → 모델 없음
  assert.deepStrictEqual(modelKeys('e6s107, 블루'), ['E6S107']);
  assert.deepStrictEqual(modelKeys('이유몽 아동 베이직핏 패턴 웨이브 간소매 티셔츠E6S161, 차콜, 140'), ['티셔츠E6S161', 'E6S161']);   // 붙어 쓴 모델
  assert.deepStrictEqual(modelKeys('이유몽 아동 양말 세트2, 블랙, L'), ['세트2']);   // 숫자만 붙은 건 모델 아님
});

test('이유몽 사이즈 → 권장연령 (DB 표 그대로, 범위는 큰 쪽)', () => {
  assert.deepStrictEqual(sizeAge('이유몽 아동 티셔츠 E6S107, 블루, 140'), { eyoumong: true, size: '140', age: '9-11세' });
  assert.strictEqual(sizeAge('이유몽 아동 티셔츠 E6S107, 블루, 120').age, '5-7세');
  assert.strictEqual(sizeAge('이유몽 아동 티셔츠 E6S107, 블루, 130').age, '7-9세');
  assert.strictEqual(sizeAge('이유몽 주니어 티셔츠 E6F032, 블랙, 150').age, '11-12세');
  assert.strictEqual(sizeAge('이유몽 주니어 패딩 E6W277, 베이지, 160').age, '12-14세');
  assert.strictEqual(sizeAge('이유몽 아동 가디건, 아이보리, 110~120').age, '5-7세');
  assert.strictEqual(sizeAge('이유몽 아동 가디건, 아이보리, 120-130').age, '7-9세');
  assert.strictEqual(sizeAge('이유몽 아동 가디건, 아이보리, 140 혼합색상').age, '9-11세');
  assert.strictEqual(sizeAge('이유몽 아동 티셔츠, 140, 핑크').age, '9-11세');                 // 사이즈가 색상 앞
  assert.strictEqual(sizeAge('이유몽 아동 티셔츠 E6W173, 2P(화이트+핑크), 120').age, '5-7세');
  assert.strictEqual(sizeAge('이유몽 아동용 요니비 레인코트 팬다블루 120~130').age, '7-9세');  // 콤마 없음 → 마지막 단어
});

test('이유몽이 아니면 권장연령 대상 아님 · 표에 없는 숫자는 못 정함', () => {
  assert.strictEqual(sizeAge('아이엠몽 여성 셔츠 R6S063, 블루, FREE').eyoumong, false);
  assert.deepStrictEqual(sizeAge('이유몽 아동 티셔츠, 블루, 110'), { eyoumong: true, size: '110', age: null });
  assert.deepStrictEqual(sizeAge('이유몽 아동 티셔츠, 블루, FREE'), { eyoumong: true, size: null, age: null });
});

test('엑셀 모델 맵: 머리글 건너뜀 · 공백만 다른 값은 같음 · 다른 값은 충돌', () => {
  const m = buildCompositionMap([
    xrow('상품명', '제품소재', '작업리스트BR', 1),
    xrow('E6S107', '면 100%'),
    xrow('e6s107', ' 면  100% '),
    xrow('노이타', '폴리 70%+아크릴 30%', '작업리스트BR', 3),
    xrow('노이타', '폴리에스터 100%', '작업리스트BR', 9),
    xrow('빈값', ''),
    xrow('', '면 100%'),
  ]);
  assert.strictEqual(m.header, 1);
  assert.strictEqual(m.blankModel, 1);
  assert.strictEqual(m.blankComp, 1);
  assert.strictEqual(m.map.get('E6S107'), '면 100%');
  assert.strictEqual(m.map.has('노이타'), false);
  assert.strictEqual(m.conflicts.length, 1);
  assert.strictEqual(m.conflicts[0].values.length, 2);
  assert.strictEqual(m.models, 2);   // 혼용률이 있는 모델만: E6S107 · 노이타 (빈값 은 혼용률이 없어 안 센다)
});

test('계획: 빈칸만 채움 · 다른 값은 유지(keep) · 같은 값 · 충돌 · 매칭 없음', () => {
  const comp = buildCompositionMap([xrow('E6S107', '면 100%'), xrow('노이타', 'A'), xrow('노이타', 'B'), xrow('미사용', '면 50%')]);
  const p = planCompAge({
    comp,
    overwrite: false,
    inventories: [
      inv(1, '이유몽 아동 티셔츠 E6S107, 블루, 140'),
      inv(2, '이유몽 아동 티셔츠 E6S107, 블루, 150', '폴리 100%', '11-12세'),
      inv(3, '이유몽 아동 티셔츠 E6S107, 블루, 130', '면100%', '7-9세'),
      inv(4, '아이엠몽 여성 니트 노이타, 블랙, FREE'),
      inv(5, '아이엠몽 여성 니트 R6S001, 블랙, FREE'),
      inv(6, '아이엠몽 여성 퍼프소매 베이직 긴팔 셔츠 블라우스'),
    ],
  });
  assert.deepStrictEqual(p.comp.fill.map((x) => x.id), [1]);
  assert.deepStrictEqual(p.comp.keep.map((x) => x.id), [2]);
  assert.strictEqual(p.comp.change.length, 0);
  assert.strictEqual(p.comp.same, 1);
  assert.deepStrictEqual(p.comp.conflict.map((x) => x.id), [4]);
  assert.strictEqual(p.comp.noMatch, 1);
  assert.strictEqual(p.comp.noModel, 1);
  assert.strictEqual(p.comp.excelUnused, 1);   // 미사용
  assert.deepStrictEqual([...p.updates.comp.entries()], [['면 100%', { fill: [1], change: [] }]]);
  // 권장연령: 1 만 빈칸 → 9-11세. 2·3 은 이미 있고 규칙과 같다
  assert.deepStrictEqual(p.age.fill.map((x) => [x.id, x.after]), [[1, '9-11세']]);
  assert.strictEqual(p.age.has, 2);
  assert.deepStrictEqual([...p.updates.age.entries()], [['9-11세', [1]]]);
});

test('계획: overwrite 면 다른 값도 바꿈(change) · 권장연령은 여전히 빈칸만', () => {
  const comp = buildCompositionMap([xrow('E6S107', '면 100%')]);
  const p = planCompAge({ comp, overwrite: true, inventories: [inv(2, '이유몽 아동 티셔츠 E6S107, 블루, 150', '폴리 100%', '9-11세')] });
  assert.deepStrictEqual(p.comp.change.map((x) => [x.id, x.before, x.after]), [[2, '폴리 100%', '면 100%']]);
  assert.strictEqual(p.comp.keep.length, 0);
  assert.deepStrictEqual([...p.updates.comp.entries()], [['면 100%', { fill: [], change: [2] }]]);
  assert.strictEqual(p.age.fill.length, 0);
  assert.deepStrictEqual(p.age.differ.map((x) => [x.id, x.before, x.after]), [[2, '9-11세', '11-12세']]);   // 알려만 주고 안 바꾼다
  assert.strictEqual(p.updates.age.size, 0);
});

test('계획: 혼용률 없이(권장연령만) · 사이즈로 못 정하는 이유몽', () => {
  const p = planCompAge({ comp: null, inventories: [inv(1, '이유몽 아동 티셔츠, 블루, 110'), inv(2, '이유몽 아동 티셔츠, 블루, 120'), inv(3, '아이엠몽 셔츠, 블루, M')] });
  assert.strictEqual(p.comp, null);
  assert.deepStrictEqual(p.age.unresolved.map((x) => [x.id, x.size]), [[1, '110']]);
  assert.deepStrictEqual(p.age.fill.map((x) => x.id), [2]);
  assert.strictEqual(p.updates.comp.size, 0);
});

test("모델 후보: '_' 앞 전체가 없으면 뒷부분으로 매칭", () => {
  const comp = buildCompositionMap([xrow('슈에므', '면 100%')]);
  const p = planCompAge({ comp, inventories: [inv(1, '아이엠몽 여성 브이넥 민소매 티셔츠_슈에므, M, 화이트')] });
  assert.deepStrictEqual(p.comp.fill.map((x) => [x.id, x.model]), [[1, '슈에므']]);
});

console.log(`\n${n} tests passed`);
