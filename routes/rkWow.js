/**
 * 와우출고 — 위해 창고 배정 · 위해 박스를 구매 DB(1688-invoice 와우출고)와 맞춘다 (docs/plan-wow.md §2 · §4)
 *
 * 로켓 DB 가 "원하는 상태"(위해 배정 행 + 위해 박스 줄), 구매 DB 가 "잡혔는가 · 담았는가 · 출고했는가" 의 진실이다.
 *   밀어주기 wowOrder(no, push => …) — 발주서별로 줄 세우고, push 는 보내기 직전에 로켓 DB 를 다시 읽어 ft_wow_sync_order 로 넘긴다(멱등).
 *     중국이 담을 수 있는 것이 늘면 로켓 먼저 → push, 줄면 push(줄인 상태) → 로켓 (shrink)
 *     WOW_SHORT · WOW_BARCODE_NOT_FOUND 면 그 바코드의 위해 행을 박스에 담긴 수량까지 줄이고 한 번 더 보낸다.
 *   끌어오기 pull — 담은 수량 · 출고를 로켓에 반영하고, 양쪽 발주번호 합집합에서 어긋난 발주서를 다시 밀어준다.
 *     줄이 같아도 박스 부가 정보(입고예정일 · 총 박스 수 · 센터 연락처/주소 — 1688-invoice 화면 · 택배엑셀용)가 다르면 다시 밀어준다.
 *   서버 프로세스 1개 전제(Procfile) — 줄 세우기는 이 프로세스 안에서만 유효하다.
 *
 *   GET  /api/wow/status?orderNumbers=a,b → { orders:{ 발주번호: 'ok'|'diff' } }  (위해 배정·박스가 양쪽 어디에도 없는 발주서는 빠진다)
 *   POST /api/wow/pull                     → { picked, shipped, doneOrders, pushed, errors:[{ orderNumber, error }] }
 */
const express = require('express');
const S = require('./rkShared');
const M = require('./rkMarks');
const W = require('./rkWeihai');

const router = express.Router();
const sb = S.supabase;
const WH = '위해';   // rk_shipping_list.source · rk_ship_boxes.origin · virtual_codes 키
const BUCKET = 'wow-docs';
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const parseNos = (v) => [...new Set(String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean))];

// ── 구매 DB 읽기 ──
// 바코드 → 잔여수량(available). 실패하면 throw — 0 으로 덮으면 배정이 조용히 틀어진다
async function available() {
  const uid = await W.accountId();
  const rows = await W.pageAll(() => W.odb.rpc('ft_wow_available', { p_user_id: uid }), ['barcode']);
  const m = new Map();
  for (const r of rows) { const bc = String(r.barcode || '').trim(); if (bc) m.set(bc, (m.get(bc) || 0) + toInt(r.available)); }
  return m;
}
// 발주번호 → 줄 [{ box_no, barcode, qty, picked_qty, picked_at, shipped_at }]. nos 가 null 이면 출고 전 줄이 남은 모든 발주서
async function orderState(nos) {
  const uid = await W.accountId();
  const read = (p) => W.pageAll(() => W.odb.rpc('ft_wow_order_state', { p_user_id: uid, p_orders: p }), ['order_number', 'barcode', 'box_no']);
  const rows = nos ? await S.chunked(nos, 200, read) : await read(null);
  const out = new Map();
  for (const r of rows) { const no = String(r.order_number); (out.get(no) || out.set(no, []).get(no)).push(r); }
  return out;
}

// 구매 DB 의 와우 박스 행 — `${발주번호}|${박스번호}` → 행 (cols: 읽을 칼럼)
const boxKey = (no, boxNo) => `${no}|${boxNo}`;
async function wowBoxes(nos, cols) {
  const uid = await W.accountId();
  const rows = await S.chunked(nos, 200, (p) => W.pageAll(() => W.odb.from('ft_wow_boxes')
    .select('id, order_number, box_no, ' + cols).eq('user_id', uid).in('order_number', p)));
  return new Map(rows.map((b) => [boxKey(b.order_number, b.box_no), b]));
}

