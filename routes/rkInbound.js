/**
 * CN입고 도메인 — 입고리스트 (엑셀 원본 적재)
 * 구조: rk_cn_shipments (출고코드 헤더) 1 : N rk_cn_shipment_items (아이템)
 * 파싱 규칙은 기존 importChina 와 동일 (Sheet3 / B열 'BR' 박스만 / A=팔렛 B=박스명 C=중국번호 H=상품명 J=수량 K=바코드)
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;
const VirtualPack = require('../virtualPack');   // virtual_codes 정리(trimCodes/sumCodes/STOCK_KEY) — 모바일 입고 박스 칩 배정용

// 상품명에서 모델코드 추출 (상품명 배지 기준):
// 콤마 있으면 첫 콤마 앞에서, 없으면 전체에서 — 영어+숫자 조합 단어를 뒤에서부터 탐색
function extractModelCode(name) {
  const s = String(name == null ? '' : name);
  const ci = s.indexOf(',');
  const target = ci > 0 ? s.slice(0, ci) : s;
  const words = target.trim().split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const t = words[i];
    if (/^[A-Za-z0-9]+$/.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t)) return t;
  }
  return null;
}

function toKorean(r) {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    shipmentCode: r.rk_cn_shipments ? r.rk_cn_shipments.shipment_code : null,
    status: r.rk_cn_shipments ? r.rk_cn_shipments.status : null,
    boxName: r.box_name,
    orderNumber: r.order_number,
    productName: r.product_name,
    quantity: r.quantity,
    barcode: r.barcode,
    note: r.note,
  };
}

// 테이블 전체 조회 — Supabase 는 range 를 안 주면 1000행에서 잘린다.
// ⚠ 잘려도 오류가 아니라 "조용히 일부만" 돌아오기 때문에, 화면에서는 데이터가 사라진 것처럼 보이고
//    계산(배정 합계 등)은 틀린 값으로 진행된다. 전체가 필요한 조회는 반드시 이 함수를 쓸 것.
async function pageAll(table, select, tweak) {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    // tweak 의 정렬을 먼저 적용하고 id 는 뒤에 붙인다(같은 값일 때 페이지가 흔들리지 않게 하는 보조키).
    let q = sb.from(table).select(select);
    if (tweak) q = tweak(q);
    q = q.order('id', { ascending: true }).range(from, from + size - 1);
    const { data, error } = await q;
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// 아이템 조회 (헤더 join) — 1000행 우회. shipmentIds 를 주면 그 출고코드의 아이템만 읽는다.
// 입고리스트/입고정리 화면은 선택한 출고코드만 부른다 (전체 6천 행을 매번 읽지 않도록).
async function fetchAllItems(shipmentIds) {
  if (Array.isArray(shipmentIds) && !shipmentIds.length) return [];
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    let q = sb
      .from('rk_cn_shipment_items')
      .select('*, rk_cn_shipments(shipment_code, status)');
    if (Array.isArray(shipmentIds)) q = q.in('shipment_id', shipmentIds);
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// 출고코드 → shipment id 목록 (?shipmentCode=A 또는 ?shipmentCodes=A,B,C)
async function shipmentIdsFromQuery(query) {
  const codes = [];
  if (query.shipmentCode) codes.push(String(query.shipmentCode).trim());
  if (query.shipmentCodes) codes.push(...String(query.shipmentCodes).split(',').map(s => s.trim()));
  const uniq = [...new Set(codes.filter(Boolean))];
  if (!uniq.length) return null; // 코드 지정 없음
  const { data, error } = await sb.from('rk_cn_shipments').select('id').in('shipment_code', uniq);
  if (error) throw error;
  return (data || []).map(s => s.id);
}

// 출고코드 목록 (코드별 요약: 아이템 수) — 아이템 본문은 읽지 않고 코드별 count 만 센다
router.get('/api/inbound/shipments', async (req, res) => {
  try {
    const shipments = await pageAll('rk_cn_shipments', '*',
      q => q.order('created_at', { ascending: false }));
    const counts = await Promise.all(shipments.map(s =>
      sb.from('rk_cn_shipment_items').select('id', { count: 'exact', head: true }).eq('shipment_id', s.id)
        .then(r => { if (r.error) throw r.error; return r.count || 0; })));
    res.json(shipments.map((s, i) => ({
      id: s.id, shipmentCode: s.shipment_code, status: s.status, memo: s.memo,
      itemCount: counts[i], createdAt: s.created_at, updatedAt: s.updated_at,
    })));
  } catch (e) {
    console.error('[rk] inbound/shipments:', e);
    res.status(500).json({ error: '출고코드 목록을 불러오는데 실패했습니다.' });
  }
});

// 입고리스트 아이템 목록 — ?shipmentCode=A 또는 ?shipmentCodes=A,B (지정 없으면 전체: 화면은 쓰지 않음)
router.get('/api/inbound/list', async (req, res) => {
  try {
    const ids = await shipmentIdsFromQuery(req.query);
    const rows = await fetchAllItems(ids);
    rows.sort((a, b) =>
      String(a.box_name || '').localeCompare(String(b.box_name || '')) ||
      String(a.barcode || '').localeCompare(String(b.barcode || '')));
    res.json(rows.map(toKorean));
  } catch (e) {
    console.error('[rk] inbound/list:', e);
    res.status(500).json({ error: '입고리스트를 불러오는데 실패했습니다.' });
  }
});

// 엑셀 원본 업로드 (헤더 upsert → 아이템 교체)
router.post('/api/inbound/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    const shipmentCode = (req.body.shipmentCode || '').trim();
    if (!shipmentCode) return res.status(400).json({ error: '출고코드가 입력되지 않았습니다.' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    if (!workbook.SheetNames.includes('Sheet3')) return res.status(400).json({ error: 'Sheet3를 찾을 수 없습니다.' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets['Sheet3'], { header: 'A' });
    const filtered = data.filter((row) => { const b = row['B']; return b && b.toString().startsWith('BR'); });

    // 1) 출고코드 헤더 upsert → id 확보
    const { data: sh, error: e1 } = await sb
      .from('rk_cn_shipments')
      .upsert({ shipment_code: shipmentCode }, { onConflict: 'shipment_code' })
      .select('id').single();
    if (e1) throw e1;
    const shipmentId = sh.id;

    // 2) 기존 아이템 교체
    const { error: e2 } = await sb.from('rk_cn_shipment_items').delete().eq('shipment_id', shipmentId);
    if (e2) throw e2;

    const rows = filtered.map((row) => ({
      shipment_id: shipmentId,
      pallet: row['A'] != null ? String(row['A']) : null,
      box_name: row['B'] != null ? String(row['B']) : null,
      order_number: row['C'] != null ? String(row['C']) : null,
      product_name: row['H'] != null ? String(row['H']) : null,
      quantity: row['J'] != null ? String(row['J']) : '0',
      barcode: row['K'] != null ? String(row['K']) : null,
      note: null,
    }));

    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await sb.from('rk_cn_shipment_items').insert(rows.slice(i, i + BATCH));
      if (error) throw error;
    }

    res.json({ message: `업로드 완료 (${rows.length}건)`, count: rows.length, shipmentId });
  } catch (e) {
    console.error('[rk] inbound/upload:', e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 비고 수정 (아이템 id 기준)
router.post('/api/inbound/update-note', async (req, res) => {
  try {
    const { id, note } = req.body;
    if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
    const { error } = await sb.from('rk_cn_shipment_items').update({ note: note ?? null }).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('[rk] inbound/update-note:', e);
    res.status(500).json({ error: '비고 저장 중 오류가 발생했습니다.' });
  }
});

// 아이템 + 배정(alloc)으로 { shipping(출고리스트), stock(남은상품) } 구성
function buildArranged(items, allocs) {
  const byItem = new Map();
  for (const a of allocs) {
    if (!byItem.has(a.shipment_item_id)) byItem.set(a.shipment_item_id, []);
    byItem.get(a.shipment_item_id).push(a);
  }
  const shipping = [], stock = [];
  for (const it of items) {
    const base = {
      출고코드: it.rk_cn_shipments ? it.rk_cn_shipments.shipment_code : null,
      박스명: it.box_name, 중국번호: it.order_number, 상품명: it.product_name, 바코드: it.barcode,
    };
    const total = parseInt(it.quantity) || 0;
    const list = byItem.get(it.id) || [];
    let allocated = 0;
    for (const a of list) {
      shipping.push({ ...base, allocId: a.id, 수량: total, 출고번호: a.order_number, 센터: a.center, 출고개수: a.ship_qty, 출고예정일: a.shipping_date || '', 회차: a.batch_no || 1, preparedAt: a.prepared_at,
        모바일: a.mobile_status || null, 모바일처리자: a.mobile_by || null, 모바일시각: a.mobile_at || null,   // 모바일 입고 찾음/없음 표시
        모바일메모: a.mobile_memo || null, 모바일메모처리자: a.mobile_memo_by || null, 모바일메모시각: a.mobile_memo_at || null });   // 모바일 메모 (2026-10-21)
      allocated += a.ship_qty || 0;
    }
    const leftover = total - allocated;
    if (leftover > 0) stock.push({ ...base, 수량: leftover });
  }
  return { shipping, stock };
}

// 저장된 출고배정 조회 → { shipping, stock }
router.get('/api/inbound/arranged', async (req, res) => {
  try {
    const ids = await shipmentIdsFromQuery(req.query);
    const items = await fetchAllItems(ids);
    const itemIds = items.map(i => i.id);
    // 배정도 이 아이템들 것만 읽는다 (코드 지정 없으면 전체)
    const allocs = ids
      ? await S.chunked(itemIds, 200, (part) => pageAll('rk_cn_shipping', '*', q => q.in('shipment_item_id', part)))
      : (await pageAll('rk_cn_shipping', '*')).filter(a => itemIds.includes(a.shipment_item_id));
    res.json(buildArranged(items, allocs));
  } catch (e) {
    console.error('[rk] inbound/arranged:', e);
    res.status(500).json({ error: '출고배정 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

// ============================================================
// 모바일 입고 (/mobileInbound) — 종이 [인쇄] 대신 폰으로 출고리스트를 한 줄씩 넘기며 [스캔](찾음)/[없음] 표시
//   저장 단위 = rk_cn_shipping 행 (mobile_status/mobile_at/mobile_by). 출고개수·배정·박스는 건드리지 않는다.
//   순서 = 입고정리 기본 정렬(회차 › 출고예정일 › 센터 › 출고번호) 안에서 박스명 › id
// ============================================================
const mobileCmp = (a, b) =>
  ((Number(a.회차) || 0) - (Number(b.회차) || 0))
  || String(a.출고예정일 || '').localeCompare(String(b.출고예정일 || ''), 'ko', { numeric: true })
  || String(a.센터 || '').localeCompare(String(b.센터 || ''), 'ko', { numeric: true })
  || String(a.출고번호 || '').localeCompare(String(b.출고번호 || ''), 'ko', { numeric: true })
  || String(a.박스명 || '').localeCompare(String(b.박스명 || ''), 'ko', { numeric: true })
  || ((a.allocId || 0) - (b.allocId || 0));

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
  const [boxes, bItems] = await Promise.all([
    S.chunked(nos, 200, (part) => S.pageAll(() => sb.from('rk_ship_boxes').select('id, order_number, box_no, box_size').in('order_number', part).order('id', { ascending: true }))),
    S.chunked(nos, 200, (part) => S.pageAll(() => sb.from('rk_ship_box_items').select('order_number, box_id, barcode, qty, virtual_qty, virtual_codes').in('order_number', part).order('id', { ascending: true }))),
  ]);
  const boxById = new Map();
  for (const b of boxes) { boxById.set(b.id, b); (out[String(b.order_number)] ||= { boxes: [], virtualByBc: {}, codesByBox: {} }).boxes.push(b); }
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
// 입고코드 섞임 판정 — 발주서(boxNo 없음)면 가상 박스 전체에 기록된 입고코드가 둘 이상, 박스 라벨로 들어왔으면 그 박스 안에 둘 이상.
//   섞였으면 { codes:[…], boxes:[{ boxNo, codes:[…] }] } (코드가 기록된 박스 전부, 번호 순) · 아니면 null. 코드 기록이 없는 예전 저장분은 알 수 없어 null
function mixedInboundCodes(vbOrder, boxNo) {
  const byBox = (vbOrder && vbOrder.codesByBox) || {};
  const sortCodes = (s) => [...s].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const boxes = Object.keys(byBox).map(Number).sort((a, b) => a - b).map((no) => ({ boxNo: no, codes: sortCodes(byBox[no]) }));
  if (!boxes.length) return null;
  const scope = boxNo != null && boxNo !== 0 ? boxes.filter((b) => b.boxNo === boxNo) : boxes;
  const codes = sortCodes(new Set(scope.flatMap((b) => b.codes)));
  return codes.length > 1 ? { codes, boxes } : null;
}

// 출고코드의 **박스** 목록 + 진행 (?shipmentCode=) — 2026-10-15: 발주서 단위 → (발주서, 가상 박스) 단위
//   박스 라벨(발주번호-박스번호)을 박스 단위로 뽑아 박스 단위로 찾으므로 목록도 박스 단위로. 한 발주서에 가상 박스가 여럿이면 줄이 여럿.
//   가상 박스에 안 잡힌 행(출고스캔 전·실제 스캔분)은 그 발주서의 "박스 미정"(boxNo null) 줄로 따로.
//   진행(total/found/missing)은 그 박스 몫의 카드 수 — 한 행이 두 박스에 걸치면 둘 다에 센다 (mobile-list 가 두 박스 모두에서 그 카드를 보여주는 것과 같다)
// 응답: [{ orderNumber, boxNo(null=미정), boxSize, center, shippingDate, batch, total, found, missing, qty(담을 개수), kg(무게, coupang_items.weight 합) }] — 기본 정렬 › 박스번호 순(미정은 그 발주서 끝)
router.get('/api/inbound/mobile-orders', async (req, res) => {
  try {
    const code = String(req.query.shipmentCode || '').trim();
    if (!code) return res.status(400).json({ error: '출고코드가 필요합니다.' });
    const ids = await shipmentIdsFromQuery({ shipmentCode: code });
    if (!ids.length) return res.json([]);
    const allocs = await pageAll('rk_cn_shipping', '*', q => q.in('shipment_id', ids));
    if (!allocs.length) return res.json([]);
    const itemIds = [...new Set(allocs.map(a => a.shipment_item_id))];
    const items = await S.chunked(itemIds, 200, (part) => pageAll('rk_cn_shipment_items', '*, rk_cn_shipments(shipment_code, status)', q => q.in('id', part)));
    const rows = buildArranged(items, allocs).shipping.sort(mobileCmp);
    const byOrder = new Map();   // 발주번호 → 행들 (정렬 순서 유지 = 첫 등장 순)
    for (const r of rows) { const no = String(r.출고번호 || ''); if (!no) continue; if (!byOrder.has(no)) byOrder.set(no, []); byOrder.get(no).push(r); }
    const vb = await loadVirtualBoxes([...byOrder.keys()]);
    // 무게 — coupang_items.weight(g). 없으면 200 g 으로 본다 (가상스캔 계산기의 기본값과 같다)
    const gByBc = new Map();
    const bcs = [...new Set(rows.map(r => r.바코드).filter(Boolean))];
    for (const part of (await S.chunked(bcs, 200, async (p) => { const { data, error } = await sb.from('coupang_items').select('barcode, weight').in('barcode', p); if (error) throw error; return data || []; })))
      if (part.barcode && !gByBc.has(part.barcode) && parseInt(part.weight, 10) > 0) gByBc.set(part.barcode, parseInt(part.weight, 10));
    const kgOf = (bc, qty) => (gByBc.get(bc) || 200) * qty / 1000;
    const list = [];
    for (const [no, ors] of byOrder) {
      const assigned = assignVirtualBoxes(ors, (vb[no] || {}).virtualByBc);
      const byBox = new Map();   // boxNo(0 = 미정) → 집계
      ors.forEach((r, i) => {
        const keys = assigned[i].length ? assigned[i].map(b => b.boxNo) : [0];
        for (const k of keys) {
          if (!byBox.has(k)) {
            const bx = assigned[i].find(b => b.boxNo === k);
            // codes: 이 박스에 기록된 입고코드들(virtual_codes) · mixed: 둘 이상 = 입고일이 섞인 박스 (목록에 표시, 카드 진입 때 확인 모달)
            const codes = k ? [...((vb[no] || {}).codesByBox || {})[k] || []].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })) : [];
            byBox.set(k, { orderNumber: no, boxNo: k || null, boxSize: bx ? bx.boxSize || null : null,
              center: r.센터 || '', shippingDate: r.출고예정일 || '', batch: r.회차 || 1, total: 0, found: 0, missing: 0, qty: 0, kg: 0,
              codes, mixed: codes.length > 1 });
          }
          const o = byBox.get(k);
          // 개수·무게 = 이 박스에 담을 분량 (카드의 출고개수와 같은 값: 박스 몫, 미정은 행의 출고개수)
          const q = k ? (assigned[i].find(b => b.boxNo === k) || {}).virtualQty || 0 : (parseInt(r.출고개수, 10) || 0);
          o.qty += q; o.kg += kgOf(r.바코드, q);
          o.total++;
          if (r.모바일 === 'found') o.found++;
          else if (r.모바일 === 'missing') o.missing++;
          o.batch = Math.min(o.batch, r.회차 || 1);
        }
      });
      for (const k of [...byBox.keys()].sort((a, b) => ((a === 0) - (b === 0)) || (a - b))) { const o = byBox.get(k); o.kg = Math.round(o.kg * 10) / 10; list.push(o); }
    }
    res.json(list);
  } catch (e) {
    console.error('[rk] inbound/mobile-orders:', e);
    res.status(500).json({ error: '박스 목록 조회 실패: ' + e.message });
  }
});

// 발주서 1건의 출고리스트 행 (?shipmentCode=&orderNumber=) — 카드 순서대로, 이미지·가상 박스 포함
// 응답: { rows:[{ allocId, 회차, 출고코드, 출고번호, 센터, 출고예정일, 박스명, 중국번호, 상품명, 바코드, 출고개수, 모바일, 모바일처리자, 모바일시각, img, boxes:[{boxNo,boxSize,qty,virtualQty}] }] }
router.get('/api/inbound/mobile-list', async (req, res) => {
  try {
    const code = String(req.query.shipmentCode || '').trim();
    const orderNumber = String(req.query.orderNumber || '').trim();
    // boxNo: 박스 라벨("발주번호-박스번호")을 스캔한 경우 — 그 박스에 가상으로 담긴 상품 카드만, 칩도 그 박스만 (2026-10-15)
    //        0 = "박스 미정" (목록의 미정 줄) — 가상 박스에 안 잡힌 행만
    const boxNo = req.query.boxNo != null && String(req.query.boxNo).trim() !== '' ? parseInt(req.query.boxNo, 10) : null;
    if (!code || !orderNumber) return res.status(400).json({ error: '출고코드와 발주번호가 필요합니다.' });
    const ids = await shipmentIdsFromQuery({ shipmentCode: code });
    if (!ids.length) return res.status(404).json({ error: `출고코드 ${code} 를 찾을 수 없습니다.` });
    const allocs = await pageAll('rk_cn_shipping', '*', q => q.in('shipment_id', ids).eq('order_number', orderNumber));
    if (!allocs.length) return res.json({ rows: [] });
    const itemIds = [...new Set(allocs.map(a => a.shipment_item_id))];
    const items = await S.chunked(itemIds, 200, (part) => pageAll('rk_cn_shipment_items', '*, rk_cn_shipments(shipment_code, status)', q => q.in('id', part)));
    const rows = buildArranged(items, allocs).shipping.sort(mobileCmp);
    const barcodes = [...new Set(rows.map(r => r.바코드).filter(Boolean))];
    // 이미지(rk_inventories.img) + 이 발주서의 출고스캔 가상 박스 (가상 박스에 잡힌 상품은 어느 박스에 몇 개인지 카드에 보여준다)
    const [imgRows, vb] = await Promise.all([
      S.chunked(barcodes, 200, async (part) => { const { data, error } = await sb.from('rk_inventories').select('barcode, img').in('barcode', part); if (error) throw error; return data || []; }),
      loadVirtualBoxes([orderNumber]),
    ]);
    const img = {};
    for (const r of imgRows) { const u = String(r.img || '').trim(); if (r.barcode && u && !img[r.barcode]) img[r.barcode] = u; }
    const boxes = (vb[orderNumber] || {}).boxes || [];
    const boxExists = boxNo == null || boxNo === 0 || boxes.some(b => b.box_no === boxNo);
    // 행마다 출고개수만큼 박스를 앞에서부터 차지한다(assignVirtualBoxes). 박스 라벨로 들어왔으면(boxNo) 배정 결과 중 그 박스 몫만 남기고, 몫이 없는 행은 뺀다.
    //   boxNo 0(박스 미정)은 반대로 어느 가상 박스에도 안 잡힌 행만.
    const assigned = assignVirtualBoxes(rows, (vb[orderNumber] || {}).virtualByBc);
    const out = [];
    rows.forEach((r, i) => {
      let mine = assigned[i];
      if (boxNo === 0) { if (mine.length) return; }
      else if (boxNo != null) { mine = mine.filter(b => b.boxNo === boxNo); if (!mine.length) return; }
      out.push({ ...r, img: img[r.바코드] || null, boxes: mine });
    });
    // mixed: 입고코드가 둘 이상 섞인 발주서/박스면 { codes, boxes } — 화면이 카드 진입 전에 "입고일자 확인" 모달을 띄운다 (2026-10-15)
    res.json({ rows: out, boxNo, boxExists, mixed: mixedInboundCodes(vb[orderNumber], boxNo) });
  } catch (e) {
    console.error('[rk] inbound/mobile-list:', e);
    res.status(500).json({ error: '출고리스트 조회 실패: ' + e.message });
  }
});

// 찾음/없음 저장 — body: { allocId, status: 'found' | 'missing' | null, worker }
router.post('/api/inbound/mobile-check', async (req, res) => {
  try {
    const allocId = parseInt(req.body.allocId, 10);
    const status = req.body.status == null || req.body.status === '' ? null : String(req.body.status);
    const worker = String(req.body.worker || '').trim().slice(0, 40);
    if (!Number.isFinite(allocId)) return res.status(400).json({ error: 'allocId 가 필요합니다.' });
    if (status !== null && status !== 'found' && status !== 'missing') return res.status(400).json({ error: 'status 는 found / missing / null 이어야 합니다.' });
    const patch = status ? { mobile_status: status, mobile_at: new Date().toISOString(), mobile_by: worker || null } : { mobile_status: null, mobile_at: null, mobile_by: null };
    const { data, error } = await sb.from('rk_cn_shipping').update(patch).eq('id', allocId).select('id, mobile_status, mobile_at, mobile_by');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: '출고리스트 행을 찾을 수 없습니다 (취소됐을 수 있음).' });
    // 통합 출고리스트(rk_shipping_list) 미러에도 같은 표시 (2026-10-20, 모바일 [전체] 모드와 같은 상태로). 실패해도 위 저장은 그대로 — 판정은 rk_cn_shipping 기준
    { const { error: eM } = await sb.from('rk_shipping_list').update(patch).eq('cn_shipping_id', allocId);
      if (eM) console.error('[rk] inbound/mobile-check 미러 기록 실패(계속):', eM.message); }
    const r = data[0];
    res.json({ ok: true, allocId: r.id, 모바일: r.mobile_status, 모바일처리자: r.mobile_by, 모바일시각: r.mobile_at });
  } catch (e) {
    console.error('[rk] inbound/mobile-check:', e);
    res.status(500).json({ error: '저장 실패: ' + e.message });
  }
});

// ============================================================
// 모바일 입고 [전체] 모드 (2026-10-20, docs/plan-neworder-virtual.md §7) — 입고코드를 고르지 않고 발주서(박스) 하나의 재고 + 입고 배정을 전부 카드로
//   행 = rk_shipping_list status='출고예정' (재고 + 입고). 입고 행의 찾음/없음은 rk_cn_shipping(원본) 을 읽고 둘 다에 기록,
//   재고 행은 rk_shipping_list 에만. 가상 박스 칩은 virtual_codes 의 '재고' 분량까지 본다 (loadVirtualBoxes includeStock)
// ============================================================
// 카드 순서(동선): 입고 먼저(가상스캔이 담는 순서) › 입고코드(오래된 것 먼저) › 박스명 / 위치 › id. 박스 번호 정렬은 배정 뒤에 한다
//   extra(list): (선택) 첫 조회 결과로 함께 돌릴 조회 — 2단계 조회와 동시에 실행된다 (all-orders 의 무게 조회, 왕복 1회 절약)
async function loadAllModeRows(orderNumbers, extra) {
  const nos = [...new Set(orderNumbers.map(String).filter(Boolean))];
  if (!nos.length) return [];
  const list = await S.chunked(nos, 200, (part) => S.pageAll(() => sb.from('rk_shipping_list')
    .select('id, source, order_number, barcode, product_name, center, shipping_date, qty, location, shipment_id, shipment_item_id, cn_shipping_id, batch_no, mobile_status, mobile_at, mobile_by, mobile_memo, mobile_memo_at, mobile_memo_by')
    .eq('status', '출고예정').in('order_number', part).order('id', { ascending: true })));
  const itemIds = [...new Set(list.filter((r) => r.source === '입고' && r.shipment_item_id).map((r) => r.shipment_item_id))];
  const shipIds = [...new Set(list.filter((r) => r.source === '입고' && r.shipment_id).map((r) => r.shipment_id))];
  const cnIds = [...new Set(list.filter((r) => r.source === '입고' && r.cn_shipping_id).map((r) => r.cn_shipping_id))];
  const [items, ships, cns] = await Promise.all([
    S.chunked(itemIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipment_items').select('id, box_name, order_number, product_name').in('id', part); if (error) throw error; return data || []; }),
    S.chunked(shipIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipments').select('id, shipment_code, created_at').in('id', part); if (error) throw error; return data || []; }),
    S.chunked(cnIds, 200, async (part) => { const { data, error } = await sb.from('rk_cn_shipping').select('id, mobile_status, mobile_at, mobile_by, mobile_memo, mobile_memo_at, mobile_memo_by').in('id', part); if (error) throw error; return data || []; }),
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
      모바일: mob.mobile_status || null, 모바일처리자: mob.mobile_by || null, 모바일시각: mob.mobile_at || null,
      모바일메모: mob.mobile_memo || null, 모바일메모처리자: mob.mobile_memo_by || null, 모바일메모시각: mob.mobile_memo_at || null,
    });
  }
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });
  rows.sort((a, b) => cmp(a.출고번호, b.출고번호) || ((a.source === '입고' ? 0 : 1) - (b.source === '입고' ? 0 : 1))
    || cmp(a.codeAt, b.codeAt) || cmp(a.출고코드, b.출고코드) || cmp(a.source === '입고' ? a.박스명 : a.위치, b.source === '입고' ? b.박스명 : b.위치) || (a.listId - b.listId));
  return rows;
}
const firstBoxNo = (bxs) => (bxs && bxs.length ? Math.min(...bxs.map((b) => b.boxNo)) : Infinity);

// 목록 — 진행중(DONE 아님) 발주서 중 가상 박스(virtual_qty>0)가 있는 것만, (발주서, 박스) 단위. 모양은 mobile-orders 와 같다
router.get('/api/mobile/all-orders', async (req, res) => {
  try {
    // 왕복을 줄인다 (2026-10-21, 1.7초 → ): 진행중 발주서 헤더를 한 번에(번호 + 센터·입고예정일), 무게는 행 조회의 2단계와 동시에
    const hdrs = await S.pageAll(() => S.notDone(sb.from('rk_orders').select('order_number, logistics_center, arrival_date')).order('id', { ascending: true }));
    const hdr = new Map();
    for (const h of hdrs) if (h.order_number != null && !hdr.has(String(h.order_number))) hdr.set(String(h.order_number), h);
    const active = [...hdr.keys()];
    const vItems = await S.chunked(active, 200, (part) => S.pageAll(() => sb.from('rk_ship_box_items')
      .select('order_number').gt('virtual_qty', 0).in('order_number', part).order('id', { ascending: true })));
    const nos = [...new Set(vItems.map((r) => String(r.order_number)))];
    if (!nos.length) return res.json([]);
    const gByBc = new Map();
    const loadWeights = async (list) => {
      const bcs = [...new Set(list.map((r) => r.barcode).filter(Boolean))];
      for (const part of (await S.chunked(bcs, 200, async (p) => { const { data, error } = await sb.from('coupang_items').select('barcode, weight').in('barcode', p); if (error) throw error; return data || []; })))
        if (part.barcode && !gByBc.has(part.barcode) && parseInt(part.weight, 10) > 0) gByBc.set(part.barcode, parseInt(part.weight, 10));
    };
    const [rows, vb] = await Promise.all([
      loadAllModeRows(nos, loadWeights),
      loadVirtualBoxes(nos, { includeStock: true }),
    ]);
    const kgOf = (bc, qty) => (gByBc.get(bc) || 200) * qty / 1000;
    const byOrder = new Map();
    for (const r of rows) { if (!byOrder.has(r.출고번호)) byOrder.set(r.출고번호, []); byOrder.get(r.출고번호).push(r); }
    const list = [];
    for (const no of nos) {
      const ors = byOrder.get(no) || [];
      const h = hdr.get(no) || {};
      const assigned = assignVirtualBoxes(ors, (vb[no] || {}).virtualByBc);
      const byBox = new Map();
      ors.forEach((r, i) => {
        const keys = assigned[i].length ? assigned[i].map((b) => b.boxNo) : [0];
        for (const k of keys) {
          if (!byBox.has(k)) {
            const bx = assigned[i].find((b) => b.boxNo === k);
            const codes = k ? [...(((vb[no] || {}).codesByBox || {})[k] || [])].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })) : [];
            byBox.set(k, { orderNumber: no, boxNo: k || null, boxSize: bx ? bx.boxSize || null : null,
              center: S.str(h.logistics_center) || r.센터 || '', shippingDate: S.dateToYmd(h.arrival_date) || r.출고예정일 || '',
              total: 0, found: 0, missing: 0, qty: 0, kg: 0, codes, mixed: codes.length > 1, stockQty: 0, inboundQty: 0 });
          }
          const o = byBox.get(k);
          const q = k ? (assigned[i].find((b) => b.boxNo === k) || {}).virtualQty || 0 : r.출고개수;
          o.qty += q; o.kg += kgOf(r.바코드, q); o.total++;
          if (r.source === '재고') o.stockQty += q; else o.inboundQty += q;
          if (r.모바일 === 'found') o.found++; else if (r.모바일 === 'missing') o.missing++;
        }
      });
      for (const k of [...byBox.keys()].sort((a, b) => ((a === 0) - (b === 0)) || (a - b))) { const o = byBox.get(k); o.kg = Math.round(o.kg * 10) / 10; list.push(o); }
    }
    const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });
    list.sort((a, b) => cmp(a.shippingDate, b.shippingDate) || cmp(a.center, b.center) || cmp(a.orderNumber, b.orderNumber)
      || (((a.boxNo == null) - (b.boxNo == null)) || ((a.boxNo || 0) - (b.boxNo || 0))));
    res.json(list);
  } catch (e) {
    console.error('[rk] mobile/all-orders:', e);
    res.status(500).json({ error: '박스 목록 조회 실패: ' + e.message });
  }
});

// 발주서(또는 박스) 1건의 카드 — ?orderNumber=&boxNo= (boxNo 0 = 박스 미정). 응답 모양은 mobile-list 와 같고 행마다 listId·source·위치가 더 있다
router.get('/api/mobile/all-list', async (req, res) => {
  try {
    const orderNumber = String(req.query.orderNumber || '').trim();
    const boxNo = req.query.boxNo != null && String(req.query.boxNo).trim() !== '' ? parseInt(req.query.boxNo, 10) : null;
    if (!orderNumber) return res.status(400).json({ error: '발주번호가 필요합니다.' });
    const [rows, vb] = await Promise.all([loadAllModeRows([orderNumber]), loadVirtualBoxes([orderNumber], { includeStock: true })]);
    if (!rows.length) return res.json({ rows: [], boxNo, boxExists: true, mixed: null });
    const barcodes = [...new Set(rows.map((r) => r.바코드).filter(Boolean))];
    const imgRows = await S.chunked(barcodes, 200, async (part) => { const { data, error } = await sb.from('rk_inventories').select('barcode, img').in('barcode', part); if (error) throw error; return data || []; });
    const img = {};
    for (const r of imgRows) { const u = String(r.img || '').trim(); if (r.barcode && u && !img[r.barcode]) img[r.barcode] = u; }
    const boxes = (vb[orderNumber] || {}).boxes || [];
    const boxExists = boxNo == null || boxNo === 0 || boxes.some((b) => b.box_no === boxNo);
    const assigned = assignVirtualBoxes(rows, (vb[orderNumber] || {}).virtualByBc);
    const out = [];
    rows.forEach((r, i) => {
      let mine = assigned[i];
      if (boxNo === 0) { if (mine.length) return; }
      else if (boxNo != null) { mine = mine.filter((b) => b.boxNo === boxNo); if (!mine.length) return; }
      out.push({ ...r, img: img[r.바코드] || null, boxes: mine });
    });
    // 박스 번호 순 → 같은 박스 안은 위 동선 순서 그대로 (stable sort)
    out.sort((a, b) => firstBoxNo(a.boxes) - firstBoxNo(b.boxes));
    res.json({ rows: out, boxNo, boxExists, mixed: mixedInboundCodes(vb[orderNumber], boxNo) });
  } catch (e) {
    console.error('[rk] mobile/all-list:', e);
    res.status(500).json({ error: '카드 조회 실패: ' + e.message });
  }
});

// 찾음/없음 저장 ([전체] 모드) — body: { listId, status: 'found'|'missing'|null, worker }
//   입고 행: rk_cn_shipping(원본, 입고정리 '모바일' 열·가상확정 판정이 읽는 곳) 먼저 → rk_shipping_list 미러. 재고 행: rk_shipping_list 만
router.post('/api/mobile/check', async (req, res) => {
  try {
    const listId = parseInt(req.body.listId, 10);
    const status = req.body.status == null || req.body.status === '' ? null : String(req.body.status);
    const worker = String(req.body.worker || '').trim().slice(0, 40);
    if (!Number.isFinite(listId)) return res.status(400).json({ error: 'listId 가 필요합니다.' });
    if (status !== null && status !== 'found' && status !== 'missing') return res.status(400).json({ error: 'status 는 found / missing / null 이어야 합니다.' });
    const { data: rs, error: e0 } = await sb.from('rk_shipping_list').select('id, source, cn_shipping_id').eq('id', listId).limit(1);
    if (e0) throw e0;
    if (!rs || !rs.length) return res.status(404).json({ error: '출고리스트 행을 찾을 수 없습니다 (취소됐을 수 있음).' });
    const row = rs[0];
    const patch = status ? { mobile_status: status, mobile_at: new Date().toISOString(), mobile_by: worker || null } : { mobile_status: null, mobile_at: null, mobile_by: null };
    if (row.source === '입고' && row.cn_shipping_id) {
      const { data, error } = await sb.from('rk_cn_shipping').update(patch).eq('id', row.cn_shipping_id).select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: '입고 배정 원본을 찾을 수 없습니다 (취소됐을 수 있음).' });
    }
    const { error: e1 } = await sb.from('rk_shipping_list').update(patch).eq('id', listId);
    if (e1) throw e1;
    res.json({ ok: true, listId, 모바일: patch.mobile_status, 모바일처리자: patch.mobile_by, 모바일시각: patch.mobile_at });
  } catch (e) {
    console.error('[rk] mobile/check:', e);
    res.status(500).json({ error: '저장 실패: ' + e.message });
  }
});

// 메모 저장 (2026-10-21) — 상품을 찾다가 남기는 한 줄 메모. 찾음/없음·출고개수·배정은 그대로.
//   body: { allocId } ([입고] 모드, rk_cn_shipping.id) 또는 { listId } ([전체] 모드, rk_shipping_list.id) + { memo, worker }
//   입고 행은 rk_cn_shipping(원본, 입고정리 PC 표가 읽음) + rk_shipping_list 미러 둘 다, 재고 행은 rk_shipping_list 만. 빈 메모 = 지우기
router.post('/api/mobile/memo', async (req, res) => {
  try {
    const memo = String(req.body.memo == null ? '' : req.body.memo).trim().slice(0, 500);
    const worker = String(req.body.worker || '').trim().slice(0, 40);
    const patch = memo ? { mobile_memo: memo, mobile_memo_at: new Date().toISOString(), mobile_memo_by: worker || null } : { mobile_memo: null, mobile_memo_at: null, mobile_memo_by: null };
    let cnId = null, listId = null;
    if (req.body.listId != null) {
      listId = parseInt(req.body.listId, 10);
      if (!Number.isFinite(listId)) return res.status(400).json({ error: 'listId 가 올바르지 않습니다.' });
      const { data: rs, error } = await sb.from('rk_shipping_list').select('id, source, cn_shipping_id').eq('id', listId).limit(1);
      if (error) throw error;
      if (!rs || !rs.length) return res.status(404).json({ error: '출고리스트 행을 찾을 수 없습니다 (취소됐을 수 있음).' });
      if (rs[0].source === '입고' && rs[0].cn_shipping_id) cnId = rs[0].cn_shipping_id;
    } else {
      cnId = parseInt(req.body.allocId, 10);
      if (!Number.isFinite(cnId)) return res.status(400).json({ error: 'allocId 또는 listId 가 필요합니다.' });
    }
    if (cnId != null) {
      const { data, error } = await sb.from('rk_cn_shipping').update(patch).eq('id', cnId).select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: '입고 배정을 찾을 수 없습니다 (취소됐을 수 있음).' });
      const { error: eM } = await sb.from('rk_shipping_list').update(patch).eq('cn_shipping_id', cnId);
      if (eM) console.error('[rk] mobile/memo 미러 기록 실패(계속):', eM.message);
    } else {
      const { error } = await sb.from('rk_shipping_list').update(patch).eq('id', listId);
      if (error) throw error;
    }
    res.json({ ok: true, 모바일메모: patch.mobile_memo, 모바일메모처리자: patch.mobile_memo_by, 모바일메모시각: patch.mobile_memo_at });
  } catch (e) {
    console.error('[rk] mobile/memo:', e);
    res.status(500).json({ error: '메모 저장 실패: ' + e.message });
  }
});

// 박스 크기 변경 (2026-10-20) — 현장에서 가상스캔이 정한 상자(예: 극소)에 다 안 들어가 다른 크기(예: 중)로 바꿔 담았을 때 폰에서 바로 기록.
//   바꾸는 건 rk_ship_boxes.box_size 한 열뿐 — 박스 안 상품 배정·찾음/없음·가상확정 수량은 그대로다 (PC 출고스캔의 크기 변경과 같은 범위).
//   이미 뽑은 박스 라벨(bx_size)은 옛 크기가 되므로 화면이 재출력을 안내한다. 순서정리 도장·라벨출력은 DB 를 다시 읽어 새 크기로 나온다.
//   body: { orderNumber, boxNo, boxSize, worker }  → { ok, orderNumber, boxNo, prevSize, boxSize }
const BOX_SIZES = ['극소', '소', '중', '대', '대2'];   // 출고스캔(/shipScan) 크기 버튼과 같은 목록
router.post('/api/inbound/mobile-box-size', async (req, res) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const boxNo = parseInt(req.body.boxNo, 10);
    const boxSize = String(req.body.boxSize || '').trim();
    const worker = String(req.body.worker || '').trim().slice(0, 40);
    if (!orderNumber || !Number.isFinite(boxNo) || boxNo <= 0) return res.status(400).json({ error: '발주번호와 박스번호가 필요합니다.' });
    if (!BOX_SIZES.includes(boxSize)) return res.status(400).json({ error: `박스 크기는 ${BOX_SIZES.join('/')} 중 하나여야 합니다.` });
    // 처리완료(DONE) 발주서도 막지 않는다 — 모바일 입고의 찾음/없음 저장(mobile-check)과 같은 기준. 목록(mobile-orders)이 DONE 발주서의 박스도 주므로 현장에서 막히면 안 된다
    const { data: boxes, error: e1 } = await sb.from('rk_ship_boxes').select('id, box_size').eq('order_number', orderNumber).eq('box_no', boxNo).order('id', { ascending: true }).limit(1);
    if (e1) throw e1;
    if (!boxes || !boxes.length) return res.status(404).json({ error: `발주서 ${orderNumber} 에 📦${boxNo} 박스가 없습니다.` });
    const prevSize = String(boxes[0].box_size || '').trim();
    if (prevSize !== boxSize) {
      const { error: e2 } = await sb.from('rk_ship_boxes').update({ box_size: boxSize }).eq('id', boxes[0].id);
      if (e2) throw e2;
      console.log(`[rk] inbound/mobile-box-size: ${orderNumber}-${boxNo} ${prevSize || '(없음)'} → ${boxSize} (${worker || '작업자 미입력'})`);
    }
    res.json({ ok: true, orderNumber, boxNo, prevSize, boxSize, changed: prevSize !== boxSize });
  } catch (e) {
    console.error('[rk] inbound/mobile-box-size:', e);
    res.status(500).json({ error: '박스 크기 변경 실패: ' + e.message });
  }
});

// 출고배정 취소(삭제) — rk_cn_shipping 삭제 + rk_shipping_list 미러 정리.
// 남은상품은 아이템수량-배정합계로 매번 계산되므로 삭제하면 자동 복원됨.
//   입고정리 배정 삭제(아래 라우트) 와 신규 발주서 가상버전 [배정 취소](rkAllocate.js) 가 같이 쓴다. ids = rk_cn_shipping.id 정수 배열
async function deleteInboundAllocs(ids) {
  const { error: eMirror } = await sb.from('rk_shipping_list').delete().in('cn_shipping_id', ids);
  if (eMirror) console.error('[rk] shipping_list 미러 삭제 실패(계속 진행):', eMirror.message);
  const { data, error } = await sb.from('rk_cn_shipping').delete().in('id', ids).select('id');
  if (error) throw error;
  return { ok: true, deleted: data ? data.length : 0 };
}
router.deleteInboundAllocs = deleteInboundAllocs;
router.post('/api/inbound/shipping/delete', async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.allocIds) ? req.body.allocIds : []).map(v => parseInt(v, 10)).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: '취소할 항목이 없습니다.' });
    res.json(await deleteInboundAllocs(ids));
  } catch (e) {
    console.error('[rk] inbound/shipping/delete:', e);
    res.status(500).json({ error: '출고배정 취소 중 오류가 발생했습니다: ' + e.message });
  }
});

// 출고준비: 선택 발주서 기준으로 "남은 수량만" 증분 배정 → 새 회차(batch)로 rk_cn_shipping 저장
// 기존 배정은 보존(잠금). 회차는 출고코드별 max+1. 남은상품 = 아이템수량 - 배정합계(전 회차).
router.post('/api/inbound/prepare', async (req, res) => {
  try {
    const shipmentCode = (req.body.shipmentCode || '').trim();
    const orderNumbers = Array.isArray(req.body.orderNumbers) ? req.body.orderNumbers : null;

    // 대상 아이템 (출고코드가 있으면 그 코드 것만 읽는다)
    const items = await fetchAllItems(shipmentCode ? await shipmentIdsFromQuery({ shipmentCode }) : null);
    const targetItemIds = new Set(items.map(i => i.id));

    // 전체 배정 로드 — 1000행에서 잘리면 기존 배정을 못 보고 중복 배정된다
    const allAllocs = await pageAll('rk_cn_shipping', '*');

    // 발주 가용량 계산용: 바코드→(발주→이미 배정된 합계)  (전 출고코드/전 회차 통합)
    const consumedMap = new Map();
    for (const a of (allAllocs || [])) {
      if (!consumedMap.has(a.barcode)) consumedMap.set(a.barcode, new Map());
      const m = consumedMap.get(a.barcode);
      m.set(a.order_number, (m.get(a.order_number) || 0) + (a.ship_qty || 0));
    }

    // 대상 아이템의 기존 배정 → 아이템별 배정합계(남은수량 계산) + 출고코드별 최대 회차
    const existingForTarget = (allAllocs || []).filter(a => targetItemIds.has(a.shipment_item_id));
    // 재고확정(rk_cn_stock_arranges) 분량 — 재고정리에서 선반(rk_stocks)으로 올린 만큼은 입고 남은 수량에서 뺀다 (2026-10-20, D5).
    //   재고정리 화면의 남은상품(원본 − 출고 − 재고원장)과 같은 공식. 빼지 않으면 그 분량이 입고분으로 또 배정되고 재고에서도 배정될 수 있었다.
    //   이미 저장된 배정은 건드리지 않는다. 재고확정이 없는 아이템은 결과가 예전과 같다.
    const arrangedRows = targetItemIds.size > 2000
      ? (await pageAll('rk_cn_stock_arranges', 'shipment_item_id, qty')).filter(a => targetItemIds.has(a.shipment_item_id))   // 코드 지정 없이 전체 — 원장 통째로 몇 페이지
      : await S.chunked([...targetItemIds], 200, (part) => pageAll('rk_cn_stock_arranges', 'shipment_item_id, qty', q => q.in('shipment_item_id', part)));
    const arrangedByItem = new Map();
    for (const a of arrangedRows) arrangedByItem.set(a.shipment_item_id, (arrangedByItem.get(a.shipment_item_id) || 0) + (parseInt(a.qty, 10) || 0));
    const allocatedByItem = new Map();
    const maxBatchByShipment = new Map();
    for (const a of existingForTarget) {
      allocatedByItem.set(a.shipment_item_id, (allocatedByItem.get(a.shipment_item_id) || 0) + (a.ship_qty || 0));
      maxBatchByShipment.set(a.shipment_id, Math.max(maxBatchByShipment.get(a.shipment_id) || 0, a.batch_no || 0));
    }

    // 발주서 (선택된 것만)
    let orders = await S.listOrdersFull('rk_orders', 'rk_order_items', { excludeDone: true });
    if (orderNumbers && orderNumbers.length) orders = orders.filter(o => orderNumbers.includes(o.발주번호));

    const barcodesInItems = new Set(items.map(i => i.barcode).filter(Boolean));
    // 스캔·재고예약은 "선택된 진행중 발주서"의 것만 필요하다 → 발주번호로 좁혀 조회.
    // (예전엔 바코드로 조회해 처리완료 발주서 행까지 읽었고, 정렬 없는 range 페이징이라 1000행을 넘으면
    //  페이지 사이에 행이 빠지거나 겹칠 수 있었다. pageAll + id 정렬로 안정화.)
    const targetOrderNos = [...new Set(orders.map(o => String(o.발주번호 || '')).filter(Boolean))];
    const sumByOrderBc = (rows) => {
      const m = new Map();   // `${order_number}|${barcode}` -> qty 합
      for (const r of rows) {
        if (!r.order_number || !r.barcode) continue;
        const k = `${r.order_number}|${r.barcode}`;
        m.set(k, (m.get(k) || 0) + (parseInt(r.qty) || 0));
      }
      return m;
    };

    // 스캔수량 = 출고스캔(rk_ship_box_items)의 발주번호+바코드별 합 (scanned_qty 미사용)
    // 재고건 출고예정 예약 = rk_shipping_list(source='재고', status='출고예정')의 발주번호+바코드별 합.
    //   입고분(source='입고')은 rk_cn_shipping 의 미러이므로 consumedMap 과 중복되어 여기서는 제외한다.
    const [scanRows, stockRows] = await Promise.all([
      S.chunked(targetOrderNos, 200, (nos) => S.pageAll(() => sb.from('rk_ship_box_items')
        .select('order_number, barcode, qty').in('order_number', nos).order('id', { ascending: true }))),
      S.chunked(targetOrderNos, 200, (nos) => S.pageAll(() => sb.from('rk_shipping_list')
        .select('order_number, barcode, qty').eq('source', '재고').eq('status', '출고예정')
        .in('order_number', nos).order('id', { ascending: true }))),
    ]);
    const shipScanByOrderBc = sumByOrderBc(scanRows);
    const stockReservedByOrderBc = sumByOrderBc(stockRows);

    const orderProductMap = new Map(); // barcode -> [{order, availableQuantity}]
    for (const order of orders) {
      for (const p of (order.상품정보 || [])) {
        if (!p.상품바코드 || p.박스정보) continue;
        if (!barcodesInItems.has(p.상품바코드)) continue;
        const 스캔 = shipScanByOrderBc.get(`${order.발주번호}|${p.상품바코드}`) || 0;
        const consumed = consumedMap.has(p.상품바코드) && consumedMap.get(p.상품바코드).has(order.발주번호)
          ? consumedMap.get(p.상품바코드).get(order.발주번호) : 0;
        const 재고예약 = stockReservedByOrderBc.get(`${order.발주번호}|${p.상품바코드}`) || 0;
        // 소진량 = max(예약합, 출고스캔)  ※ 더하지 않는다.
        //   예약(입고 배정 + 재고 출고예정)된 물건이 출고스캔으로 박스에 담기면 같은 물건이 예약·스캔 양쪽에
        //   잡힌다(예약 상태가 스캔 후에도 '출고예정'으로 남음). 둘을 더하면 이중 차감돼, 아직 필요한 발주에
        //   남은상품이 배정되지 않았다. (예: 확정 27 · 입고배정 18 · 스캔 18 → 예전 27-18-18=-9, 지금 27-18=9)
        //   스캔이 예약보다 많으면 예약 밖에서 추가로 담긴 것이므로 스캔을 소진량으로 본다.
        //   입고1/입고2 는 미차감(입고1==스캔 이중차감 이력).
        const 예약 = consumed + 재고예약;
        const avail = (parseInt(p.확정수량) || 0) - Math.max(예약, 스캔);
        if (avail > 0) {
          if (!orderProductMap.has(p.상품바코드)) orderProductMap.set(p.상품바코드, []);
          orderProductMap.get(p.상품바코드).push({
            order: { 발주번호: order.발주번호, 물류센터: order.물류센터, 입고예정일: order.입고예정일 },
            availableQuantity: avail,
          });
        }
      }
    }

    // 증분 배정 (아이템의 남은 수량만, 새 회차 부여)
    const runAt = new Date().toISOString();
    const nextBatch = new Map(); // shipment_id -> 이번 run의 회차
    const allocRows = [];
    for (const it of items) {
      const total = parseInt(it.quantity) || 0;
      let remaining = total - (allocatedByItem.get(it.id) || 0) - (arrangedByItem.get(it.id) || 0);
      if (remaining <= 0) continue;
      const entries = (orderProductMap.get(it.barcode) || []).slice()
        .sort((a, b) => String(a.order.입고예정일 || '').localeCompare(String(b.order.입고예정일 || '')));
      for (const entry of entries) {
        if (remaining <= 0) break;
        const assign = Math.min(remaining, entry.availableQuantity);
        if (assign > 0) {
          if (!nextBatch.has(it.shipment_id)) nextBatch.set(it.shipment_id, (maxBatchByShipment.get(it.shipment_id) || 0) + 1);
          allocRows.push({
            shipment_item_id: it.id, shipment_id: it.shipment_id, barcode: it.barcode,
            order_number: entry.order.발주번호, center: entry.order.물류센터, ship_qty: assign,
            shipping_date: entry.order.입고예정일 || '', batch_no: nextBatch.get(it.shipment_id), prepared_at: runAt,
          });
          entry.availableQuantity -= assign;
          remaining -= assign;
        }
      }
    }

    // 저장 (기존 유지 + 신규 추가)
    const insertedIds = [];
    if (allocRows.length) {
      const BATCH = 1000;
      for (let i = 0; i < allocRows.length; i += BATCH) {
        const { data, error } = await sb.from('rk_cn_shipping').insert(allocRows.slice(i, i + BATCH)).select('id');
        if (error) throw error;
        insertedIds.push(...(data || []).map(d => d.id));
      }
    }

    // rk_shipping_list 미러링 (통합 출고리스트, source='입고') — 비파괴: 실패해도 기존 동작 유지
    if (allocRows.length) {
      try {
        const nameByItem = new Map(items.map(i => [i.id, i.product_name]));
        const mirror = allocRows.map((r, idx) => ({
          source: '입고', status: '출고예정',
          barcode: r.barcode, product_name: nameByItem.get(r.shipment_item_id) || null,
          order_number: r.order_number, center: r.center, shipping_date: r.shipping_date || null,
          qty: r.ship_qty,
          shipment_id: r.shipment_id, shipment_item_id: r.shipment_item_id,
          cn_shipping_id: insertedIds[idx] || null, batch_no: r.batch_no, prepared_at: r.prepared_at,
        }));
        const BATCH = 1000;
        for (let i = 0; i < mirror.length; i += BATCH) {
          const { error } = await sb.from('rk_shipping_list').insert(mirror.slice(i, i + BATCH));
          if (error) throw error;
        }
      } catch (mirrorErr) {
        console.error('[rk] shipping_list 미러링 실패(출고준비는 정상 처리됨):', mirrorErr.message);
      }
    }

    const newBatch = allocRows.length ? Math.max(...allocRows.map(r => r.batch_no)) : null;
    const result = buildArranged(items, existingForTarget.concat(allocRows));
    res.json({ ...result, saved: allocRows.length, batch: newBatch });
  } catch (e) {
    console.error('[rk] inbound/prepare:', e);
    res.status(500).json({ error: '출고준비 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 바코드 → 위치 후보 목록: rk_stocks(재고 위치)만 참조
async function locationCandidatesByBarcode(barcodes) {
  const map = new Map(); // barcode -> Set(location)
  if (!barcodes.length) return map;
  const add = (bc, loc) => {
    if (!bc || loc == null) return;
    const l = String(loc).trim();
    if (!l || l === '-') return;
    if (!map.has(bc)) map.set(bc, new Set());
    map.get(bc).add(l);
  };
  const BATCH = 200;
  for (let i = 0; i < barcodes.length; i += BATCH) {
    const chunk = barcodes.slice(i, i + BATCH);
    const { data: st, error: e1 } = await sb.from('rk_stocks').select('barcode, location').in('barcode', chunk);
    if (e1) throw e1;
    for (const x of (st || [])) add(x.barcode, x.location);
  }
  const out = new Map();
  for (const [bc, set] of map) out.set(bc, [...set]);
  return out;
}

// 재고정리 조회 — 완료 원장(done) + 남은상품(pending, 계산: 원본 − 출고 − 재고원장)
router.get('/api/inbound/stock-arranges', async (req, res) => {
  try {
    // 남은 수량 계산에는 id·quantity 만 있으면 된다 → 전 코드를 가볍게 읽고(2열),
    // 남은 수량이 있는 아이템만 본문(상품명·바코드·출고코드)을 다시 읽는다. 결과는 전체를 읽던 때와 같다.
    const [light, shipping, arr] = await Promise.all([
      pageAll('rk_cn_shipment_items', 'id, quantity'),
      pageAll('rk_cn_shipping', 'shipment_item_id, ship_qty'),
      pageAll('rk_cn_stock_arranges',
        '*, rk_cn_shipments(shipment_code), rk_cn_shipment_items(box_name, order_number, product_name)'),
    ]);

    const shipByItem = new Map();
    for (const a of (shipping || [])) shipByItem.set(a.shipment_item_id, (shipByItem.get(a.shipment_item_id) || 0) + (a.ship_qty || 0));
    const arrByItem = new Map();
    for (const a of (arr || [])) arrByItem.set(a.shipment_item_id, (arrByItem.get(a.shipment_item_id) || 0) + (a.qty || 0));

    // 남은상품(대기) = 원본 − 출고 − 재고원장
    const remainingById = new Map();
    for (const it of light) {
      const remaining = (parseInt(it.quantity) || 0) - (shipByItem.get(it.id) || 0) - (arrByItem.get(it.id) || 0);
      if (remaining > 0) remainingById.set(it.id, remaining);
    }
    const items = (await S.chunked([...remainingById.keys()], 200, (part) =>
      pageAll('rk_cn_shipment_items', '*, rk_cn_shipments(shipment_code, status)', q => q.in('id', part))))
      .sort((a, b) => a.id - b.id);   // 이전과 같은 id 순

    const pending = [];
    const barcodes = new Set();
    for (const it of items) {
      const remaining = remainingById.get(it.id);
      if (remaining > 0) {
        pending.push({
          itemId: it.id,
          출고코드: it.rk_cn_shipments ? it.rk_cn_shipments.shipment_code : null,
          박스명: it.box_name, 중국번호: it.order_number, 상품명: it.product_name, 바코드: it.barcode, 남은: remaining,
        });
        if (it.barcode) barcodes.add(it.barcode);
      }
    }
    const candMap = await locationCandidatesByBarcode([...barcodes]);
    pending.forEach(p => p.위치후보 = candMap.get(p.바코드) || []);

    // 완료 원장(done)
    const done = (arr || []).map(a => ({
      id: a.id,
      출고코드: a.rk_cn_shipments ? a.rk_cn_shipments.shipment_code : null,
      박스명: a.rk_cn_shipment_items ? a.rk_cn_shipment_items.box_name : null,
      중국번호: a.rk_cn_shipment_items ? a.rk_cn_shipment_items.order_number : null,
      상품명: a.rk_cn_shipment_items ? a.rk_cn_shipment_items.product_name : null,
      바코드: a.barcode, 수량: a.qty, 위치: a.location,
    }));

    res.json({ pending, done });
  } catch (e) {
    console.error('[rk] inbound/stock-arranges:', e);
    res.status(500).json({ error: '재고정리 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

// 처리완료: 대기 배치를 재고 원장에 기록 + rk_stocks 합산.
// ⚠️ 임시: 재고조사 병행을 위해 '남은 수량 초과' 검증을 일시 해제(사용자 요청, 당분간).
//    초과 입력분도 그대로 원장 기록 + rk_stocks 합산됨. 재고조사 종료 후 초과 검증 복원 필요.
router.post('/api/inbound/stock-complete', async (req, res) => {
  try {
    const reqItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!reqItems.length) return res.status(400).json({ error: '처리할 항목이 없습니다.' });
    for (const it of reqItems) {
      if (!it.location || !String(it.location).trim()) return res.status(400).json({ error: '위치가 선택되지 않은 항목이 있습니다.' });
      if (!(parseInt(it.qty) > 0)) return res.status(400).json({ error: '수량이 올바르지 않은 항목이 있습니다.' });
    }

    // 아이템 존재 확인 — 요청된 id만 조회 (전체 로드 대신)
    const reqIds = [...new Set(reqItems.map(i => i.shipment_item_id))];
    const { data: items, error: eI } = await sb.from('rk_cn_shipment_items')
      .select('id, shipment_id, barcode').in('id', reqIds);
    if (eI) throw eI;
    const itemById = new Map((items || []).map(i => [i.id, i]));
    for (const it of reqItems) {
      if (!itemById.get(it.shipment_item_id)) return res.status(400).json({ error: '아이템을 찾을 수 없습니다.' });
    }

    // 1) 재고 원장 배치 insert + (바코드|위치)별 증분 합산
    const ledgerRows = [];
    const deltaByKey = new Map();   // `${barcode}|${location}` -> 합산 수량
    const nameByBarcode = new Map(); // 바코드 → 요청 상품명(재고정리 화면값, inventories 미조회 시 fallback)
    for (const it of reqItems) {
      const item = itemById.get(it.shipment_item_id);
      const barcode = String(it.barcode || item.barcode || '').trim();
      const location = String(it.location).trim();
      const qty = parseInt(it.qty);
      ledgerRows.push({ shipment_id: item.shipment_id, shipment_item_id: it.shipment_item_id, barcode, location, qty });
      const k = `${barcode}|${location}`;
      deltaByKey.set(k, (deltaByKey.get(k) || 0) + qty);
      const pn = String(it.productName || '').trim();
      if (pn && !nameByBarcode.has(barcode)) nameByBarcode.set(barcode, pn);
    }
    const BATCH = 500;
    for (let i = 0; i < ledgerRows.length; i += BATCH) {
      const { error } = await sb.from('rk_cn_stock_arranges').insert(ledgerRows.slice(i, i + BATCH));
      if (error) throw error;
    }

    // 2) 기존 재고를 한 번에 조회 → 조합별로만 update/insert
    const barcodes = [...new Set(ledgerRows.map(r => r.barcode))];
    const existing = [];
    for (let i = 0; i < barcodes.length; i += 200) {
      const { data, error } = await sb.from('rk_stocks').select('id, barcode, location, qty').in('barcode', barcodes.slice(i, i + 200));
      if (error) throw error;
      existing.push(...(data || []));
    }
    const stockByKey = new Map(existing.map(s => [`${s.barcode}|${String(s.location || '').trim()}`, s]));

    // 신규 행에 쓸 상품정보(sku/name)도 한 번에 조회
    const newKeys = [...deltaByKey.keys()].filter(k => !stockByKey.has(k));
    const invByBarcode = new Map();
    if (newKeys.length) {
      const newBcs = [...new Set(newKeys.map(k => k.split('|')[0]))];
      for (let i = 0; i < newBcs.length; i += 200) {
        const { data } = await sb.from('rk_inventories').select('barcode, sku_id, name').in('barcode', newBcs.slice(i, i + 200));
        for (const v of (data || [])) if (!invByBarcode.has(v.barcode)) invByBarcode.set(v.barcode, v);
      }
    }

    const insertStocks = [];
    for (const [k, add] of deltaByKey) {
      const cur = stockByKey.get(k);
      if (cur) {
        const { error } = await sb.from('rk_stocks').update({ qty: (parseInt(cur.qty) || 0) + add }).eq('id', cur.id);
        if (error) throw error;
      } else {
        const [barcode, location] = k.split('|');
        const inv = invByBarcode.get(barcode);
        // 상품마스터(rk_inventories)에 없으면 재고정리 화면의 상품명을 그대로 사용
        const itemName = (inv && inv.name) ? inv.name : (nameByBarcode.get(barcode) || null);
        insertStocks.push({ barcode, location, qty: add, sku_id: inv ? inv.sku_id : null, item_name: itemName });
      }
    }
    for (let i = 0; i < insertStocks.length; i += BATCH) {
      const { error } = await sb.from('rk_stocks').insert(insertStocks.slice(i, i + BATCH));
      if (error) throw error;
    }

    res.json({ message: `처리완료 (${reqItems.length}건)`, done: reqItems.length });
  } catch (e) {
    console.error('[rk] inbound/stock-complete:', e);
    res.status(500).json({ error: '처리완료 중 오류가 발생했습니다: ' + e.message });
  }
});

// 완료 취소(삭제): 원장 행 삭제 + rk_stocks 차감 (undo)
router.post('/api/inbound/stock-arrange-delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: '삭제할 항목이 없습니다.' });
    const { data: rows, error: eF } = await sb.from('rk_cn_stock_arranges').select('*').in('id', ids);
    if (eF) throw eF;
    for (const r of (rows || [])) {
      if (r.barcode && r.location) {
        const { data: ex } = await sb.from('rk_stocks').select('id, qty').eq('barcode', r.barcode).eq('location', r.location).limit(1);
        if (ex && ex.length) {
          const newQty = Math.max(0, (parseInt(ex[0].qty) || 0) - (r.qty || 0));
          await sb.from('rk_stocks').update({ qty: newQty }).eq('id', ex[0].id);
        }
      }
    }
    const { error } = await sb.from('rk_cn_stock_arranges').delete().in('id', ids);
    if (error) throw error;
    res.json({ message: `${ids.length}건 취소되었습니다.`, deleted: ids.length });
  } catch (e) {
    console.error('[rk] inbound/stock-arrange-delete:', e);
    res.status(500).json({ error: '취소 중 오류가 발생했습니다: ' + e.message });
  }
});

// 출고코드 단위 삭제 (헤더 삭제 → 아이템 cascade)
router.delete('/api/inbound/delete/:shipmentCode', async (req, res) => {
  try {
    const { error } = await sb.from('rk_cn_shipments').delete().eq('shipment_code', req.params.shipmentCode);
    if (error) throw error;
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error('[rk] inbound/delete:', e);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

// 바코드 업데이트: 입고 상품명 → 모델코드 추출 → rk_inventories 상품명 '포함' 검색 → 바코드 매칭
// body: { items:[{id, productName}] }  → { matched:[{id, barcode, code}], unmatched }
router.post('/api/inbound/match-barcodes', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.json({ matched: [], unmatched: 0 });

    // 상품마스터 전체 로드 (name, barcode)
    const inv = [];
    let from = 0; const size = 1000;
    while (true) {
      const { data, error } = await sb.from('rk_inventories').select('name, barcode').range(from, from + size - 1);
      if (error) throw error;
      inv.push(...(data || []));
      if (!data || data.length < size) break;
      from += size;
    }
    const invValid = inv.filter((x) => x.barcode);

    // 모델코드 인덱스: 상품마스터 상품명의 모델코드(대문자) → 후보들
    const idx = new Map();
    for (const x of invValid) {
      const c = extractModelCode(x.name);
      if (!c) continue;
      const k = c.toUpperCase();
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ name: String(x.name || ''), barcode: x.barcode });
    }

    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
    const pickBest = (cands, productName) => {
      const pn = String(productName || '').trim();
      const npn = norm(pn);
      let m = cands.find((c) => c.name.trim() === pn); if (m) return m.barcode;      // 정확 일치
      m = cands.find((c) => norm(c.name) === npn); if (m) return m.barcode;           // 공백무시 일치
      m = cands.find((c) => norm(c.name).includes(npn) || npn.includes(norm(c.name))); if (m) return m.barcode; // 포함
      return cands[0].barcode;                                                         // 그 외 첫 후보
    };

    const matched = [];
    let unmatched = 0;
    for (const it of items) {
      const code = extractModelCode(it.productName);
      if (!code) { unmatched++; continue; }
      const cu = code.toUpperCase();
      let cands = idx.get(cu);
      // 인덱스에 없으면 '포함' 검색 fallback (상품명 문자열에 코드가 들어있는 것)
      if (!cands || !cands.length) {
        cands = invValid.filter((x) => String(x.name || '').toUpperCase().includes(cu))
          .map((x) => ({ name: String(x.name || ''), barcode: x.barcode }));
      }
      if (!cands.length) { unmatched++; continue; }
      const barcode = pickBest(cands, it.productName);
      if (barcode) matched.push({ id: it.id, barcode, code }); else unmatched++;
    }
    res.json({ matched, unmatched });
  } catch (e) {
    console.error('[rk] inbound/match-barcodes:', e);
    res.status(500).json({ error: '바코드 매칭 중 오류가 발생했습니다: ' + e.message });
  }
});

// 입고 아이템 배치 저장 (바코드 업데이트 등). body: { items:[{id, barcode?, note?}] }
router.post('/api/inbound/batch-update-items', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.json({ updated: 0 });
    let updated = 0, skipped = 0;
    const CONC = 40;
    for (let i = 0; i < items.length; i += CONC) {
      const chunk = items.slice(i, i + CONC);
      const results = await Promise.all(chunk.map((it) => {
        const patch = {};
        if (it.barcode !== undefined) patch.barcode = it.barcode;
        if (it.note !== undefined) patch.note = it.note;
        if (!it.id || !Object.keys(patch).length) return Promise.resolve('skip');
        return sb.from('rk_cn_shipment_items').update(patch).eq('id', it.id)
          .then((r) => (r.error ? 'err' : 'ok')).catch(() => 'err');
      }));
      updated += results.filter((x) => x === 'ok').length;
      skipped += results.filter((x) => x === 'err').length;
    }
    res.json({ updated, skipped });
  } catch (e) {
    console.error('[rk] inbound/batch-update-items:', e);
    res.status(500).json({ error: '저장 중 오류가 발생했습니다: ' + e.message });
  }
});

module.exports = router;
