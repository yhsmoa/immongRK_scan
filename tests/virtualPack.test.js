/**
 * 가상스캔 배정 알고리즘 단위 테스트 — 프레임워크 없이 node 로 실행
 *   node tests/virtualPack.test.js
 *
 * 단위: 상품 1개 = 10 L (1000×1000×10 mm), 0.5 kg. 용량(10% 포함) 극소 39.6 → 3개 · 중 132 → 13개 · 대2 308 → 30개
 */
const assert = require('assert');
const { planVirtualScan, CONFIG, capL, unitOf } = require('../virtualPack');

const SIZE10 = { w: 1000, l: 1000, h: 10, g: 500 };
const prod = (barcode, alloc, { conf = alloc, scanned = 0, size = SIZE10, name = barcode } = {}) =>
  ({ barcode, productName: name, orderQty: conf, allocQty: alloc, scannedQty: scanned, size, location: '' });
const run = (products, extra = {}, cfg) => planVirtualScan(Object.assign({ products, boxItems: [], savedBoxes: [], boxSizeMap: new Map() }, extra), cfg);
const shape = (plan) => plan.boxes.map((b) => `${b.boxNo}:${b.size}:${b.addQty}`).join(' ');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

test('용량: base × 1.1', () => {
  assert.strictEqual(capL('극소', CONFIG), 36 * 1.1);
  assert.strictEqual(capL('대2', CONFIG), 280 * 1.1);
  assert.strictEqual(capL('소', CONFIG), null);
});

test('단위: 측정값 / 임시값 / 누락', () => {
  assert.deepStrictEqual(unitOf(SIZE10, CONFIG), { L: 10, kg: 0.5, flag: null });
  assert.strictEqual(unitOf({ w: 300, l: 300, h: 20, g: 200 }, CONFIG).flag, 'placeholder');
  assert.strictEqual(unitOf({ w: 300, l: 300, h: 20, g: 200 }, CONFIG).L, CONFIG.defaultUnitL);
  assert.strictEqual(unitOf(null, CONFIG).flag, 'missing');
  assert.strictEqual(unitOf({ w: 100, l: 100, h: 100, g: null }, CONFIG).kg, CONFIG.defaultUnitKg);
});

test('딱 대2 두 박스 (60개 = 600 L)', () => {
  const p = run([prod('A', 60)]);
  assert.ok(p.ok);
  assert.strictEqual(shape(p), '1:대2:30 2:대2:30');
  assert.strictEqual(p.totals.newBoxes, 2);
});

test('대2 + 중 (40개 = 400 L)', () => {
  assert.strictEqual(shape(run([prod('A', 40)])), '1:대2:30 2:중:10');
});

test('대2 + 극소 (32개 = 320 L)', () => {
  assert.strictEqual(shape(run([prod('A', 32)])), '1:대2:30 2:극소:2');
});

test('중 1개 (10개) · 극소 1개 (3개) · 극소 한도 넘으면 중 (4개)', () => {
  assert.strictEqual(shape(run([prod('A', 10)])), '1:중:10');
  assert.strictEqual(shape(run([prod('A', 3)])), '1:극소:3');
  assert.strictEqual(shape(run([prod('A', 4)])), '1:중:4');
});

test('수량 많은 상품부터 담는다 (바코드 분할 허용)', () => {
  const p = run([prod('B', 5), prod('A', 32), prod('C', 1)]);
  // A 32 → 박스1(대2) 30 + 박스2 2, 그 다음 B 5, C 1 → 박스2 = 8개(80 L) → 중
  assert.strictEqual(shape(p), '1:대2:30 2:중:8');
  assert.strictEqual(p.boxes[0].items[0].barcode, 'A');
  assert.deepStrictEqual(p.boxes[1].items.map((i) => `${i.barcode}:${i.qty}`), ['A:2', 'B:5', 'C:1']);
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
  // 박스1 중 5개(50 L) + 신규 20개(200 L) = 250 L > 중 132 → 대2(308) 로 올리고 전부 담는다
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
  // 박스1 극소 1개(10 L) + 60개(600 L) → 대2(308) 에 29개 더, 나머지 31개 → 대2 30 + 극소 1
  const p = planVirtualScan(withBox1('극소', 1, [prod('A', 60)]));
  assert.strictEqual(shape(p), '1:대2:29 2:대2:30 3:극소:1');
  assert.strictEqual(p.boxes[0].sizeFrom, '극소');
});

test('크기 UP 은 부피 기준 — 무게 때문에 못 담는 건 올리지 않는다', () => {
  const heavy = { w: 1000, l: 1000, h: 10, g: 2500 };
  // 박스1 중 1개(10 L · 2.5 kg) + 10개(100 L · 25 kg): 부피 110 ≤ 132 → 크기 유지, 무게로 8개까지 → 나머지 2개 새 박스
  const p = planVirtualScan({ products: [prod('A', 10, { size: heavy }), prod('Z', 1, { scanned: 1, size: heavy })],
    boxItems: [{ boxNo: 1, barcode: 'Z', qty: 1 }], savedBoxes: [{ boxNo: 1, boxSize: '중' }], boxSizeMap: new Map() });
  assert.strictEqual(shape(p), '1:중:8 2:극소:2');
  assert.strictEqual(p.boxes[0].sizeFrom, null);
});

test('이미 가장 큰 크기(대2)가 꽉 찼으면 그대로 두고 새 박스 (경고)', () => {
  // 박스1 대2 에 31개(310 L > 308) → 0개 추가, 신규 5개(50 L > 극소 39.6) → 중
  const p = planVirtualScan(withBox1('대2', 31, [prod('A', 5)]));
  assert.strictEqual(shape(p), '1:대2:0 2:중:5');
  assert.ok(p.warnings.some((w) => w.includes('그대로 둔 기존 박스')));
});

test('옵션 upgradeLastBox=false — 크기를 올리지 않고 남은 용량만 채운다', () => {
  const p = planVirtualScan(withBox1('중', 5, [prod('A', 20)]), { upgradeLastBox: false });
  assert.strictEqual(shape(p), '1:중:8 2:중:12');
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
  assert.strictEqual(shape(off), '2:대2:20');                 // 200 L > 중 132 → 대2, 박스1은 건드리지 않음
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
  const huge = { w: 1000, l: 1000, h: 400, g: 500 }; // 400 L > 대2 308
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

console.log(`\n${n} tests passed`);