// 위해 박스의 와우출고 단계 — `${발주번호}|${박스번호}` → 신규 · 작업중 · 작업완료 · 서류준비 · 출고준비
//   구매 DB ft_wow_boxes 의 기록에서 읽어 낸다 (판정 규칙 = 1688-invoice app/storage/utils/wowStage.ts).
//   출고는 로켓 rk_ship_boxes.shipped_at 이 기준이라 여기서 보지 않는다 (끌어오기가 맞춘다)
const stageOf = (b) => {
  if (!b.box_info_id) return b.work_started_at ? '작업중' : '신규';
  if (b.ready_at) return '출고준비';
  return b.label_path && b.manifest_path ? '서류준비' : '작업완료';
};
async function boxStages(nos) {
  const boxes = await wowBoxes(nos, 'box_info_id, work_started_at, label_path, manifest_path, ready_at');
  return new Map([...boxes].map(([k, b]) => [k, stageOf(b)]));
}

// ── 로켓 DB — 발주서들의 위해 배정 · 위해 박스 ──
//   no → { center, arrival(입고예정일 'YYYY-MM-DD'|null), phone · address(센터 연락처 · 주소 — coupang_centers, 없으면 null),
//          boxTotal(상품이 담긴 박스 전체 수 — 한국 박스 포함. CJ 엑셀 "총 M박스" 와 같은 기준), done,
//          rows: Map(바코드 → {id, qty}), boxes:[{id, box_no, box_size, shipped_at}](위해 박스), items:[{id, box_id, barcode, qty}](위해 박스의 줄) }
async function loadRocket(nos) {
  const out = new Map(nos.map((no) => [no, { center: '', arrival: null, phone: null, address: null, boxTotal: null, done: false, rows: new Map(), boxes: [], items: [] }]));
  if (!nos.length) return out;
  const q = (table, cols, f) => S.chunked(nos, 200, (part) => S.pageAll(() => f(sb.from(table).select(cols).in('order_number', part)).order('id', { ascending: true })));
  const [hs, rows, boxes, items, centers] = await Promise.all([
    q('rk_orders', 'order_number, logistics_center, arrival_date, status', (x) => x),
    q('rk_shipping_list', 'id, order_number, barcode, qty', (x) => x.eq('source', WH).eq('status', '출고예정')),
    q('rk_ship_boxes', 'id, order_number, box_no, box_size, shipped_at', (x) => x.eq('origin', WH)),
    q('rk_ship_box_items', 'id, box_id, order_number, barcode, qty', (x) => x),   // 발주서의 박스 줄 전부 (총 박스 수를 세려고 한국 박스 것도)
    // 센터 연락처 · 주소는 택배엑셀용 부가 정보 — 못 읽어도 밀어주기 · 끌어오기는 계속한다
    sb.from('coupang_centers').select('center, contact, address').then(({ data, error }) => { if (error) console.error('[rk] wow 센터 정보 읽기 실패(무시):', error.message); return data || []; }),
  ]);
  const centerOf = new Map(centers.map((c) => [c.center, c]));
  const text = (v) => String(v == null ? '' : v).trim() || null;
  const seen = new Set();
  for (const h of hs) {
    const no = String(h.order_number);
    if (seen.has(no)) continue;   // 같은 발주번호 헤더가 둘이면 첫 행 (rkAllocate loadHeaders 와 같다)
    seen.add(no);
    const c = centerOf.get(h.logistics_center) || {};
    Object.assign(out.get(no), { center: S.str(h.logistics_center), arrival: h.arrival_date || null, phone: text(c.contact), address: text(c.address), done: S.isDoneOrder({ 상태: h.status }) });
  }
  for (const r of rows) out.get(String(r.order_number)).rows.set(r.barcode, { id: r.id, qty: toInt(r.qty) });
  for (const b of boxes) out.get(String(b.order_number)).boxes.push(b);
  const whBoxIds = new Set(boxes.map((b) => b.id));
  const filled = new Map();   // 발주번호 → Set(상품이 담긴 박스 id)
  for (const it of items) {
    const no = String(it.order_number), qty = toInt(it.qty);
    if (qty > 0) (filled.get(no) || filled.set(no, new Set()).get(no)).add(it.box_id);
    if (whBoxIds.has(it.box_id)) out.get(no).items.push({ ...it, qty });
  }
  for (const [no, ids] of filled) out.get(no).boxTotal = ids.size;
  return out;
}
const hasWow = (o) => o.rows.size > 0 || o.boxes.length > 0;
// 바코드별 위해 박스에 담긴 수량 (drop: 빼고 셀 박스 번호)
function boxedBy(o, drop) {
  const no = new Map(o.boxes.map((b) => [b.id, b.box_no]));
  const m = new Map();
  for (const it of o.items) if (no.has(it.box_id) && !(drop && drop.has(no.get(it.box_id)))) m.set(it.barcode, (m.get(it.barcode) || 0) + it.qty);
  return m;
}

