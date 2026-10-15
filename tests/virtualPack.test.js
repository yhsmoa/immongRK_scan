/**
 * 가상스캔 배정 알고리즘 단위 테스트 — 프레임워크 없이 node 로 실행
 *   node tests/virtualPack.test.js
 *
 * 단위: 상품 1개 = 10 L (1000×1000×10 mm), 0.5 kg.
 * 알고리즘 테스트는 **고정 보정값(TEST_CAL)** 으로 돈다: 용량(overfill 5% 포함) 극소 37.8 → 3개 · 중 126 → 12개 · 대2 294 → 29개, 무게 25 kg 미만.
 *   (운영 CONFIG 는 2026-10-15 에 실제 박스 표본 용량 100/200/480 으로 바뀌었다(무게 25 kg 은 그대로) — 기본값 자체는 맨 아래 'CONFIG 기본값' 테스트로 본다)
 */
const assert = require('assert');
const { planVirtualScan: planRaw, applyPlan, CONFIG, capL, unitOf } = require('../virtualPack');

const SIZE10 = { w: 1000, l: 1000, h: 10, g: 500 };
const prod = (barcode, alloc, { conf = alloc, scanned = 0, size = SIZE10, name = barcode } = {}) =>
  ({ barcode, productName: name, orderQty: conf, allocQty: alloc, scannedQty: scanned, size, location: '' });
