/**
 * 과거 발주 이력 적재 — 쿠팡 "발주 SKU 목록" 엑셀 → rk_order_history (2026-11-12)
 *   테이블 · 함수: supabase/rk_order_history.sql (먼저 DB 에 적용돼 있어야 한다) · 설계: docs/plan-analytics.md §6
 *
 *   node scripts/load-order-history.js <엑셀 경로> [--dry | --verify]
 *     --verify : 이미 넣은 뒤 대조만 (upsert · rebuild 를 건너뛰고 rk_order_history_check 로 5 · 6 단계만)
 *                rebuild 가 API 시간 제한(statement timeout)에 걸리면 SQL Editor 에서
 *                select rk_order_history_rebuild(); 를 실행한 뒤 이 옵션으로 확인한다.
 *
 * 순서 (어느 단계든 어긋나면 멈추고 이유를 적는다 — 반쯤 맞는 자료를 넣지 않는다)
 *   1. 엑셀 읽기 · 검증 (readHistory): 필수 열 · 빈 값 · 날짜 형식 · 음수/소수 · (발주번호, 바코드) 중복 ·
 *      한 발주서의 센터/입고예정일/발주일이 하나인지 · 수량 × 매입가 = 파일의 금액
 *   2. 운영 테이블(rk_orders)과 발주번호가 겹치지 않는지 (겹치면 멈춘다 — 분석이 운영 쪽만 세므로 넣을 이유가 없다)
 *   3. --dry 면 여기서 끝 (DB 에 쓰지 않는다)
 *   4. 1000행씩 upsert (유일키 order_number + barcode → 다시 돌려도 같은 결과)
 *   5. rk_order_history_rebuild() — 발주서 × 브랜드 요약 다시 만들기
 *   6. DB 를 처음부터 끝까지 다시 읽어 엑셀과 한 줄씩 대조 + 원본 합계 = 요약 합계 확인
 *
 * 이 스크립트는 넣기만 한다 (엑셀에 없는 기존 행은 지우지 않는다) — 다른 기간 파일을 이어서 넣을 수 있다.
 */
const path = require('path');
const XLSX = require('xlsx');

const SHEET = '발주 SKU 목록';
const COLS = ['발주번호', '발주유형', '발주현황', 'SKU ID', 'SKU 이름', 'SKU Barcode', '물류센터', '입고예정일', '발주일',
  '발주수량', '확정수량', '입고수량', '매입가(VAT포함)', '공급가', '부가세', '총발주 매입금', '입고금액'];
const CHUNK = 1000;

const str = (v) => (v == null ? '' : String(v).trim());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DT_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/;
const validDate = (s) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// rk_order_history.brand 생성 열과 같은 규칙 (대조용)
const brandOf = (name) => (name.startsWith('아이엠몽') ? '아이엠몽' : name.startsWith('이유몽') ? '이유몽' : '기타');

/**
 * 엑셀 → 검증된 행. 문제가 하나라도 있으면 Error (메시지에 앞의 몇 건을 적는다)
 * @returns {{ rows: object[], stats: object }}
 */