// 원하는 상태 — 위해 박스 줄 + (처리완료가 아니면) 배정 − 박스에 담긴 수량 = 박스 미정 줄
//   박스마다 박스 크기 + 부가 정보(BOX_META: 입고예정일 · 총 박스 수 · 센터 연락처/주소)를 같이 보낸다 (1688-invoice 와우출고 화면 · 택배엑셀용)
//   adj.dropBoxes: Set(박스번호) — 지울 박스(그 수량은 박스 미정으로 돌아간다) · adj.rowQty: Map(바코드 → 줄인 뒤 배정)
function desiredOf(o, adj) {
  const a = adj || {};
  const lines = [], used = new Map();
  for (const b of o.boxes) {
    if (a.dropBoxes && a.dropBoxes.has(b.box_no)) continue;
    for (const it of o.items) {
      if (it.box_id !== b.id || it.qty <= 0) continue;
      lines.push({ barcode: it.barcode, box_no: b.box_no, qty: it.qty });
      used.set(b.box_no, b.box_size || null);
    }
  }
  if (!o.done) {
    const boxed = boxedBy(o, a.dropBoxes);
    for (const [bc, row] of o.rows) {
      const q = (a.rowQty && a.rowQty.has(bc) ? a.rowQty.get(bc) : row.qty) - (boxed.get(bc) || 0);
      if (q > 0) lines.push({ barcode: bc, box_no: null, qty: q });
    }
  }
  const meta = { arrival_date: o.arrival, box_total: o.boxTotal, center_phone: o.phone, center_address: o.address };
  return { lines, boxes: [...used].map(([box_no, box_size]) => ({ box_no, box_size, ...meta })) };
}
// 박스 부가 정보 — p_boxes 키 → 구매 DB ft_wow_boxes 칼럼
const BOX_META = { arrival_date: 'arrival_date', box_total: 'order_box_total', center_phone: 'center_phone', center_address: 'center_address' };
// 원하는 박스 부가 정보 == 구매 DB 에 저장된 값 (meta: wowBoxes 결과)
//   보낼 값이 있는 것만 본다 — null 은 구매 DB 가 저장된 값을 지우지 않는다. 구매 DB 에 없는 박스는 줄 비교(sameState)가 잡는다
function sameMeta(no, d, meta) {
  return d.boxes.every((b) => {
    const saved = meta.get(boxKey(no, b.box_no));
    return !saved || Object.entries(BOX_META).every(([k, col]) => b[k] == null || String(b[k]) === String(saved[col] == null ? '' : saved[col]));
  });
}
// 원하는 상태 == 구매 DB 상태 (담은 줄은 담은 수량, 0 은 없는 것으로)
const lineKey = (bc, n) => `${bc}|${n == null ? '' : n}`;
function sameState(d, st) {
  const a = new Map(d.lines.map((l) => [lineKey(l.barcode, l.box_no), l.qty]));
  const b = new Map();
  for (const s of st || []) {
    const q = s.picked_at ? toInt(s.picked_qty) : toInt(s.qty);
    if (q > 0) b.set(lineKey(s.barcode, s.box_no), (b.get(lineKey(s.barcode, s.box_no)) || 0) + q);
  }
  return a.size === b.size && [...a].every(([k, q]) => b.get(k) === q);
}

// ── 로켓 줄 고치기 (0 이면 지운다) ──
async function setRowQty(row, q) {
  const { error } = q > 0 ? await sb.from('rk_shipping_list').update({ qty: q }).eq('id', row.id) : await sb.from('rk_shipping_list').delete().eq('id', row.id);
  if (error) throw error;
}
async function setItemQty(it, q) {
  const { error } = q > 0
    ? await sb.from('rk_ship_box_items').update({ qty: q, virtual_qty: q, virtual_codes: { [WH]: q }, updated_at: new Date().toISOString() }).eq('id', it.id)
    : await sb.from('rk_ship_box_items').delete().eq('id', it.id);
  if (error) throw error;
}