const TEST_CAL = { baseCapL: { '극소': 36, '중': 120, '대2': 280 }, overfill: 0.05, maxKg: 25 };
const CAL = Object.assign({}, CONFIG, TEST_CAL);   // capL/unitOf 직접 호출용
// 알고리즘 테스트는 전부 TEST_CAL 로 (직접 호출도 같은 보정값). 운영 기본값을 보는 테스트만 planRaw 를 쓴다
const planVirtualScan = (input, cfg) => planRaw(input, Object.assign({}, TEST_CAL, cfg || {}));
const run = (products, extra = {}, cfg) => planVirtualScan(Object.assign({ products, boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, extra), cfg);
const shape = (plan) => plan.boxes.map((b) => `${b.boxNo}:${b.size}:${b.addQty}`).join(' ');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

test('용량: base × (1 + overfill)', () => {
  assert.strictEqual(capL('극소', CAL), 36 * 1.05);
  assert.strictEqual(capL('대2', CAL), 280 * 1.05);
  assert.strictEqual(capL('소', CAL), null);
});

test('단위: 측정값 / 임시값 / 누락', () => {
  assert.deepStrictEqual(unitOf(SIZE10, CONFIG), { L: 10, kg: 0.5, flag: null });
  assert.strictEqual(unitOf({ w: 300, l: 300, h: 20, g: 200 }, CONFIG).flag, 'placeholder');
  assert.strictEqual(unitOf({ w: 300, l: 300, h: 20, g: 200 }, CONFIG).L, CONFIG.defaultUnitL);
  assert.strictEqual(unitOf(null, CONFIG).flag, 'missing');
  assert.strictEqual(unitOf({ w: 100, l: 100, h: 100, g: null }, CONFIG).kg, CONFIG.defaultUnitKg);
});

test('딱 대2 두 박스 (58개 = 580 L)', () => {
  const p = run([prod('A', 58)]);
  assert.ok(p.ok);
  assert.strictEqual(shape(p), '1:대2:29 2:대2:29');
  assert.strictEqual(p.totals.newBoxes, 2);
});

test('대2 + 중 (40개 = 400 L)', () => {
  assert.strictEqual(shape(run([prod('A', 40)])), '1:대2:29 2:중:11');
});

test('대2 + 극소 (32개 = 320 L)', () => {
  assert.strictEqual(shape(run([prod('A', 32)])), '1:대2:29 2:극소:3');
});

test('중 1개 (10개) · 극소 1개 (3개) · 극소 한도 넘으면 중 (4개)', () => {
  assert.strictEqual(shape(run([prod('A', 10)])), '1:중:10');
  assert.strictEqual(shape(run([prod('A', 3)])), '1:극소:3');
  assert.strictEqual(shape(run([prod('A', 4)])), '1:중:4');
});

test('수량 많은 상품부터 담는다 (바코드 분할 허용)', () => {
  const p = run([prod('B', 5), prod('A', 32), prod('C', 1)]);
  // A 32 → 박스1(대2) 29 + 박스2 3, 그 다음 B 5, C 1 → 박스2 = 9개(90 L) → 중
  assert.strictEqual(shape(p), '1:대2:29 2:중:9');
  assert.strictEqual(p.boxes[0].items[0].barcode, 'A');
  assert.deepStrictEqual(p.boxes[1].items.map((i) => `${i.barcode}:${i.qty}`), ['A:3', 'B:5', 'C:1']);
});

test('목표 = min(배정, 확정) − 스캔 · 배정 없음/이미 완료 제외', () => {
  const p = run([
    prod('A', 10, { conf: 6 }),          // 확정 6 까지만
    prod('B', 5, { scanned: 2 }),        // 3 남음
    prod('C', 0),                        // 배정 없음
    prod('D', 4, { scanned: 4 }),        // 이미 완료
  ]);
  assert.strictEqual(p.totals.qty, 9);
  assert.deepStrictEqual(p.excluded.map((e) => `${e.barcode}:${e.reason}`), ['C:배정 없음', 'D:이미 완료']);
  assert.ok(p.warnings.some((w) => w.includes('확정수량까지만')));
});

const withBox1 = (size, usedQty, products) => ({ products: [...products, prod('Z', usedQty, { scanned: usedQty })],
  boxItems: [{ boxNo: 1, barcode: 'Z', qty: usedQty }], savedBoxes: [{ boxNo: 1, boxSize: size }], boxSizeMap: new Map() });

test('기존 박스(저장됨) 남은 용량부터 채운다 — 다 들어가면 크기 그대로', () => {
  // 박스1 중: 이미 5개(50 L) → 남은 82 L → 신규 6개(60 L) 는 전부 들어감
  const p = planVirtualScan(withBox1('중', 5, [prod('A', 6)]));
  assert.strictEqual(shape(p), '1:중:6');
  assert.strictEqual(p.boxes[0].isNew, false);
  assert.strictEqual(p.boxes[0].usedQty0, 5);
  assert.strictEqual(p.boxes[0].sizeFrom, null);
  assert.strictEqual(p.totals.topUpBoxes, 1);
  assert.strictEqual(p.totals.newBoxes, 0);
});

test('크기 UP: 마지막 박스에 다 안 들어가면 다 들어가는 가장 작은 크기로 올린다', () => {
  // 박스1 중 5개(50 L) + 신규 20개(200 L) = 250 L > 중 126 → 대2(294) 로 올리고 전부 담는다
  const p = planVirtualScan(withBox1('중', 5, [prod('A', 20)]));
  assert.strictEqual(shape(p), '1:대2:20');
  assert.strictEqual(p.boxes[0].sizeFrom, '중');
  assert.strictEqual(p.totals.upgradedBoxes, 1);
  assert.ok(p.boxes[0].warnings.some((w) => w.includes('크기 변경 중 → 대2')));
  // 극소 3개(30 L) + 5개(50 L) = 80 L → 중 (대2 까지 갈 필요 없음). 세션(미저장) 박스여도 동일
  const p2 = planVirtualScan({ products: [prod('A', 5), prod('Z', 3, { scanned: 3 })],
    boxItems: [{ boxNo: 2, barcode: 'Z', qty: 3 }], savedBoxes: [], boxSizeMap: new Map([[2, '극소']]) });
  assert.strictEqual(shape(p2), '2:중:5');
  assert.strictEqual(p2.boxes[0].sizeFrom, '극소');
});

test('크기 UP: 대2 로도 다 안 들어가면 대2 로 올리고 나머지는 새 박스', () => {
  // 박스1 극소 1개(10 L) + 60개(600 L) → 대2(294) 에 28개 더, 나머지 32개 → 대2 29 + 극소 3
  const p = planVirtualScan(withBox1('극소', 1, [prod('A', 60)]));
  assert.strictEqual(shape(p), '1:대2:28 2:대2:29 3:극소:3');
  assert.strictEqual(p.boxes[0].sizeFrom, '극소');
});

test('크기 UP 은 부피 기준 — 무게 때문에 못 담는 건 올리지 않는다', () => {
  const heavy = { w: 1000, l: 1000, h: 10, g: 2500 };
  // 박스1 중 1개(10 L · 2.5 kg) + 10개(100 L · 25 kg): 부피 110 ≤ 126 → 크기 유지, 무게로 8개까지 → 나머지 2개 새 박스
  const p = planVirtualScan({ products: [prod('A', 10, { size: heavy }), prod('Z', 1, { scanned: 1, size: heavy })],
    boxItems: [{ boxNo: 1, barcode: 'Z', qty: 1 }], savedBoxes: [{ boxNo: 1, boxSize: '중' }], boxSizeMap: new Map() });
  assert.strictEqual(shape(p), '1:중:8 2:극소:2');
  assert.strictEqual(p.boxes[0].sizeFrom, null);
});

test('이미 가장 큰 크기(대2)가 꽉 찼으면 그대로 두고 새 박스 (경고)', () => {
  // 박스1 대2 에 31개(310 L > 294) → 0개 추가, 신규 5개(50 L > 극소 37.8) → 중
  const p = planVirtualScan(withBox1('대2', 31, [prod('A', 5)]));
  assert.strictEqual(shape(p), '1:대2:0 2:중:5');
  assert.ok(p.warnings.some((w) => w.includes('그대로 둔 기존 박스')));
});

test('옵션 upgradeLastBox=false — 크기를 올리지 않고 남은 용량만 채운다', () => {
  // 박스1 중 5개(50 L) 남은 76 L → 7개, 나머지 13개(130 L) > 중 126 → 대2
  const p = planVirtualScan(withBox1('중', 5, [prod('A', 20)]), { upgradeLastBox: false });
  assert.strictEqual(shape(p), '1:중:7 2:대2:13');
  assert.strictEqual(p.boxes[0].sizeFrom, null);
});

test('기존 박스가 여러 개면 마지막 박스만 채운다 (앞 박스는 마감)', () => {
  // 박스1(중) 2개, 박스2(중) 3개, 박스3(중) 5개 — 1·2 는 여유가 많아도 건드리지 않고 3 만 8개 더
  const p = planVirtualScan({
    products: [prod('A', 20), prod('Z', 10, { scanned: 10 })],
    boxItems: [{ boxNo: 1, barcode: 'Z', qty: 2 }, { boxNo: 2, barcode: 'Z', qty: 3 }, { boxNo: 3, barcode: 'Z', qty: 5 }],
    savedBoxes: [{ boxNo: 1, boxSize: '중' }, { boxNo: 2, boxSize: '중' }, { boxNo: 3, boxSize: '중' }], boxSizeMap: new Map() });
  assert.strictEqual(shape(p), '3:대2:20');                 // 3 만 채우되 다 안 들어가므로 대2 로 크기 UP
  assert.ok(!p.boxes.some((b) => b.boxNo === 1 || b.boxNo === 2));
  assert.ok(p.warnings.some((w) => w.includes('앞 박스 📦1, 📦2') && w.includes('마지막 박스 📦3')));
  // 마지막 박스가 세션(미저장) 박스여도 같은 규칙
  const p2 = planVirtualScan({
    products: [prod('A', 5), prod('Z', 3, { scanned: 3 })],
    boxItems: [{ boxNo: 1, barcode: 'Z', qty: 1 }, { boxNo: 2, barcode: 'Z', qty: 2 }],
    savedBoxes: [{ boxNo: 1, boxSize: '중' }], boxSizeMap: new Map([[2, '중']]) });
  assert.strictEqual(shape(p2), '2:중:5');
});

test('옵션 topUpExisting=false — 기존 박스는 그대로 두고 새 박스만 (번호는 비켜 감)', () => {
  const input = { products: [prod('A', 20), prod('Z', 5, { scanned: 5 })], boxItems: [{ boxNo: 1, barcode: 'Z', qty: 5 }],
    savedBoxes: [{ boxNo: 1, boxSize: '중' }], boxSizeMap: new Map() };
  const on = planVirtualScan(input);
  const off = planVirtualScan(input, { topUpExisting: false });
  assert.strictEqual(shape(on), '1:대2:20');                  // 박스1 을 대2 로 올려 전부
  assert.strictEqual(shape(off), '2:대2:20');                 // 200 L > 중 126 → 대2, 박스1은 건드리지 않음
  assert.ok(off.boxes.every((b) => b.isNew));
  assert.strictEqual(off.totals.topUpBoxes, 0);
  assert.strictEqual(off.assumptions.topUpExisting, false);
  assert.ok(off.warnings.some((w) => w.includes('그대로 두고 새 박스만')));
  assert.ok(!off.warnings.some((w) => w.includes('남은 용량이 없어')));
});

test('용량 기준 없는 기존 박스(소/대)는 채우지 않고 경고', () => {
  const p = planVirtualScan({ products: [prod('A', 2)], boxItems: [{ boxNo: 1, barcode: 'A', qty: 0 }],
    savedBoxes: [{ boxNo: 1, boxSize: '대' }], boxSizeMap: new Map() });
  assert.strictEqual(shape(p), '2:극소:2');
  assert.ok(p.warnings.some((w) => w.includes('용량 기준이 없는')));
});

test('무게 25 kg 미만 — 넘기 전에 박스를 나눈다', () => {
  // 1개 10 L · 2.5 kg: 부피로는 30개지만 무게는 9개(22.5 kg)까지 (10개 = 25.0 은 불가)
  const heavy = { w: 1000, l: 1000, h: 10, g: 2500 };
  const p = run([prod('A', 20, { size: heavy })]);
  assert.deepStrictEqual(p.boxes.map((b) => b.addQty), [9, 9, 2]);
  assert.ok(p.boxes.every((b) => b.usedKg < 25));
  assert.ok(p.boxes[0].warnings.some((w) => w.includes('무게')));
});

test('임시 사이즈 상품은 2.85 L 로 가정하고 집계', () => {
  const p = run([prod('A', 10, { size: { w: 300, l: 300, h: 20, g: 200 } })]);
  assert.strictEqual(p.assumptions.assumedCount, 1);
  assert.ok(Math.abs(p.totals.L - 28.5) < 1e-9);
  assert.strictEqual(shape(p), '1:극소:10');
  assert.ok(p.boxes[0].warnings.some((w) => w.includes('사이즈 가정')));
});

test('박스 번호 부족 → ok=false', () => {
  const p = run([prod('A', 100)], {}, { maxBoxNo: 2 });
  assert.strictEqual(p.ok, false);
  assert.ok(/박스 번호가 부족/.test(p.reason));
});

test('담을 것이 없으면 ok=false + 사유', () => {
  assert.strictEqual(run([]).ok, false);
  const p = run([prod('A', 3, { scanned: 3 })]);
  assert.strictEqual(p.ok, false);
  assert.ok(/이미 모두 스캔/.test(p.reason));
});

test('단일 상품이 한도를 넘어도 멈추지 않는다 (1개 강제 + 경고)', () => {
  const huge = { w: 1000, l: 1000, h: 400, g: 500 }; // 400 L > 대2 294
  const p = run([prod('A', 2, { size: huge })]);
  assert.ok(p.ok);
  assert.deepStrictEqual(p.boxes.map((b) => `${b.size}:${b.addQty}`), ['대2:1', '대2:1']);
  assert.ok(p.boxes[0].warnings.some((w) => w.includes('한도')));
});

test('입력을 변형하지 않는다', () => {
  const products = [prod('A', 5)]; const boxItems = [{ boxNo: 1, barcode: 'A', qty: 1 }];
  const snap = JSON.stringify({ products, boxItems });
  planVirtualScan({ products, boxItems, savedBoxes: [{ boxNo: 1, boxSize: '중' }], boxSizeMap: new Map() });
  assert.strictEqual(JSON.stringify({ products, boxItems }), snap);
});

// ── 출처별 분리 (2026-10-15): 입고분을 먼저, 재고분은 새 박스부터 ──
const prodS = (barcode, inb, stk, opts = {}) => Object.assign(prod(barcode, inb + stk, opts), { allocInbound: inb, allocStock: stk });

test('출처 분리: 입고분과 재고분이 다른 박스에, 입고가 먼저', () => {
  const p = run([prodS('A', 5, 5), prodS('B', 4, 2)]);   // 입고 9개(90 L → 중) · 재고 7개(70 L → 중)
  assert.ok(p.ok);
  assert.deepStrictEqual(p.boxes.map((b) => `${b.boxNo}:${b.size}:${b.source}:${b.addQty}`), ['1:중:입고:9', '2:중:재고:7']);
  assert.deepStrictEqual(p.totals.bySource, { '입고': 9, '재고': 7 });
  assert.ok(p.warnings.some((w) => w.includes('출처별로 나눠')));
  assert.ok(p.boxes[0].items.every((i) => i.source === '입고') && p.boxes[1].items.every((i) => i.source === '재고'));
});

test('출처 분리: 새 박스 크기는 그 출처의 남은 부피로 정한다 (재고 2개 → 극소)', () => {
  const p = run([prodS('A', 12, 2)]);   // 입고 12 → 중 · 재고 2 → 극소 (합쳐 셌다면 대2 하나)
  assert.deepStrictEqual(shape(p), '1:중:12 2:극소:2');
});

test('출처 분리 끔(splitBySource:false): 예전처럼 한데 담는다', () => {
  const p = run([prodS('A', 12, 2)], {}, { splitBySource: false });
  assert.deepStrictEqual(shape(p), '1:대2:14');   // 140 L > 중 126 L → 대2 하나 (나누면 중 + 극소)
  assert.strictEqual(p.boxes[0].source, null);
  assert.strictEqual(p.assumptions.splitActive, false);
});

test('출처 분리: 기존 마지막 박스는 먼저 담는 출처(입고)만 채우고, 재고는 새 박스', () => {
  const p = run([prodS('A', 2, 3)], { boxItems: [{ boxNo: 1, barcode: 'Z', qty: 1 }], savedBoxes: [{ boxNo: 1, boxSize: '중' }] });
  assert.deepStrictEqual(p.boxes.map((b) => `${b.boxNo}:${b.isNew ? '신규' : '기존'}:${b.source}:${b.addQty}`), ['1:기존:입고:2', '2:신규:재고:3']);
});

test('출처 분리: 스캔한 개수는 입고분부터 빼고, 확정이 배정보다 작으면 재고분부터 줄인다', () => {
  const p1 = run([prodS('A', 4, 3, { scanned: 5 })]);                 // 남은 2 = 재고분
  assert.deepStrictEqual(p1.boxes.map((b) => `${b.source}:${b.addQty}`), ['재고:2']);
  const p2 = run([prodS('A', 4, 3, { conf: 5 })]);                    // 목표 5 = 입고 4 + 재고 1
  assert.deepStrictEqual(p2.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:4', '재고:1']);
});

test('대상 선택(sourceFilter): 입고만 / 재고만 담고 나머지는 제외로 기록', () => {
  const pi = run([prodS('A', 5, 5), prodS('B', 0, 3)], {}, { sourceFilter: '입고' });
  assert.deepStrictEqual(pi.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:5']);
  assert.ok(pi.excluded.some((e) => e.barcode === 'B' && e.reason === '입고 배정 없음'));
  assert.strictEqual(pi.assumptions.sourceFilter, '입고');
  const ps = run([prodS('A', 5, 5), prodS('B', 0, 3)], {}, { sourceFilter: '재고' });
  assert.deepStrictEqual(ps.boxes.map((b) => `${b.source}:${b.addQty}`), ['재고:8']);
  const none = run([prodS('A', 5, 0)], {}, { sourceFilter: '재고' });
  assert.strictEqual(none.ok, false);
  assert.ok(none.reason.includes('재고 배정분이 없습니다'));
  const legacy = run([prod('A', 5)], {}, { sourceFilter: '입고' });   // 출처 정보 없는 상품은 담지 않는다
  assert.strictEqual(legacy.ok, false);
  assert.ok(legacy.excluded.some((e) => e.reason === '출처 정보 없음'));
});

test('입고코드 선택(inboundCodes): 고른 코드의 입고분만, 다른 코드는 "다른 입고코드" 로 제외', () => {
  const pc = (barcode, byCode, stk = 0, opts = {}) => {
    const inb = Object.values(byCode).reduce((s, v) => s + v, 0);
    return Object.assign(prod(barcode, inb + stk, opts), { allocInbound: inb, allocStock: stk, allocInboundByCode: byCode });
  };
  const p = run([pc('A', { '1011': 4, '1015': 3 }, 2)], {}, { sourceFilter: '입고', inboundCodes: ['1011'] });
  assert.deepStrictEqual(p.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:4']);
  assert.ok(p.excluded.some((e) => e.reason === '다른 입고코드' && e.qty === 3));
  assert.ok(p.warnings.some((w) => w.includes('다른 입고코드') || w.includes('고른 입고코드')));
  // 전체 + 코드 선택: 1011 입고분 4 → 재고 2, 1015 분 3은 제외
  const all = run([pc('A', { '1011': 4, '1015': 3 }, 2)], {}, { inboundCodes: ['1011'] });
  assert.deepStrictEqual(all.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:4', '재고:2']);
  // 두 코드 모두 고르면 전부
  const both = run([pc('A', { '1011': 4, '1015': 3 }, 2)], {}, { sourceFilter: '입고', inboundCodes: ['1011', '1015'] });
  assert.deepStrictEqual(both.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:7']);
  // 스캔은 고른 입고 → 다른 입고 → 재고 순으로 뺀다: 1011 분 4개를 이미 담았으면 1015 로 돌릴 때 3개
  const later = run([pc('A', { '1011': 4, '1015': 3 }, 2, { scanned: 4 })], {}, { sourceFilter: '입고', inboundCodes: ['1015'] });
  assert.deepStrictEqual(later.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:3']);
  assert.deepStrictEqual(later.assumptions.inboundCodes, ['1015']);
});

test('출처 분리: 출처 정보가 없는 상품은 예전과 같다', () => {
  const p = run([prod('A', 5), prod('B', 3)]);
  assert.deepStrictEqual(shape(p), '1:중:8');
  assert.strictEqual(p.boxes[0].source, null);
});

// ── applyPlan: 계획 → 저장 body (출고스캔 [확정] 과 같은 반영 규칙) ──
test('applyPlan: 새 박스 — 아이템 qty=virtualQty, 박스 크기는 계획대로', () => {
  const plan = run([prod('A', 5), prod('B', 3)]);
  const r = applyPlan({ boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, plan);
  assert.deepStrictEqual(r.boxes, [{ boxNo: 1, boxSize: '중' }]);
  assert.deepStrictEqual(r.items.map((i) => `${i.boxNo}:${i.barcode}:${i.qty}/${i.virtualQty}`), ['1:A:5/5', '1:B:3/3']);
  assert.strictEqual(r.addQty, 8); assert.strictEqual(r.boxCnt, 1); assert.strictEqual(r.upCnt, 0);
});

test('applyPlan: 기존 박스 채우기 — 같은 행에 더하고(virtual 만 증가) 빈 기존 박스도 목록에 남긴다', () => {
  const boxItems = [{ boxNo: 2, barcode: 'A', productName: 'A', qty: 1, virtualQty: 0 }];
  const savedBoxes = [{ boxNo: 1, boxSize: '극소' }, { boxNo: 2, boxSize: '중' }];
  const plan = run([prod('A', 3, { scanned: 1 }), prod('B', 2)], { boxItems, savedBoxes }, { topUpExisting: true });
  assert.deepStrictEqual(shape(plan), '2:중:4');
  const r = applyPlan({ boxItems, savedBoxes, boxSizeMap: new Map(savedBoxes.map((b) => [b.boxNo, b.boxSize])) }, plan);
  assert.deepStrictEqual(r.boxes, [{ boxNo: 1, boxSize: '극소' }, { boxNo: 2, boxSize: '중' }]);
  assert.deepStrictEqual(r.items.map((i) => `${i.boxNo}:${i.barcode}:${i.qty}/${i.virtualQty}`), ['2:A:3/2', '2:B:2/2']);
  assert.strictEqual(boxItems[0].qty, 1);   // 입력은 그대로
});

test('applyPlan: 크기 UP — 마지막 기존 박스의 크기가 계획 크기로 바뀐다', () => {
  const boxItems = [{ boxNo: 1, barcode: 'A', qty: 2, virtualQty: 0 }];
  const savedBoxes = [{ boxNo: 1, boxSize: '극소' }];
  const plan = run([prod('A', 8, { scanned: 2 })], { boxItems, savedBoxes }, { topUpExisting: true });
  assert.strictEqual(plan.boxes[0].sizeFrom, '극소');
  const r = applyPlan({ boxItems, savedBoxes, boxSizeMap: new Map([[1, '극소']]) }, plan);
  assert.strictEqual(r.boxes[0].boxSize, plan.boxes[0].size);
  assert.strictEqual(r.upCnt, 1);
});

test('applyPlan: 출처 분리로 같은 바코드가 두 박스에 나뉘어도 박스별 행으로', () => {
  const p = { barcode: 'A', productName: 'A', orderQty: 6, allocQty: 6, allocInbound: 4, allocStock: 2, allocInboundByCode: { '1011': 4 }, scannedQty: 0, size: SIZE10, location: '' };
  const plan = run([p], {}, { splitBySource: true, inboundCodes: ['1011'] });
  const r = applyPlan({ boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, plan);
  assert.deepStrictEqual(r.items.map((i) => `${i.boxNo}:${i.qty}/${i.virtualQty}`), ['1:4/4', '2:2/2']);
  assert.strictEqual(r.boxes.length, 2);
});

// ── 운영 기본값 (CONFIG) — 통계 용량 · 무게 제한 없음 (2026-10-15) ──
test('CONFIG 기본값: 용량은 실제 박스 상위 10개 표본 최솟값(극소 100 · 중 200 · 대2 480), 가산 0, 무게 25 kg 미만', () => {
  assert.deepStrictEqual(CONFIG.baseCapL, { '극소': 100, '중': 200, '대2': 480 });
  assert.strictEqual(CONFIG.overfill, 0);
  assert.strictEqual(CONFIG.maxKg, 25);
  assert.strictEqual(capL('중', CONFIG), 200);
});

test('기본값: 무게 25 kg 미만으로 나눈다 · maxKg null 이면 부피로만', () => {
  // 1개 10 L · 5 kg × 17 = 170 L · 85 kg → 기본값(25 kg)이면 4개씩(20 kg) 나뉜다. null 이면 중(200) 하나
  const heavy = { w: 1000, l: 1000, h: 10, g: 5000 };
  const p = planRaw({ products: [prod('A', 17, { size: heavy })], boxItems: [], savedBoxes: [], boxSizeMap: new Map() });
  assert.deepStrictEqual(p.boxes.map((b) => b.addQty), [4, 4, 4, 4, 1]);
  assert.ok(p.boxes.every((b) => b.usedKg < 25));
  assert.strictEqual(p.assumptions.maxKg, 25);
  const q = planRaw({ products: [prod('A', 17, { size: heavy })], boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, { maxKg: null });
  assert.deepStrictEqual(q.boxes.map((b) => `${b.size}:${b.addQty}`), ['중:17']);
  assert.ok(!q.boxes[0].warnings.some((w) => w.includes('무게')));
});

test('이미 담긴 분량의 출처: 실제 스캔은 재고부터, 가상스캔은 입고부터 뺀다', () => {
  // 입고(1011) 1 + 재고 8, 확정 9. 실제로 8개를 담아 둔 상태(박스1, virtualQty 0) → 재고 8이 담긴 것 → 입고 1이 남는다
  const p = { barcode: 'A', productName: 'A', orderQty: 9, allocQty: 9, allocInbound: 1, allocStock: 8, allocInboundByCode: { '1011': 1 }, scannedQty: 8, size: SIZE10, location: '' };
  const realBox = { boxItems: [{ boxNo: 1, barcode: 'A', qty: 8, virtualQty: 0 }], savedBoxes: [{ boxNo: 1, boxSize: '대2' }] };
  const real = run([p], realBox, { sourceFilter: '입고', inboundCodes: ['1011'], topUpExisting: false });
  assert.deepStrictEqual(real.boxes.map((b) => `${b.source}:${b.addQty}`), ['입고:1']);
  // 같은 8개가 가상스캔이었다면 입고 1 + 재고 7 이 담긴 것 → 입고는 남은 게 없고 재고 1이 남는다
  const virtBox = { boxItems: [{ boxNo: 1, barcode: 'A', qty: 8, virtualQty: 8 }], savedBoxes: [{ boxNo: 1, boxSize: '대2' }] };
  assert.ok(!run([p], virtBox, { sourceFilter: '입고', inboundCodes: ['1011'], topUpExisting: false }).ok);
  assert.deepStrictEqual(run([p], virtBox, { sourceFilter: '재고', topUpExisting: false }).boxes.map((b) => `${b.source}:${b.addQty}`), ['재고:1']);
  // 박스 정보 없이 scannedQty 만 주면(옛 테스트들) 가상 분량처럼 입고부터 뺀다
  assert.ok(!run([p], {}, { sourceFilter: '입고', inboundCodes: ['1011'] }).ok);
});

// ── 입고코드별 기록 (virtualCodes, 2026-10-15 저녁) ──
const { trimCodes, addCode, STOCK_KEY } = require('../virtualPack');
const srcProd = (bc, byCode, stock, opt = {}) => Object.assign(prod(bc, Object.values(byCode).reduce((s, q) => s + q, 0) + stock, opt),
  { allocInbound: Object.values(byCode).reduce((s, q) => s + q, 0), allocStock: stock, allocInboundByCode: byCode });

test('전체 + 입고코드 둘: 항목마다 코드가 붙고 박스에 코드별 개수(codes)·섞임 경고가 남는다', () => {
  const p = srcProd('A', { '1011': 2, '0930': 3 }, 0);
  const plan = run([p], {}, { splitBySource: true, inboundCodes: ['0930', '1011'] });
  assert.ok(plan.ok);
  assert.strictEqual(plan.boxes.length, 1);
  const b = plan.boxes[0];
  assert.deepStrictEqual(b.items.map((i) => [i.code, i.qty]), [['0930', 3], ['1011', 2]]);   // 오래된 코드부터
  assert.deepStrictEqual(b.codes, { '0930': 3, '1011': 2 });
  assert.deepStrictEqual(b.inboundCodes, ['0930', '1011']);
  assert.ok(b.warnings.some((w) => w.includes('섞입니다')));
  // applyPlan → 저장 행에 virtualCodes
  const body = applyPlan({ boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, plan);
  assert.deepStrictEqual(body.items, [{ boxNo: 1, barcode: 'A', productName: 'A', qty: 5, virtualQty: 5, virtualCodes: { '0930': 3, '1011': 2 } }]);
});

test('입고코드 하나만 고르면 그 코드만 기록되고, 재고분은 재고 키로 기록된다', () => {
  const p = srcProd('A', { '1011': 2, '0930': 3 }, 4);
  const plan = run([p], {}, { splitBySource: true, inboundCodes: ['1011'] });
  const body = applyPlan({ boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, plan);
  const byBox = Object.fromEntries(body.items.map((i) => [i.boxNo, i.virtualCodes]));
  assert.deepStrictEqual(byBox, { 1: { '1011': 2 }, 2: { [STOCK_KEY]: 4 } });   // 입고 박스 / 재고 박스 (출처별 분리)
  assert.ok(plan.excluded.some((e) => e.reason === '다른 입고코드' && e.qty === 3));
});

test('이미 담긴 가상 분량에 코드 기록이 있으면 그 코드에서 정확히 뺀다 (오래된 코드부터 가정하지 않는다)', () => {
  // 0930 3 · 1011 2 배정, 1011 분량 2개가 이미 가상으로 담겨 있음 (코드 기록 있음)
  const p = srcProd('A', { '1011': 2, '0930': 3 }, 0, { scanned: 2 });
  const boxItems = [{ boxNo: 1, barcode: 'A', qty: 2, virtualQty: 2, virtualCodes: { '1011': 2 } }];
  const plan = run([p], { boxItems }, { splitBySource: true, inboundCodes: ['0930', '1011'] });
  assert.deepStrictEqual(plan.boxes.flatMap((b) => b.items.map((i) => [i.code, i.qty])), [['0930', 3]]);
  assert.ok(!plan.warnings.some((w) => w.includes('오래된 입고코드부터')));
  // 코드 기록이 없으면(예전 저장분) 전처럼 오래된 코드(0930)부터 뺀 것으로 본다 → 0930 1 + 1011 2
  const legacy = run([p], { boxItems: [{ boxNo: 1, barcode: 'A', qty: 2, virtualQty: 2 }] }, { splitBySource: true, inboundCodes: ['0930', '1011'] });
  assert.deepStrictEqual(legacy.boxes.flatMap((b) => b.items.map((i) => [i.code, i.qty])), [['0930', 1], ['1011', 2]]);
  assert.ok(legacy.warnings.some((w) => w.includes('오래된 입고코드부터')));
});

test('trimCodes/addCode: 합이 상한을 넘으면 재고 → 최신 입고코드 순으로 깎는다', () => {
  assert.deepStrictEqual(trimCodes({ [STOCK_KEY]: 2, '0930': 3, '1011': 4 }, 5), { '0930': 3, '1011': 2 });
  assert.strictEqual(trimCodes({ '1011': 4 }, 0), null);
  assert.deepStrictEqual(addCode(addCode(null, '1011', 2), '1011', 3), { '1011': 5 });
  assert.strictEqual(addCode(null, null, 3), null);   // 코드 미기록은 더하지 않는다
});

console.log(`\n${n} tests passed`);