function readHistory(file) {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[SHEET] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`시트를 찾을 수 없습니다: ${SHEET}`);
  const raw = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  if (!raw.length) throw new Error('엑셀에 데이터 행이 없습니다.');
  const missing = COLS.filter((c) => !(c in raw[0]));
  if (missing.length) throw new Error(`엑셀에 필요한 열이 없습니다: ${missing.join(', ')}`);

  const errs = [];
  const err = (i, msg) => { if (errs.length < 20) errs.push(`${i + 2}행: ${msg}`); else if (errs.length === 20) errs.push('…'); };
  const int = (v, i, name) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) { err(i, `${name} 가 0 이상의 정수가 아닙니다 (${v})`); return 0; } return v; };
  const num = (v, i, name) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { err(i, `${name} 가 0 이상의 숫자가 아닙니다 (${v})`); return 0; } return v; };

  const source = path.basename(file);
  const rows = [];
  const seen = new Set();
  const perOrder = new Map();   // 발주번호 → 센터|입고예정일|발주일(날짜)
  let trimmedNames = 0, overConfirmed = 0;
  raw.forEach((r, i) => {
    const order_number = str(r['발주번호']), barcode = str(r['SKU Barcode']), center = str(r['물류센터']);
    const nameRaw = r['SKU 이름'] == null ? '' : String(r['SKU 이름']);
    const product_name = nameRaw.trim();
    if (product_name !== nameRaw) trimmedNames++;
    if (!order_number) err(i, '발주번호가 비었습니다');
    if (!barcode) err(i, 'SKU Barcode 가 비었습니다');
    if (!product_name) err(i, 'SKU 이름이 비었습니다');
    if (!center) err(i, '물류센터가 비었습니다');
    const arrival_date = str(r['입고예정일']);
    if (!validDate(arrival_date)) err(i, `입고예정일 형식이 YYYY-MM-DD 가 아닙니다 (${r['입고예정일']})`);
    const m = DT_RE.exec(str(r['발주일']));
    if (!m || !validDate(m[1])) err(i, `발주일 형식이 YYYY-MM-DD HH:MM[:SS] 가 아닙니다 (${r['발주일']})`);
    const reg_date = m ? m[1] : '';
    const ordered_at = m ? `${m[1]}T${m[2]}${m[3] || ':00'}+09:00` : null;   // 파일의 시각은 한국 시간
    const order_qty = int(r['발주수량'], i, '발주수량'), confirmed_qty = int(r['확정수량'], i, '확정수량'), received_qty = int(r['입고수량'], i, '입고수량');
    const purchase_price = num(r['매입가(VAT포함)'], i, '매입가(VAT포함)');
    const supply_price = r['공급가'] == null ? null : num(r['공급가'], i, '공급가');
    const vat = r['부가세'] == null ? null : num(r['부가세'], i, '부가세');
    // 분석 금액은 수량 × 매입가로 계산한다 → 파일의 금액과 같아야 한다
    if (r['총발주 매입금'] != null && order_qty * purchase_price !== r['총발주 매입금']) err(i, `발주수량 × 매입가(${order_qty * purchase_price}) ≠ 총발주 매입금(${r['총발주 매입금']})`);
    if (confirmed_qty > order_qty) overConfirmed++;

    const key = `${order_number}|${barcode}`;
    if (seen.has(key)) err(i, `(발주번호, 바코드) 중복: ${key}`);
    seen.add(key);
    const sig = `${center}|${arrival_date}|${reg_date}`;
    const prev = perOrder.get(order_number);
    if (prev === undefined) perOrder.set(order_number, sig);
    else if (prev !== sig) err(i, `발주서 ${order_number} 의 센터·입고예정일·발주일이 줄마다 다릅니다 (${prev} / ${sig})`);

    rows.push({
      order_number, barcode, sku_id: str(r['SKU ID']) || null, product_name, center, arrival_date, ordered_at,
      order_type: str(r['발주유형']) || null, order_status: str(r['발주현황']) || null,
      order_qty, confirmed_qty, received_qty, purchase_price, supply_price, vat, source_file: source,
      _reg: reg_date,   // 대조용 (DB 에 보내지 않는다 — reg_date 는 생성 열)
    });
  });
  if (errs.length) throw new Error(`엑셀 검증 실패 (${file})\n  ` + errs.join('\n  '));

  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const brands = {};
  for (const r of rows) brands[brandOf(r.product_name)] = (brands[brandOf(r.product_name)] || 0) + 1;
  const stats = {
    lines: rows.length, orders: perOrder.size, barcodes: new Set(rows.map((r) => r.barcode)).size,
    oq: sum((r) => r.order_qty), cq: sum((r) => r.confirmed_qty), rq: sum((r) => r.received_qty),
    amt: sum((r) => r.order_qty * r.purchase_price), camt: sum((r) => r.confirmed_qty * r.purchase_price),
    minArrival: rows.reduce((a, r) => (r.arrival_date < a ? r.arrival_date : a), '9999'), maxArrival: rows.reduce((a, r) => (r.arrival_date > a ? r.arrival_date : a), ''),
    minReg: rows.reduce((a, r) => (r._reg < a ? r._reg : a), '9999'), maxReg: rows.reduce((a, r) => (r._reg > a ? r._reg : a), ''),
    brands, trimmedNames, overConfirmed,
  };
  return { rows, stats };
}

