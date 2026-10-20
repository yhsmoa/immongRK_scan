/**
 * 통합 배정 계산기 단위 테스트 — 프레임워크 없이 node 로 실행
 *   node tests/allocPlan.test.js
 */
const assert = require('assert');
const { planAllocation, zoneOf, allocSummary, allocPlace, inboundRemain } = require('../allocPlan');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

const order = (orderNumber, rows, shippingDate = '20261025', center = '대구3') => ({ orderNumber, center, shippingDate, rows });
const row = (barcode, confirmedQty) => ({ barcode, productName: barcode, confirmedQty });
const stock = (stockId, barcode, location, qty) => ({ stockId, barcode, location, qty });
const inb = (shipmentItemId, barcode, code, boxName, remain, { codeRank = Number(code), pallet = 'P1', shipmentId = 1 } = {}) =>
  ({ shipmentId, shipmentItemId, code, codeRank, barcode, pallet, boxName, remain });
const plan = (orders, extra = {}) => planAllocation(Object.assign({ orders, reservedByKey: {}, scannedByKey: {}, stockPool: [], inboundPool: [], sourceOrder: ['입고', '재고'] }, extra));
const allocStr = (r) => r.allocs.map((a) => a.source === '재고' ? `${a.location}:${a.qty}` : `${a.code}-${a.boxName}:${a.qty}`).join(' ');

test('구역: 끝 숫자를 뗀 앞부분', () => {
  assert.strictEqual(zoneOf('305B34'), '305B');
  assert.strictEqual(zoneOf('26여름15'), '26여름');
  assert.strictEqual(zoneOf('LO-A'), 'LO-A');
  assert.strictEqual(zoneOf('123'), '123');
});

test('출처를 하나도 안 고르면 계산하지 않는다', () => {
  const p = plan([order('1', [row('A', 3)])], { sourceOrder: [] });
  assert.strictEqual(p.ok, false);
});

test('needed = 확정 − max(예약, 스캔) — 더하지 않는다', () => {
  const p = plan([order('1', [row('A', 10)])], {
    reservedByKey: { '1|A': 6 }, scannedByKey: { '1|A': 6 }, stockPool: [stock(1, 'A', '101A11', 20)], sourceOrder: ['재고'] });
  assert.strictEqual(p.rows[0].needed, 4);
  assert.strictEqual(p.rows[0].stockQty, 4);
  const p2 = plan([order('1', [row('A', 10)])], { reservedByKey: { '1|A': 3 }, scannedByKey: { '1|A': 8 }, stockPool: [stock(1, 'A', '101A11', 20)], sourceOrder: ['재고'] });
  assert.strictEqual(p2.rows[0].needed, 2);
});

test('이미 다 배정/스캔된 행은 건너뛰고 사유를 남긴다', () => {
  const p = plan([order('1', [row('A', 5), row('B', 5)])], { reservedByKey: { '1|A': 5 }, scannedByKey: { '1|B': 5 }, stockPool: [stock(1, 'A', '1A1', 9), stock(2, 'B', '1A2', 9)] });
  assert.deepStrictEqual(p.rows.map((r) => r.reason), ['이미 배정', '이미 스캔']);
  assert.strictEqual(p.summary.stock + p.summary.inbound, 0);
});

test('출처 순서: 입고 → 재고 / 재고 → 입고', () => {
  const pools = { stockPool: [stock(1, 'A', '101A11', 5)], inboundPool: [inb(10, 'A', '1018', 'BR5', 5)] };
  const a = plan([order('1', [row('A', 7)])], Object.assign({ sourceOrder: ['입고', '재고'] }, pools));
  assert.strictEqual(allocStr(a.rows[0]), '1018-BR5:5 101A11:2');
  const b = plan([order('1', [row('A', 7)])], Object.assign({ sourceOrder: ['재고', '입고'] }, pools));
  assert.strictEqual(allocStr(b.rows[0]), '101A11:5 1018-BR5:2');
});

test('고르지 않은 출처는 쓰지 않는다 + 부족 기록', () => {
  const p = plan([order('1', [row('A', 7)])], { sourceOrder: ['재고'], stockPool: [stock(1, 'A', '101A11', 5)], inboundPool: [inb(10, 'A', '1018', 'BR5', 5)] });
  assert.strictEqual(allocStr(p.rows[0]), '101A11:5');
  assert.strictEqual(p.rows[0].shortage, 2);
  assert.strictEqual(p.rows[0].reason, '일부 부족');
  const q = plan([order('1', [row('Z', 3)])], { sourceOrder: ['재고'] });
  assert.strictEqual(q.rows[0].reason, '재고·입고 없음');
});

test('재고 동선: 한 곳에서 다 채울 수 있는 위치 우선 (위치순보다 앞)', () => {
  const p = plan([order('1', [row('A', 6)])], { sourceOrder: ['재고'], stockPool: [stock(1, 'A', '101A11', 2), stock(2, 'A', '305B34', 8)] });
  assert.strictEqual(allocStr(p.rows[0]), '305B34:6');
});

