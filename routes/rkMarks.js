/**
 * 모바일 입고 "찾은 수량"(가상확인) 공용 (2026-11-02, docs/plan-shipment-found-qty.md)
 *
 * 기록: rk_cn_shipping(입고 배정 원본) · rk_shipping_list(source='재고' / 입고 미러) 의
 *   mobile_boxes = { "<박스번호>": { found: 찾은 수량, qty: 그 박스 몫, status: 'found'|'missing', by, at } }   ("0" = 박스 미정)
 *     · found 가 숫자로 들어온다 — [스캔] = 몫 전부, [부족] = 키패드로 넣은 수(0 허용)
 *     · status 는 예전 화면·PC 표가 읽도록 같이 남긴다: found ≥ qty → 'found', 아니면 'missing'(= 부족)
 *     · found 가 없는 예전 기록은 status 로 읽는다: found → 몫 전부, missing → 0
 *   행 요약 mobile_status: 하나라도 부족 → 'missing' · 찾은 합 ≥ 행의 박스 몫 합 → 'found' · 일부만 입력 → null
 *
 * 부족은 재고·입고로 되돌리지 않는다 (사용자 결정 2026-11-02) — 덜 들어온 것이므로 배정·재고·박스 담은 수량은 그대로.
 * 숫자는 쉽먼트 납품수량(가상확인)과 상태 판정에만 쓴다.
 *
 * 판정 단위 = (발주번호, 바코드, 박스번호). 모바일 [전체] 모드와 같은 행(rk_shipping_list 출고예정)·같은 박스 배정(assignVirtualBoxes)으로
 * 계산하므로 폰 카드와 쉽먼트 화면이 같은 답을 낸다.
 */
const S = require('./rkShared');
const VirtualPack = require('../virtualPack');
const sb = S.supabase;

const boxEntries = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
// ── rk_ship_boxes 의 선택 열이 있는지 (SQL 실행 전에도 화면이 깨지지 않게) — 있으면 계속 기억, 없으면 1분 뒤 다시 확인 ──
const colCache = new Map();   // 열 이름 → { v, at }
async function hasBoxCol(col) {
  const c = colCache.get(col);
  if (c && c.v === true) return true;
  if (c && c.v === false && Date.now() - c.at < 60000) return false;
  const { error } = await sb.from('rk_ship_boxes').select(col).limit(1);
  colCache.set(col, { v: !error, at: Date.now() });
  if (error && !error.message.includes(col)) throw error;
  return !error;
}
const hasShippedCol = () => hasBoxCol('shipped_at');
const hasLabelCol = () => hasBoxCol('label_printed_at');
const LABEL_SQL_MSG = '라벨 출력 기록 열(rk_ship_boxes.label_printed_at)이 아직 DB 에 없습니다. supabase/rk_ship_boxes_label_printed_at.sql 을 실행하세요.';
const SHIPPED_SQL_MSG = '출고완료 기록 열(rk_ship_boxes.shipped_at)이 아직 DB 에 없습니다. supabase/rk_ship_boxes_shipped_at.sql 을 실행한 뒤 다시 시도하세요.';
const toN = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
// 기록 하나의 찾은 수량 (예전 status 기록 포함)
function entryFound(e) {
  if (!e) return 0;
  const qty = Math.max(0, toN(e.qty));
  if (e.found != null && e.found !== '' && Number.isFinite(Number(e.found))) return Math.max(0, Math.min(qty, toN(e.found)));
  return e.status === 'found' ? qty : 0;
}
// 행 요약 — 박스별 기록 → mobile_status / at / by
function summarizeMarks(boxes, shareTotal) {
  const list = Object.values(boxes || {});
  if (!list.length) return { mobile_status: null, mobile_at: null, mobile_by: null, mobile_boxes: null };
  const latest = list.reduce((a, b) => (!a || String(b.at || '') > String(a.at || '')) ? b : a, null);
  const foundQty = list.reduce((s, e) => s + entryFound(e), 0);
  const total = parseInt(shareTotal, 10);
  const short = list.some((e) => entryFound(e) < Math.max(0, toN(e.qty)));
  const st = short ? 'missing' : (!Number.isFinite(total) || foundQty >= total) ? 'found' : null;
  return { mobile_status: st, mobile_at: latest.at || null, mobile_by: latest.by || null, mobile_boxes: boxes };
}
// 저장 패치 — marks: [{ boxNo, qty(몫), found }]  · found 가 없고 status 도 없으면 그 박스 기록을 지운다
//   예전 화면: marks 의 found 없이 status('found'|'missing') 로 오거나, marks 없이 status 만 온다 (행 전체 기록)
function markPatch(curBoxes, status, worker, marks, shareTotal) {
  const now = new Date().toISOString();
  if (!Array.isArray(marks)) return status ? { mobile_status: status, mobile_at: now, mobile_by: worker || null, mobile_boxes: null } : { mobile_status: null, mobile_at: null, mobile_by: null, mobile_boxes: null };
  const boxes = { ...boxEntries(curBoxes) };
  for (const m of marks) {
    const k = String(parseInt(m && m.boxNo, 10) || 0);
    const qty = Math.max(0, toN(m && m.qty));
    let found = m && m.found != null && m.found !== '' ? toN(m.found) : null;
    if (found == null && status) found = status === 'found' ? qty : 0;
    if (found == null) { delete boxes[k]; continue; }
    found = Math.max(0, Math.min(qty, found));
    boxes[k] = { found, qty, status: found >= qty ? 'found' : 'missing', by: worker || null, at: now };
  }
  return summarizeMarks(boxes, shareTotal);
}
// 입력 검증 — marks 의 found 는 0 ≤ found ≤ qty 정수. 틀리면 오류 문장
function marksError(marks) {
  if (!Array.isArray(marks)) return null;
  for (const m of marks) {
    if (!m || m.found == null || m.found === '') continue;
    const f = Number(m.found), q = toN(m.qty);
    if (!Number.isInteger(f) || f < 0) return '찾은 수량은 0 이상의 정수여야 합니다.';
    if (f > q) return `찾은 수량(${f})이 박스 몫(${q})보다 많습니다.`;
  }
  return null;
}