// ── 밀어주기 ──
const WOW_MSG = { WOW_SHORT: '위해 창고 잔여수량 부족', WOW_BARCODE_NOT_FOUND: '위해 창고에 없는 상품', WOW_BOX_PICKED: '중국에서 이미 담은 박스', WOW_INVALID_INPUT: '구매 DB 입력 오류' };
// 구매 DB 거절은 err.wow = { code, list } — 연결 오류는 wow 없음
function wowError(error) {
  const msg = String((error && error.message) || error || '');
  const m = /(WOW_[A-Z_]+)(?::([^\s"]+))?/.exec(msg);
  if (!m) return Object.assign(new Error('구매 DB 연결 실패: ' + msg), { conn: true });
  const list = (m[2] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return Object.assign(new Error(`${WOW_MSG[m[1]] || m[1]}${list.length ? ': ' + list.join(', ') : ''}`), { wow: { code: m[1], list } });
}
async function sendOrder(no, o, adj) {
  const uid = await W.accountId();
  const d = desiredOf(o, adj);
  const { error } = await W.odb.rpc('ft_wow_sync_order', { p_user_id: uid, p_order_number: no, p_center: o.center, p_lines: d.lines, p_boxes: d.boxes });
  if (error) throw wowError(error);
}
// 줄 세운 안에서만 부른다. opts.force: 로켓에 위해 배정·박스가 없어도 보낸다(구매 DB 에만 남은 예약 풀기)
//   → { skipped } | { trimmed:[바코드] }
async function push(no, adj, opts) {
  let o = (await loadRocket([no])).get(no);
  if (!hasWow(o) && !(opts && opts.force)) return { skipped: true, trimmed: [] };
  try {
    await sendOrder(no, o, adj);
    return { trimmed: [] };
  } catch (e) {
    if (!e.wow || !['WOW_SHORT', 'WOW_BARCODE_NOT_FOUND'].includes(e.wow.code)) throw e;
    // 그 바코드의 위해 배정을 박스에 담긴 수량까지 줄이고 다시 보낸다 (박스에 담긴 것까지 모자라면 그대로 오류)
    const boxed = boxedBy(o);
    const trimmed = [];
    for (const bc of e.wow.list) {
      const row = o.rows.get(bc), keep = boxed.get(bc) || 0;
      if (row && row.qty > keep) { await setRowQty(row, keep); trimmed.push(bc); }
    }
    if (!trimmed.length) throw e;
    o = (await loadRocket([no])).get(no);
    await sendOrder(no, o, adj);
    return { trimmed };
  }
}
const locks = new Map();   // 발주번호 → 마지막 작업이 끝나는 Promise
async function wowOrder(no, fn) {
  const prev = locks.get(no) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(no, chain);
  await prev;
  try { return await fn((adj, opts) => push(no, adj, opts)); }
  finally { release(); if (locks.get(no) === chain) locks.delete(no); }
}
const syncOrder = (no, opts) => wowOrder(no, (p) => p(null, opts));
// 여러 발주서 밀어주기 (처리완료 · 센터 변경 뒤) — 실패는 모아서 돌려준다(끌어오기가 다시 맞춘다)
async function syncOrders(nos) {
  const errors = [];
  const rk = await loadRocket([...new Set((nos || []).map(String))]);   // 한 번에 읽어 위해 배정·박스가 있는 발주서만
  for (const no of [...rk.keys()].filter((n) => hasWow(rk.get(n)))) {
    try { await syncOrder(no); } catch (e) { console.error('[rk] wow sync', no, e.message); errors.push({ orderNumber: no, error: e.message }); }
  }
  return errors;
}
// 줄이기 — 구매 DB 에 줄인 상태(adj)를 먼저 보내고(담은 박스면 WOW_BOX_PICKED 로 거절) 로켓을 고친다.
//   로켓 쓰기가 실패하면 지금 로켓 상태를 다시 보내 되돌린다
function shrink(no, adj, write) {
  return wowOrder(no, async (p) => {
    await p(adj, { force: true });
    try { return await write(); }
    catch (e) { await p(null, { force: true }).catch((e2) => console.error('[rk] wow 되돌리기 실패', no, e2.message)); throw e; }
  });
}
// [배정] 확정 뒤 — added: rk_allocate_save 의 weihai [{orderNumber, barcode, qty}]
//   못 밀어주면(연결 오류 · 거절) 이번에 늘린 위해 수량을 되돌린다(박스에 담긴 수량 아래로는 안 내린다) — 구매 DB 에 안 잡힌 배정을 남기지 않는다
//   → { trimmed:[{orderNumber, barcodes}], failed:[{orderNumber, error, reverted}] }
async function commitAllocated(added) {
  const byOrder = new Map();
  for (const a of added || []) (byOrder.get(a.orderNumber) || byOrder.set(a.orderNumber, []).get(a.orderNumber)).push(a);
  const trimmed = [], failed = [];
  await S.chunkedPool([...byOrder], 1, async ([[no, list]]) => {   // 발주서마다 왕복 몇 번 — 4건씩 동시에 (줄 세우기는 발주서별)
    await wowOrder(no, async (p) => {
      try {
        const r = await p();
        if (r.trimmed.length) trimmed.push({ orderNumber: no, barcodes: r.trimmed });
      } catch (e) {
        try {
          const o = (await loadRocket([no])).get(no), boxed = boxedBy(o);
          for (const a of list) { const row = o.rows.get(a.barcode); if (row) await setRowQty(row, Math.max(boxed.get(a.barcode) || 0, row.qty - toInt(a.qty))); }
          failed.push({ orderNumber: no, error: e.message, reverted: true });
        } catch (e2) {   // 되돌리기도 실패 — 위해 행이 남는다. 다음 끌어오기가 다시 밀어주며 맞춘다
          console.error('[rk] wow 배정 되돌리기 실패', no, e2.message);
          failed.push({ orderNumber: no, error: e.message, reverted: false });
        }
      }
    });
    return [];
  }, 4);
  return { trimmed, failed };
}

// ── 끌어오기 ──
// 발주서 하나에 할 일 — 담은 줄 반영 · 출고 박스 · 어긋남
function pullWork(o, st) {
  const boxByNo = new Map(o.boxes.map((b) => [b.box_no, b]));
  const picks = [];
  for (const s of st) {
    if (!s.picked_at || s.box_no == null) continue;
    const b = boxByNo.get(s.box_no);
    const it = b && o.items.find((i) => i.box_id === b.id && i.barcode === s.barcode);
    if (it && it.qty > toInt(s.picked_qty)) picks.push({ it, barcode: s.barcode, diff: it.qty - toInt(s.picked_qty) });
  }
  const lines = new Map();   // 박스번호 → 그 박스 줄들이 모두 출고됐나
  for (const s of st) if (s.box_no != null) lines.set(s.box_no, (lines.get(s.box_no) !== false) && !!s.shipped_at);
  const ship = [...lines].filter(([n, all]) => all && boxByNo.has(n) && !boxByNo.get(n).shipped_at).map(([n]) => n);
  return { picks, ship };
}
async function pull() {
  // 로켓 쪽: 출고 안 된 위해 박스가 있거나 진행중 발주서의 위해 배정이 있는 발주서 (처리완료 발주서의 행은 기존 재고·입고처럼 남아 있다)
  const [cn, rb, rr] = await Promise.all([
    orderState(null),
    S.pageAll(() => sb.from('rk_ship_boxes').select('order_number').eq('origin', WH).is('shipped_at', null).order('id', { ascending: true })),
    S.listActiveOrderNumbers('rk_orders').then((active) => S.chunked(active, 200, (part) => S.pageAll(() => sb.from('rk_shipping_list')
      .select('order_number').eq('source', WH).eq('status', '출고예정').in('order_number', part).order('id', { ascending: true })))),
  ]);
  const mine = [...new Set([...rb, ...rr].map((r) => String(r.order_number)))];
  const pre = await loadRocket(mine);
  const extra = mine.filter((no) => !cn.has(no));
  if (extra.length) for (const [no, st] of await orderState(extra)) cn.set(no, st);
  const nos = [...new Set([...cn.keys(), ...mine])];
  const [rk, meta] = await Promise.all([
    loadRocket(nos.filter((no) => !pre.has(no))).then((m) => new Map([...pre, ...m])),
    wowBoxes(nos, Object.values(BOX_META).join(', ')),
  ]);
  const out = { picked: 0, shipped: 0, doneOrders: [], pushed: 0, errors: [] };
  for (const no of nos) {
    const st = cn.get(no) || [];
    const w0 = pullWork(rk.get(no), st);
    const d0 = desiredOf(rk.get(no));
    const metaDiff = !sameMeta(no, d0, meta);
    if (!w0.picks.length && !w0.ship.length && !metaDiff && sameState(d0, st)) continue;
    try {
      await wowOrder(no, async (p) => {
        // 줄 세운 안에서 양쪽을 다시 읽는다 (그사이 중국에서 [담기 취소] 했으면 옛 담은 수량으로 줄이지 않게)
        const [rk1, st1] = await Promise.all([loadRocket([no]), orderState([no])]);
        let o = rk1.get(no);
        const s = st1.get(no) || [];
        const w = pullWork(o, s);
        for (const x of w.picks) {   // 적게 담음 — 박스 줄을 담은 수량으로, 위해 배정을 같은 차이만큼 줄인다 → 발주서에 부족이 다시 생긴다
          await setItemQty(x.it, x.it.qty - x.diff);
          const row = o.rows.get(x.barcode);
          if (row) await setRowQty(row, row.qty - x.diff);
          out.picked++;
        }
        if (w.ship.length) {
          const r = await M.markShipped(w.ship.map((boxNo) => ({ orderNumber: no, boxNo })));
          out.shipped += r.shipped; out.doneOrders.push(...r.doneOrders);
        }
        if (w.picks.length || w.ship.length) o = (await loadRocket([no])).get(no);
        if (metaDiff || !sameState(desiredOf(o), s)) { await p(null, { force: true }); out.pushed++; }
      });
    } catch (e) {
      console.error('[rk] wow pull', no, e.message);
      out.errors.push({ orderNumber: no, error: e.message });
    }
  }
  return out;
}

// ── 서류 — 위해 박스의 부착문서·동봉문서를 구매 DB Storage(wow-docs)에도 (1688-invoice 와우출고가 본다) ──
//   docs: { label: bytes, manifest?: bytes }
async function pushDocs(orderNo, boxNo, docs) {
  const uid = await W.accountId();
  for (const [kind, bytes] of Object.entries(docs)) {
    if (!bytes) continue;
    const path = `${orderNo}/${boxNo}/${kind}.pdf`;
    const { error } = await W.odb.storage.from(BUCKET).upload(path, Buffer.from(bytes), { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error(`구매 DB 서류 저장 실패(${path}): ${error.message}`);
    const { error: e2 } = await W.odb.rpc('ft_wow_doc_set', { p_user_id: uid, p_order_number: orderNo, p_box_no: boxNo, p_kind: kind, p_path: path });
    if (e2) throw new Error(`구매 DB 서류 기록 실패(${path}): ${e2.message}`);
  }
}

router.get('/api/wow/status', async (req, res) => {
  try {
    const nos = parseNos(req.query.orderNumbers);
    if (!nos.length) return res.json({ orders: {} });
    const [rk, st] = await Promise.all([loadRocket(nos), orderState(nos)]);
    const orders = {};
    for (const no of nos) {
      const o = rk.get(no), s = st.get(no) || [];
      if (!hasWow(o) && !s.length) continue;
      orders[no] = sameState(desiredOf(o), s) ? 'ok' : 'diff';
    }
    res.json({ orders });
  } catch (e) {
    console.error('[rk] wow/status:', e);
    res.status(500).json({ error: '구매 DB 확인 실패: ' + e.message });
  }
});

router.post('/api/wow/pull', async (req, res) => {
  try {
    res.json(await pull());
  } catch (e) {
    console.error('[rk] wow/pull:', e);
    res.status(500).json({ error: '와우출고 끌어오기 실패: ' + e.message });
  }
});

module.exports = router;
Object.assign(router, { WH, available, boxStages, pull, wowOrder, syncOrder, syncOrders, shrink, commitAllocated, pushDocs });