test('재고 동선: 이 발주서가 이미 쓴 구역 우선', () => {
  const p = plan([order('1', [row('A', 3), row('B', 2)])], { sourceOrder: ['재고'], stockPool: [
    stock(1, 'A', '305B34', 10),
    stock(2, 'B', '101A11', 10), stock(3, 'B', '305B40', 10)] });
  assert.strictEqual(allocStr(p.rows[0]), '305B34:3');
  assert.strictEqual(allocStr(p.rows[1]), '305B40:2');   // 위치순이면 101A11 이지만 같은 구역 305B 를 고른다
});

test('재고 동선: 한 곳에서 못 채우면 많이 있는 곳부터 (분할 최소)', () => {
  const p = plan([order('1', [row('A', 9)])], { sourceOrder: ['재고'], stockPool: [stock(1, 'A', '101A11', 2), stock(2, 'A', '102A11', 3), stock(3, 'A', '103A11', 6)] });
  assert.strictEqual(allocStr(p.rows[0]), '103A11:6 102A11:3');
});

test('입고: 오래된 입고코드 먼저 (codeRank — 연도 넘어가는 0105 < 1230 문제 회피)', () => {
  const p = plan([order('1', [row('A', 4)])], { sourceOrder: ['입고'], inboundPool: [
    inb(11, 'A', '0105', 'BR1', 10, { codeRank: 2 }), inb(10, 'A', '1230', 'BR9', 10, { codeRank: 1 })] });
  assert.strictEqual(allocStr(p.rows[0]), '1230-BR9:4');
});

test('입고: 코드 안에서 혼자 채우는 박스 우선, 없으면 많이 남은 박스부터', () => {
  const p = plan([order('1', [row('A', 5)])], { sourceOrder: ['입고'], inboundPool: [inb(1, 'A', '1018', 'BR3', 2), inb(2, 'A', '1018', 'BR7', 6)] });
  assert.strictEqual(allocStr(p.rows[0]), '1018-BR7:5');
  const q = plan([order('1', [row('A', 9)])], { sourceOrder: ['입고'], inboundPool: [inb(1, 'A', '1018', 'BR3', 2), inb(2, 'A', '1018', 'BR5', 3), inb(3, 'A', '1018', 'BR7', 6)] });
  assert.strictEqual(allocStr(q.rows[0]), '1018-BR7:6 1018-BR5:3');
});

test('입고: 둘 다 혼자 채우면 팔렛·박스명 순 (BR5 < BR40, 숫자 인식)', () => {
  const p = plan([order('1', [row('A', 2)])], { sourceOrder: ['입고'], inboundPool: [inb(2, 'A', '1018', 'BR40', 9), inb(1, 'A', '1018', 'BR5', 9)] });
  assert.strictEqual(allocStr(p.rows[0]), '1018-BR5:2');
});

test('발주서 순서 = 입고예정일 → 발주번호, 같은 바코드 풀 공유', () => {
  const p = plan([order('B2', [row('A', 4)], '20261028'), order('A1', [row('A', 4)], '20261025')], { sourceOrder: ['재고'], stockPool: [stock(1, 'A', '101A11', 5)] });
  assert.deepStrictEqual(p.rows.map((r) => `${r.orderNumber}:${r.stockQty}`), ['A1:4', 'B2:1']);
  assert.strictEqual(p.summary.shortage, 3);
});

test('입력 풀을 바꾸지 않는다 (미리보기 → 확정 재계산이 같은 입력이면 같은 결과)', () => {
  const pool = [stock(1, 'A', '101A11', 5)];
  const input = { orders: [order('1', [row('A', 3)])], reservedByKey: {}, scannedByKey: {}, stockPool: pool, inboundPool: [], sourceOrder: ['재고'] };
  const a = planAllocation(input), b = planAllocation(input);
  assert.strictEqual(pool[0].qty, 5);
  assert.deepStrictEqual(a.rows, b.rows);
});

test('위치 0·빈칸·"-" 재고, 남은 0 입고는 풀에서 뺀다', () => {
  const p = plan([order('1', [row('A', 3)])], { stockPool: [stock(1, 'A', '-', 9), stock(2, 'A', '', 9), stock(3, 'A', '1A1', 0)], inboundPool: [inb(1, 'A', '1018', 'BR1', 0)] });
  assert.strictEqual(p.rows[0].allocs.length, 0);
});

test('표시: 단일은 수량 없이, 여럿은 "첫 항목-수량 외 N건"', () => {
  assert.strictEqual(allocSummary([{ source: '재고', location: '305B34', qty: 3 }]).short, '305B34');
  assert.strictEqual(allocSummary([{ source: '입고', code: '1018', boxName: 'BR5', qty: 4 }]).short, '1018-BR5');
  const s = allocSummary([{ source: '재고', location: '305B34', qty: 3 }, { source: '입고', code: '1018', boxName: 'BR5', qty: 4 }, { source: '재고', location: '101A11', qty: 1 }]);
  assert.strictEqual(s.short, '305B34-3 외 2건');
  assert.deepStrictEqual(s.lines, ['305B34 ×3', '1018-BR5 ×4', '101A11 ×1']);
  assert.strictEqual(allocPlace({ source: '입고', code: '1011', boxName: 'BR3' }), '1011-BR3');
});

test('입고 남은 = 원본 − 출고 − 재고확정', () => {
  assert.strictEqual(inboundRemain('10', 4, 6), 0);
  assert.strictEqual(inboundRemain(10, 4, 0), 6);
});

console.log(`\n${n} tests passed`);