const dbRow = (r) => { const o = Object.assign({}, r); delete o._reg; return o; };

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await build().range(from, from + CHUNK - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < CHUNK) break;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const verifyOnly = args.includes('--verify');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('사용법: node scripts/load-order-history.js <엑셀 경로> [--dry | --verify]'); process.exit(2); }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log(`[1/6] 엑셀 읽기 · 검증: ${file}`);
  const { rows, stats } = readHistory(file);
  console.log('      ', JSON.stringify(stats));
  if (stats.trimmedNames) console.log(`       상품명 앞뒤 공백 ${stats.trimmedNames}건은 떼고 넣습니다.`);
  if (stats.overConfirmed) console.log(`       ⚠ 확정수량 > 발주수량 ${stats.overConfirmed}건 (그대로 넣습니다).`);

  console.log('[2/6] 운영 테이블(rk_orders)과 발주번호 겹침 확인');
  const live = new Set((await pageAll(() => sb.from('rk_orders').select('order_number').order('id', { ascending: true }))).map((o) => String(o.order_number).trim()));
  const overlap = [...new Set(rows.map((r) => r.order_number))].filter((no) => live.has(no));
  if (overlap.length) throw new Error(`운영 테이블에 이미 있는 발주번호 ${overlap.length}건: ${overlap.slice(0, 10).join(', ')} … — 이 발주서들을 엑셀에서 빼고 다시 실행하세요.`);
  console.log(`       겹침 0 (운영 발주서 ${live.size}건)`);

  if (dry) { console.log('[--dry] 검증만 하고 끝냅니다. DB 에 쓰지 않았습니다.'); return; }

  let chk, eR;
  if (verifyOnly) {
    console.log('[3-4/6] --verify: upsert · rebuild 건너뜀 → rk_order_history_check');
    ({ data: chk, error: eR } = await sb.rpc('rk_order_history_check'));
    if (eR) throw new Error('rk_order_history_check 실패: ' + eR.message);
    console.log('      ', JSON.stringify(chk));
  } else {
    console.log(`[3/6] upsert ${rows.length}행 (${CHUNK}행씩)`);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK).map(dbRow);
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error } = await sb.from('rk_order_history').upsert(part, { onConflict: 'order_number,barcode' });
        lastErr = error; if (!error) break;
        console.log(`       ${i}~ 실패(${attempt}/3): ${error.message}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
      if (lastErr) throw new Error(`upsert 실패 (${i}행째부터): ${lastErr.message} — 다시 실행하면 이어서 채웁니다.`);
      if ((i / CHUNK) % 20 === 0) console.log(`       ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`);
    }

    console.log('[4/6] 요약 다시 만들기 (rk_order_history_rebuild)');
    ({ data: chk, error: eR } = await sb.rpc('rk_order_history_rebuild'));
    if (eR) throw new Error('rk_order_history_rebuild 실패: ' + eR.message
      + (/statement timeout/.test(eR.message) ? '\n  → 원본은 다 들어갔습니다. SQL Editor 에서 select rk_order_history_rebuild(); 실행 후 --verify 로 다시 돌리세요.' : ''));
    console.log('      ', JSON.stringify(chk));
  }

  console.log('[5/6] DB 를 다시 읽어 엑셀과 한 줄씩 대조');
  const back = await pageAll(() => sb.from('rk_order_history')
    .select('order_number, barcode, sku_id, product_name, brand, center, arrival_date, ordered_at, reg_date, order_type, order_status, order_qty, confirmed_qty, received_qty, purchase_price, supply_price, vat')
    .order('id', { ascending: true }));
  const byKey = new Map(back.map((b) => [`${b.order_number}|${b.barcode}`, b]));
  const diffs = [];
  const neq = (a, b) => (a == null ? b != null : typeof a === 'number' ? Number(b) !== a : String(b) !== String(a));
  for (const r of rows) {
    const b = byKey.get(`${r.order_number}|${r.barcode}`);
    if (!b) { diffs.push(`없음: ${r.order_number} ${r.barcode}`); continue; }
    for (const k of ['sku_id', 'product_name', 'center', 'arrival_date', 'order_type', 'order_status', 'order_qty', 'confirmed_qty', 'received_qty', 'purchase_price', 'supply_price', 'vat']) {
      if (neq(r[k], b[k])) diffs.push(`${r.order_number} ${r.barcode} ${k}: 엑셀 ${r[k]} / DB ${b[k]}`);
    }
    if (new Date(b.ordered_at).getTime() !== new Date(r.ordered_at).getTime()) diffs.push(`${r.order_number} ${r.barcode} ordered_at: 엑셀 ${r.ordered_at} / DB ${b.ordered_at}`);
    if (b.reg_date !== r._reg) diffs.push(`${r.order_number} ${r.barcode} reg_date: 엑셀 ${r._reg} / DB ${b.reg_date}`);
    if (b.brand !== brandOf(r.product_name)) diffs.push(`${r.order_number} ${r.barcode} brand: 기대 ${brandOf(r.product_name)} / DB ${b.brand}`);
    if (diffs.length > 30) break;
  }
  if (diffs.length) throw new Error(`대조 실패 ${diffs.length}건 이상\n  ` + diffs.slice(0, 30).join('\n  '));
  console.log(`       엑셀 ${rows.length}행 모두 DB 와 같습니다. (DB 전체 ${back.length}행 — 이 파일 밖의 행 ${back.length - rows.length})`);

  console.log('[6/6] 합계 확인 (원본 = 요약, 이 파일뿐이면 엑셀과도 같아야 한다)');
  const bad = [];
  for (const k of ['lines', 'oq', 'cq', 'rq', 'amt', 'camt']) if (Number(chk.raw[k]) !== Number(chk.ord[k])) bad.push(`원본 ${k} ${chk.raw[k]} ≠ 요약 ${chk.ord[k]}`);
  if (Number(chk.raw.orders) !== Number(chk.ord.orders)) bad.push(`원본 발주서 ${chk.raw.orders} ≠ 요약 ${chk.ord.orders}`);
  if (Number(chk.overlapLive) !== 0) bad.push(`운영 테이블과 겹치는 발주번호 ${chk.overlapLive}건`);
  if (back.length === rows.length) {
    for (const k of ['lines', 'orders', 'barcodes', 'oq', 'cq', 'rq', 'amt', 'camt']) if (Number(chk.raw[k]) !== Number(stats[k])) bad.push(`DB ${k} ${chk.raw[k]} ≠ 엑셀 ${stats[k]}`);
    for (const k of ['minArrival', 'maxArrival', 'minReg', 'maxReg']) if (chk.raw[k] !== stats[k]) bad.push(`DB ${k} ${chk.raw[k]} ≠ 엑셀 ${stats[k]}`);
  }
  if (bad.length) throw new Error('합계 불일치\n  ' + bad.join('\n  '));
  console.log('       모두 일치. 끝.');
}

module.exports = { readHistory, brandOf, dbRow };

if (require.main === module) {
  main().catch((e) => { console.error('\n✖ ' + e.message); process.exit(1); });
}