// 발주서들의 가상 박스 — 발주번호 → { boxes:[{id,box_no,box_size}], virtualByBc:{바코드:[{boxNo,boxSize,boxQty,remain}]} } (mobile-list · mobile-orders 공용)
//   칩/목록에는 **가상으로 담긴 분량만** 쓴다 — 실제 스캔으로 이미 담은 분량(virtual_qty 0)은 찾을 대상이 아니다.
//   (같은 바코드가 다른 입고코드로 먼저 실제 포장된 박스가 카드에 같이 붙던 문제, 2026-10-15)
//   opts.includeStock (2026-10-20, 모바일 [전체] 모드 전용): virtual_codes 의 '재고' 분량도 코드로 다룬다 → 재고 행(출고코드 '재고')에도 칩이 붙고,
//   codesByBox 에 '재고' 가 들어가 섞임 판정에 재고+입고가 포함된다. 기본값(false)은 예전과 똑같다 ([입고] 모드)
async function loadVirtualBoxes(orderNumbers, opts) {
  const includeStock = !!(opts && opts.includeStock);
  const out = {};
  const nos = [...new Set(orderNumbers.map(String).filter(Boolean))];
  if (!nos.length) return out;
  const boxCols = 'id, order_number, box_no, box_size' + ((await hasShippedCol()) ? ', shipped_at' : '');   // shipped_at: 출고완료 박스 (목록에서 뺀다)
  const [boxes, bItems] = await Promise.all([
    S.chunked(nos, 200, (part) => S.pageAll(() => sb.from('rk_ship_boxes').select(boxCols).in('order_number', part).order('id', { ascending: true }))),
    S.chunked(nos, 200, (part) => S.pageAll(() => sb.from('rk_ship_box_items').select('order_number, box_id, barcode, qty, virtual_qty, virtual_codes').in('order_number', part).order('id', { ascending: true }))),
  ]);
  const boxById = new Map();
  for (const b of boxes) {
    boxById.set(b.id, b);
    const o = (out[String(b.order_number)] ||= { boxes: [], virtualByBc: {}, codesByBox: {}, shipped: new Set() });
    o.boxes.push(b);
    if (b.shipped_at) o.shipped.add(b.box_no);   // 출고완료 박스 번호 — 모바일 목록에서 뺀다 (배정 계산에는 그대로 둔다)
  }
  for (const it of bItems) {
    const b = boxById.get(it.box_id); const qty = parseInt(it.qty, 10) || 0; const vq = parseInt(it.virtual_qty, 10) || 0;
    if (!b || !it.barcode || qty <= 0 || vq <= 0) continue;
    const o = out[String(b.order_number)];
    // virtual_codes = 가상 분량의 출처별 개수 {입고코드|'재고': n} (2026-10-15). 기록된 만큼은 그 코드 행에만 배정하고,
    // 기록이 없는 나머지(remainFree, 예전 저장분)는 어느 입고코드 행에든 앞에서부터 배정한다
    const codes = VirtualPack.trimCodes(it.virtual_codes, vq) || {};
    const remainByCode = {};
    for (const c of Object.keys(codes)) if (includeStock || c !== VirtualPack.STOCK_KEY) remainByCode[c] = codes[c];
    const remainFree = Math.max(0, vq - VirtualPack.sumCodes(codes));
    (o.virtualByBc[it.barcode] ||= []).push({ boxNo: b.box_no, boxSize: b.box_size, boxQty: qty, remainByCode, remainFree });
    for (const c of Object.keys(remainByCode)) (o.codesByBox[b.box_no] ||= new Set()).add(c);
  }
  for (const o of Object.values(out)) for (const l of Object.values(o.virtualByBc)) l.sort((a, b) => a.boxNo - b.boxNo);
  return out;
}
// 가상 박스 배정 — 행의 입고코드(출고코드)와 같은 코드로 기록된 가상 분량을 먼저, 그다음 코드 미기록 분량을 박스 번호 순으로 채워 나눈다.
//   다른 입고코드로 기록된 분량은 이 행에 주지 않는다 (같은 바코드가 두 입고코드에 있을 때 두 번째 코드 카드가 첫 코드의 박스를 가리키던 문제, 2026-10-15)
//   코드 기록이 없는 예전 저장분은 전처럼 카드 순서(mobileCmp)대로 앞에서부터 (같은 바코드의 두 행에 같은 박스가 중복 표시되지 않게)
//   예: 바코드 가상 34 = 1번(30)+2번(4), 입고 행 BR7 22 · BR8 12 → BR7: 1번 ×22 / BR8: 1번 ×8 + 2번 ×4
//   rows 순서대로 [{ boxNo, boxSize, qty, virtualQty }][] 를 돌려준다 (virtualByBc 의 remain 을 소모하므로 발주서당 한 번만 부를 것)
function assignVirtualBoxes(rows, virtualByBc) {
  return rows.map((r) => {
    const assigned = [];
    const code = r.출고코드 == null ? null : String(r.출고코드);
    let need = parseInt(r.출고개수, 10) || 0;
    for (const b of ((virtualByBc || {})[r.바코드] || [])) {
      if (need <= 0) break;
      let take = 0;
      if (code != null && b.remainByCode[code] > 0) { const t = Math.min(need, b.remainByCode[code]); b.remainByCode[code] -= t; need -= t; take += t; }
      if (need > 0 && b.remainFree > 0) { const t = Math.min(need, b.remainFree); b.remainFree -= t; need -= t; take += t; }
      if (take > 0) assigned.push({ boxNo: b.boxNo, boxSize: b.boxSize, qty: b.boxQty, virtualQty: take });
    }
    return assigned;
  });
}

// 카드 순서(동선): 입고 먼저(가상스캔이 담는 순서) › 입고코드(오래된 것 먼저) › 박스명 / 위치 › id. 박스 번호 정렬은 배정 뒤에 한다
//   extra(list): (선택) 첫 조회 결과로 함께 돌릴 조회 — 2단계 조회와 동시에 실행된다 (all-orders 의 무게 조회, 왕복 1회 절약)
//   opts.lean (2026-11-02, 판정 전용): rk_cn_shipment_items(박스명·중국번호·상품명) 조회를 건너뛴다 — boxFoundMap 은 바코드·출고코드·기록만 쓴다
async function loadAllModeRows(orderNumbers, extra, opts) {
  const lean = !!(opts && opts.lean);
  const nos = [...new Set(orderNumbers.map(String).filter(Boolean))];
  if (!nos.length) return [];
  const list = await S.chunkedPool(nos, 200, (part) => S.pageAll(() => sb.from('rk_shipping_list')
    .select('id, source, order_number, barcode, product_name, center, shipping_date, qty, location, shipment_id, shipment_item_id, cn_shipping_id, batch_no, mobile_status, mobile_at, mobile_by, mobile_boxes, mobile_memo, mobile_memo_at, mobile_memo_by')
    .eq('status', '출고예정').in('order_number', part).order('id', { ascending: true })));
  const itemIds = [...new Set(list.filter((r) => r.source === '입고' && r.shipment_item_id).map((r) => r.shipment_item_id))];
  const shipIds = [...new Set(list.filter((r) => r.source === '입고' && r.shipment_id).map((r) => r.shipment_id))];
  const cnIds = [...new Set(list.filter((r) => r.source === '입고' && r.cn_shipping_id).map((r) => r.cn_shipping_id))];
  const [items, ships, cns] = await Promise.all([
    lean ? [] : S.chunkedPool(itemIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipment_items').select('id, box_name, order_number, product_name').in('id', part); if (error) throw error; return data || []; }),
    S.chunkedPool(shipIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipments').select('id, shipment_code, created_at').in('id', part); if (error) throw error; return data || []; }),
    S.chunkedPool(cnIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipping').select('id, mobile_status, mobile_at, mobile_by, mobile_boxes, mobile_memo, mobile_memo_at, mobile_memo_by').in('id', part); if (error) throw error; return data || []; }),
    extra ? extra(list) : null,   // 함께 기다린다 (먼저 실패해도 처리 안 된 오류가 남지 않게)
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const shipById = new Map(ships.map((x) => [x.id, x]));
  const cnById = new Map(cns.map((c) => [c.id, c]));
  const rows = [];
  for (const r of list) {
    const inb = r.source === '입고';
    if (inb && r.cn_shipping_id && !cnById.has(r.cn_shipping_id)) continue;   // 원본이 지워진 미러 (정상 경로에선 없다)
    const it = inb ? itemById.get(r.shipment_item_id) || {} : {};
    const sh = inb ? shipById.get(r.shipment_id) || {} : {};
    const mob = inb && r.cn_shipping_id ? cnById.get(r.cn_shipping_id) : r;
    rows.push({
      listId: r.id, allocId: r.cn_shipping_id || null, source: r.source,
      회차: r.batch_no || 1, 출고코드: inb ? String(sh.shipment_code || '') : VirtualPack.STOCK_KEY, codeAt: inb ? sh.created_at || '' : '',
      출고번호: r.order_number, 센터: r.center || '', 출고예정일: r.shipping_date || '',
      박스명: inb ? it.box_name || '' : '', 중국번호: inb ? it.order_number || '' : '', 위치: inb ? '' : (r.location || ''),
      상품명: (inb ? it.product_name : null) || r.product_name || '', 바코드: r.barcode, 출고개수: parseInt(r.qty, 10) || 0,
      모바일: mob.mobile_status || null, 모바일처리자: mob.mobile_by || null, 모바일시각: mob.mobile_at || null, 모바일박스: mob.mobile_boxes || null,
      모바일메모: mob.mobile_memo || null, 모바일메모처리자: mob.mobile_memo_by || null, 모바일메모시각: mob.mobile_memo_at || null,
    });
  }
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });
  rows.sort((a, b) => cmp(a.출고번호, b.출고번호) || ((a.source === '입고' ? 0 : 1) - (b.source === '입고' ? 0 : 1))
    || cmp(a.codeAt, b.codeAt) || cmp(a.출고코드, b.출고코드) || cmp(a.source === '입고' ? a.박스명 : a.위치, b.source === '입고' ? b.박스명 : b.위치) || (a.listId - b.listId));
  return rows;
}
// ── 박스별 찾은 수량 (발주번호|바코드|박스번호) ──
//   모바일 [전체] 모드의 행·배정을 그대로 다시 계산한다. 행마다 그 박스에 배정된 몫(share) 중
//   기록이 있는 만큼(marked)과 찾은 만큼(found). 예전 행 요약만 있는 기록(mobile_boxes 없음)은 행 전체가 입력된 것으로 본다.
//   map 값: { share, marked, found, rows:[{ listId, allocId, source, share, marked, shareTotal }] }
//   orphan: 행에 배정되지 못한 가상 분량(배정이 줄었는데 박스는 그대로) — 폰에서 입력할 카드가 없다. key → 개수
async function boxFoundMap(orderNumbers) {
  const nos = [...new Set((orderNumbers || []).map((v) => String(v == null ? '' : v)).filter(Boolean))];
  const out = new Map(), orphan = new Map();
  if (!nos.length) return { map: out, orphan };
  const [rows, vb] = await Promise.all([loadAllModeRows(nos, null, { lean: true }), loadVirtualBoxes(nos, { includeStock: true })]);
  const byOrder = new Map();
  for (const r of rows) { const no = String(r.출고번호); if (!byOrder.has(no)) byOrder.set(no, []); byOrder.get(no).push(r); }
  for (const no of nos) {
    const ors = byOrder.get(no) || [];
    const vbo = vb[no] || {};
    const assigned = assignVirtualBoxes(ors, vbo.virtualByBc);
    ors.forEach((r, i) => {
      const e = boxEntries(r.모바일박스), hasBoxes = Object.keys(e).length > 0;
      const shareTotal = assigned[i].reduce((s, x) => s + (x.virtualQty || 0), 0);
      for (const b of assigned[i]) {
        const share = b.virtualQty || 0;
        const k = `${no}|${r.바코드}|${b.boxNo}`;
        const o = out.get(k) || out.set(k, { share: 0, marked: 0, found: 0, rows: [] }).get(k);
        let marked = 0, found = 0;
        if (hasBoxes) {
          const entry = e[String(b.boxNo)] || null;
          if (entry) { marked = Math.min(share, Math.max(0, toN(entry.qty))); found = Math.min(marked, entryFound(entry)); }
        } else if (r.모바일) { marked = share; found = r.모바일 === 'found' ? share : 0; }   // 예전 행 요약
        o.share += share; o.marked += marked; o.found += found;
        o.rows.push({ listId: r.listId, allocId: r.allocId, source: r.source, share, marked, shareTotal });
      }
    });
    // 배정되지 못하고 남은 가상 분량
    for (const [bc, list] of Object.entries(vbo.virtualByBc || {})) for (const b of list) {
      const left = (b.remainFree || 0) + Object.values(b.remainByCode || {}).reduce((s, v) => s + (v || 0), 0);
      const k = `${no}|${bc}|${b.boxNo}`;
      if (left > 0) orphan.set(k, (orphan.get(k) || 0) + left);
    }
  }
  return { map: out, orphan };
}

// ── 박스 상태 판정 ──
//   boxes: rk_ship_boxes 행 [{ id, order_number, box_no, virtual_confirmed_qty, shipped_at? }]
//   items: rk_ship_box_items 행 [{ box_id, order_number, barcode, qty, virtual_qty }]
//   fm: boxFoundMap() 결과
//   → Map(box.id → { state, vsum, found, short, done, total, labelOk, allFound, shipped, items: Map(barcode → { qty, virtual, marked, found, state, confirmed }) })
//     state: '실제'(가상 없음) | '미진행' | '진행' | '완료'  · item.state: 'real' | 'none' | 'part' | 'found' | 'short'
//     found = 가상확인(찾은 수량, 가상 분량 안에서) · short = 입력이 끝난 상품의 (가상 − 찾음) 합
//     confirmed(납품수량) = (qty − virtual) + found
function boxReadiness(boxes, items, fm) {
  const map = (fm && fm.map) || new Map();
  const orphan = (fm && fm.orphan) || new Map();
  const byBox = new Map();
  for (const it of items || []) {
    if (!byBox.has(it.box_id)) byBox.set(it.box_id, new Map());
    const m = byBox.get(it.box_id);
    const cur = m.get(it.barcode) || { qty: 0, virtual: 0 };
    cur.qty += Math.max(0, toN(it.qty)); cur.virtual += Math.max(0, toN(it.virtual_qty));
    m.set(it.barcode, cur);
  }
  const out = new Map();
  for (const b of boxes || []) {
    const its = byBox.get(b.id) || new Map();
    const res = { state: '실제', vsum: 0, found: 0, short: 0, done: 0, total: 0, labelOk: false, allFound: false, shipped: !!b.shipped_at, items: new Map() };
    let anyMark = false;
    for (const [bc, v] of its) {
      const it = { qty: v.qty, virtual: Math.min(v.virtual, v.qty), marked: 0, found: 0, state: 'real' };
      if (it.virtual > 0) {
        const key = `${b.order_number}|${bc}|${b.box_no}`;
        const f = map.get(key);
        it.marked = Math.min(it.virtual, f ? f.marked : 0);
        it.found = Math.min(it.marked, f ? f.found : 0);
        // 배정 행이 없어 카드가 안 뜨는 분량(orphan: 배정이 줄었는데 가상 박스는 그대로) — 찾을 길이 없으니 0개(부족)로 입력된 것으로 본다
        const orph = Math.min(it.virtual - it.marked, orphan.get(key) || 0);
        if (orph > 0) { it.marked += orph; it.orphan = orph; }
        it.state = it.marked <= 0 ? 'none' : it.marked < it.virtual ? 'part' : it.found >= it.virtual ? 'found' : 'short';
        if (it.marked > 0) anyMark = true;
        res.vsum += it.virtual; res.total++; res.found += it.found;
        if (it.state === 'found' || it.state === 'short') { res.done++; res.short += it.virtual - it.found; }
      }
      it.confirmed = (it.qty - it.virtual) + it.found;
      res.items.set(bc, it);
    }
    res.labelOk = res.vsum > 0 && toN(b.virtual_confirmed_qty) === res.vsum;
    if (res.total) {
      if (res.done === res.total) res.state = '완료';
      else if (!anyMark && res.labelOk) {   // 예전 경로: 모바일 입력 없이 박스 라벨 가상확정만 → 다 찾은 것으로
        res.state = '완료'; res.done = res.total; res.found = res.vsum;
        for (const it of res.items.values()) if (it.virtual > 0) { it.marked = it.virtual; it.found = it.virtual; it.state = 'found'; it.confirmed = it.qty; }
      } else res.state = anyMark ? '진행' : '미진행';
    }
    res.allFound = res.state === '완료' && res.short === 0;
    out.set(b.id, res);
  }
  return out;
}
// 발주서 상태 (출고 안 된 박스 기준) — 박스 상태들 → '미진행' | '진행' | '완료' | '출고'
function orderStateOf(boxStates) {
  const live = boxStates.filter((s) => !s.shipped);
  if (!live.length) return boxStates.length ? '출고' : '미진행';
  const st = live.map((s) => (s.state === '실제' ? '완료' : s.state));
  if (st.every((s) => s === '완료')) return '완료';
  if (st.every((s) => s === '미진행')) return '미진행';
  return '진행';
}

module.exports = {
  boxEntries, entryFound, summarizeMarks, markPatch, marksError,
  loadVirtualBoxes, assignVirtualBoxes, loadAllModeRows,
  boxFoundMap, boxReadiness, orderStateOf,
  hasShippedCol, SHIPPED_SQL_MSG, hasLabelCol, LABEL_SQL_MSG, hasBoxCol,
};
