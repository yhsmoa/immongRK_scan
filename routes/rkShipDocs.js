/**
 * 쉽먼트 서류 — 쿠팡 부착문서(Label)·동봉문서(Manifest) PDF 를 박스별로 보관([쉽먼트 등록])하고, 출고 순서대로 합쳐 내려준다([순서대로] 탭 출력).
 *
 * 쿠팡이 발송 완료 후 만들어 주는 두 PDF 는 박스 1개 = 1장인데 순서가 쿠팡 기준이라 발주서별로도 묶여 있지 않다.
 * 우리는 발주서 단위(발주번호-박스번호)로 박스를 싸고 [순서지정] 으로 출고 순서를 박스 단위로 스캔해 두므로, 그 순서대로 재배열한다.
 *
 * 2026-10-22 흐름 변경 — 발주서의 박스가 한 번에 다 나가지 않는다 (오늘 3박스, 이틀 뒤 2박스).
 *   예전 [순서정리] 는 올린 PDF 를 분석만 하고 버려서 나갈 때마다 다시 올려야 했고, 순서 없는 박스도 "(순서X)" 로 뒤에 붙어 나왔다.
 *   이제
 *     [쉽먼트 등록]  POST /api/shipment/docs/register  — 두 PDF 를 올리면 장을 박스별로 쪼개 Storage(rk-ship-docs)에 두고 rk_ship_docs 에 기록 (같은 박스는 덮어씀)
 *     [출력]         POST /api/shipment/docs/print     — rk_ship_seq 의 박스 순서대로 Storage 의 장을 합쳐 한 PDF. 순서 없는 박스는 아예 안 나간다.
 *   순서와 서류는 서로 독립이다: 순서를 지우거나 다시 찍어도 서류는 남고, 나중에 순서가 잡히면 그때 출력된다.
 *   예전 /doc-sort/plan 은 등록 모달의 미리보기(매칭 결과)로 그대로 쓴다. /doc-sort/build(올린 파일을 바로 정리해 내려받기)는 화면에서 뺐고 API 만 남겼다.
 *
 * 매칭 열쇠 (2026-10-15 사용자와 정리):
 *   1) 부착문서 ↔ 동봉문서 : 쉽먼트 바코드(PBL…). 두 문서 모두 장마다 찍혀 있고 박스마다 하나뿐이다.
 *   2) 부착문서 ↔ 우리 박스 : CJ 운송장번호. 우리가 CJ 에 "발주번호 - 박스번호" 로 접수해 받은 번호라 확정값이다.
 *        a. rk_ship_boxes.invoice_no ([송장번호 입력] 때 저장) → 없으면
 *        b. 같이 올린 CJ 운송장 엑셀 (H열 운송장번호 · Z열 "발주번호 - 박스번호") → 없으면
 *        c. 부착문서의 발주번호 + 상품수량 으로 추정 (같은 발주서에 수량이 같은 박스가 있으면 바뀔 수 있음 → ambiguous 표시)
 *   동봉문서에는 발주번호가 없다. PBL 로 부착문서와 짝지은 뒤 부착문서의 결과를 따른다.
 *
 * 순서: rk_ship_seq (발주서 순서 = 그 발주서 행들의 최소 seq, 박스 순서 = (발주번호, 박스번호) 행의 seq).
 *   순서 없는 발주서는 뒤에, 부착문서에 처음 나온 순서대로 발주서별로 묶고 박스번호 순. 박스를 못 찾은 장은 맨 뒤.
 *
 * API (multipart, 서버는 파일을 보관하지 않는다 — 다운로드 때 같은 파일을 다시 받는다)
 *   POST /api/shipment/doc-sort/plan   fields label[] · manifest[] · cj[]        → 매칭 결과(JSON)
 *   POST /api/shipment/doc-sort/build  같은 fields + kind=label|manifest         → 정리된 PDF
 *
 * 도장: 각 장 오른쪽 아래 "순서  📋 발주번호-박스번호  📦 N번 · 크기  실제|가상|일부가상" — 기본 크기의 3.5배(장 너비에 맞춰 줄임, 좁으면 두 줄).
 *   크기 = rk_ship_boxes.box_size(극소·소·중·대·대2) — 현장에서 어떤 상자인지 보이게 (2026-10-20 추가). 수량·종수는 넣지 않는다(사용자 결정).
 *   실제/가상 = 그 박스가 출고스캔으로 실제 찍은 박스인지 [가상스캔]으로 잡은 박스인지 (rk_ship_box_items.virtual_qty 합 기준).
 *   글꼴은 fonts/ (나눔고딕 · Noto Emoji, 둘 다 OFL).
 *   PDF 안에서 컬러 이모지는 안 되므로 흑백 윤곽(인쇄는 어차피 흑백).
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const S = require('./rkShared');
const { parseCjRef } = require('../cjRef');

const router = express.Router();

// ── Storage (supabase/rk_ship_docs.sql) — 박스별 PDF: {발주번호}/{박스번호}/label.pdf · manifest.pdf ──
const BUCKET = 'rk-ship-docs';
let bucketReady = null;
async function ensureBucket() {   // 버킷은 마이그레이션으로 만들지만, 없으면 첫 사용 때 한 번 만든다
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error } = await S.supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 52428800, allowedMimeTypes: ['application/pdf'] });
      if (error && !/already exists|duplicate/i.test(error.message || '')) { bucketReady = null; throw error; }
    })();
  }
  return bucketReady;
}
const docPath = (orderNo, boxNo, kind) => `${orderNo}/${boxNo}/${kind}.pdf`;
async function putDoc(path, bytes) {
  const { error } = await S.supabase.storage.from(BUCKET).upload(path, Buffer.from(bytes), { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(`Storage 저장 실패(${path}): ${error.message}`);
}
async function getDoc(path) {
  const { data, error } = await S.supabase.storage.from(BUCKET).download(path);
  if (error) throw new Error(`Storage 읽기 실패(${path}): ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}
/** 여러 작업을 동시에 최대 n 개씩 */
async function pool(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 40 } });
const FIELDS = [{ name: 'label', maxCount: 20 }, { name: 'manifest', maxCount: 20 }, { name: 'cj', maxCount: 10 }];

// 도장 글꼴 — 나눔고딕·Noto Emoji 를 도장에 쓰는 글자(숫자·괄호·"순서번못찾음박스발주가상실제일부혼합확정극소중대"·"·"·📋📦)만 남겨 pyftsubset 으로 미리 잘라 둔 파일.
//   pdf-lib 의 런타임 subset(embedFont subset:true)은 이 글꼴들에서 글리프가 깨져 뷰어에 "X"·숫자 일부만 보였다 (2026-10-15).
//   그래서 미리 자른 작은 글꼴을 subset 없이 통째로 넣는다. 도장 문구에 새 글자를 추가하면 fonts/ 의 subset 을 다시 만들어야 한다:
//   pip install fonttools  →  python -m fontTools.subset NanumGothic-Regular.ttf --output-file=StampKR.ttf --text="순서번못찾음박스발주가상실제일부혼합확정극소중대" --unicodes="U+0020-007E,U+00B7" --no-hinting   (2026-10-20: 박스 크기 글자·가운뎃점 추가)
//   pyftsubset NotoEmoji-Regular.ttf --output-file=StampEmoji.ttf --unicodes="U+1F4CB,U+1F4E6" --no-hinting
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONT_KR = path.join(FONT_DIR, 'StampKR.ttf');
const FONT_EMOJI = path.join(FONT_DIR, 'StampEmoji.ttf');

// ── PDF 텍스트 추출 (pdfjs-dist, ESM 이라 동적 import — 한 번만) ──
let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}
async function pageTexts(buffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  await doc.destroy();
  return out;
}

// ── 한 장의 텍스트 → 필드 ──
//   부착문서: "동탄1 박스 21-7 / 쉽먼트 바코드 PBL0110585751 / CJ 대한통운 600785078033 40 2026-10-12 / 발주 바코드 144199497"
//   동봉문서: 같은 머리말 + 쉽먼트번호 + 운송장번호, 발주번호는 없다.
function parsePage(text) {
  const t = text.replace(/ /g, ' ');
  const kind = /부착문서/.test(t) ? 'label' : /동봉문서/.test(t) ? 'manifest' : null;
  const pbl = (t.match(/\b(PBL\d{6,})\b/) || [])[1] || null;
  const head = t.match(/(\S+)\s+박스\s*(\d+)\s*-\s*(\d+)/);
  const center = head ? head[1] : null;
  const boxIdx = head ? parseInt(head[3], 10) : null;      // 쿠팡 기준 박스 순번 (우리 박스번호 아님)
  const boxTotal = head ? parseInt(head[2], 10) : null;
  const cj = t.match(/CJ\s*대한통운\s*\n?\s*(\d{10,14})/);
  const invoice = cj ? cj[1] : ((t.match(/\b(\d{12})\b/) || [])[1] || null);
  const order = (t.match(/발주\s*바코드\s*\n?\s*(\d{8,10})/) || [])[1] || null;
  // 상품수량: "운송장번호 수량 날짜" 줄 (부착문서) / "쉽먼트번호 날짜 총수량" 줄 (동봉문서)
  let qty = null;
  const q1 = t.match(/(\d{10,14})\s+(\d+)\s+(\d{4}-\d{2}-\d{2})/);
  const q2 = t.match(/(\d{6,10})\s+(\d{4}-\d{2}-\d{2})\s+(\d+)/);
  if (q1) qty = parseInt(q1[2], 10);
  else if (q2) qty = parseInt(q2[3], 10);
  const shipmentNo = (t.match(/쉽먼트번호[^\n]*\n\s*(\d{6,10})/) || [])[1] || null;
  // 동봉문서의 상품 바코드 목록 (수량 추정이 애매할 때 우리 박스 아이템 구성과 대조) — 상품명이 여러 줄로 감겨도 바코드만 모은다
  //   (종류와 무관하게 모은다 — 머리말 없는 이어지는 장은 parse 시점에 종류를 모르기 때문)
  const barcodes = [...new Set((t.match(/\bR\d{9,12}\b/g) || []))];
  return { kind, pbl, center, boxIdx, boxTotal, invoice, order, qty, shipmentNo, barcodes };
}

async function parseFiles(files, formKind) {
  const out = [];   // [{ fileIdx, name, kind, pages:[{ pageIdx, ...fields }] }]
  for (let i = 0; i < (files || []).length; i++) {
    const f = files[i];
    let texts;
    try { texts = await pageTexts(f.buffer); }
    catch (e) { out.push({ fileIdx: i, name: f.originalname, kind: null, error: 'PDF 를 읽지 못했습니다: ' + e.message, pages: [] }); continue; }
    const pages = texts.map((tx, pageIdx) => ({ fileIdx: i, pageIdx, ...parsePage(tx) }));
    // 동봉문서는 상품이 많으면 같은 박스가 여러 장으로 이어진다 (부착문서는 박스당 1장).
    //   머리말(PBL)이 반복되면 같은 PBL 이 연달아 나오고, 머리말이 없는 장은 바로 앞 장의 박스로 본다. 둘 다 cont=true.
    let prev = null;
    for (const p of pages) {
      if (prev && prev.kind === 'manifest') {
        if (!p.pbl) { p.pbl = prev.pbl; p.kind = 'manifest'; p.invoice = p.invoice || prev.invoice; p.cont = true; }
        else if (p.pbl === prev.pbl) p.cont = true;
      }
      prev = p;
    }
    const kinds = new Set(pages.map((p) => p.kind).filter(Boolean));
    const kind = kinds.size === 1 ? [...kinds][0] : null;
    out.push({ fileIdx: i, name: f.originalname, kind, formKind, pages,
      error: kind == null ? '부착문서/동봉문서 형식이 아닙니다.' : kind !== formKind ? `이 파일은 ${kind === 'label' ? '부착문서' : '동봉문서'}입니다 — 다른 칸에 올려주세요.` : null });
  }
  return out;
}

// ── CJ 운송장 엑셀 → 운송장번호 → { orderNo, boxNo } (송장번호 입력 모달과 같은 열: H=7 운송장, Z=25 발주번호 열) ──
//   Z열은 우리가 CJ 접수 엑셀에 넣은 값이 그대로 돌아온 것 — 새 형식 "[대2] 경기광주3 - 144300338 - 1번 (총 4박스) - 23개" 와
//   예전 "144300338 - 1" 둘 다 cjRef.js 의 parseCjRef 가 읽는다.
function parseCjFiles(files) {
  const map = new Map();
  let rows = 0;
  for (const f of files || []) {
    let wb;
    try { wb = XLSX.read(f.buffer, { type: 'buffer' }); } catch (_) { continue; }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    for (let i = 1; i < data.length; i++) {
      const r = data[i] || [];
      const inv = r[7], ob = r[25];
      if (!inv || !ob) continue;
      const ref = parseCjRef(ob);
      if (!ref) continue;
      map.set(String(inv).trim(), ref);
      rows++;
    }
  }
  return { map, rows };
}

// ── 우리 쪽 데이터: 발주서들의 박스(운송장번호 포함)·박스 수량·출고 순서 ──
async function loadOurBoxes(orderNos) {
  if (!orderNos.length) return { boxes: [], qtyByBox: new Map(), orderSeq: new Map(), boxSeq: new Map() };
  const [boxes, items, seqRows] = await Promise.all([
    S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_boxes')
      .select('id, order_number, box_no, box_size, invoice_no, is_virtual').in('order_number', nos).order('id', { ascending: true }))),
    S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_box_items')
      .select('box_id, barcode, qty, virtual_qty').in('order_number', nos).order('id', { ascending: true }))),
    S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_seq')
      .select('order_number, box_no, seq').in('order_number', nos).order('id', { ascending: true }))),
  ]);
  const qtyByBox = new Map();          // box_id → 수량 합
  const virtQtyByBox = new Map();      // box_id → 가상스캔 수량 합 (rk_ship_box_items.virtual_qty) — 도장의 실제/가상 표시용
  const barcodesByBox = new Map();     // box_id → Set(바코드)
  for (const it of items) {
    const q = parseInt(it.qty, 10) || 0;
    if (q <= 0) continue;
    qtyByBox.set(it.box_id, (qtyByBox.get(it.box_id) || 0) + q);
    virtQtyByBox.set(it.box_id, (virtQtyByBox.get(it.box_id) || 0) + Math.min(q, Math.max(0, parseInt(it.virtual_qty, 10) || 0)));
    if (!barcodesByBox.has(it.box_id)) barcodesByBox.set(it.box_id, new Set());
    if (it.barcode) barcodesByBox.get(it.box_id).add(String(it.barcode).trim());
  }
  const orderSeq = new Map(), boxSeq = new Map();
  for (const r of seqRows) {
    const cur = orderSeq.get(r.order_number);
    if (cur == null || r.seq < cur) orderSeq.set(r.order_number, r.seq);
    if (r.box_no != null) boxSeq.set(`${r.order_number}|${r.box_no}`, r.seq);
  }
  return { boxes, qtyByBox, virtQtyByBox, barcodesByBox, orderSeq, boxSeq };
}

// 박스의 스캔 종류 — 'virtual' 전부 가상스캔 · 'mixed' 실제 스캔 + 가상 섞임 · 'real' 전부 실제 스캔 (출고스캔 목록의 👾/🔀 배지와 같은 기준)
//   가상확정(모바일로 다 찾음)이 돼도 가상스캔으로 잡은 박스라는 사실은 그대로라 '가상' 으로 표시한다.
function boxVirtKind(b, ours) {
  const q = ours.qtyByBox.get(b.id) || 0, v = ours.virtQtyByBox.get(b.id) || 0;
  if (v <= 0) return b.is_virtual ? 'virtual' : 'real';
  return v >= q ? 'virtual' : 'mixed';
}

/** 두 바코드 집합이 같은지 */
function sameSet(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ── 매칭 + 정렬 ──
//   labelPages 의 각 장에 { box:{orderNo, boxNo, size}, method, seq } 를 붙이고 정렬 순서를 돌려준다.
function matchAndSort(labelPages, manifestPages, cjMap, ours) {
  const invoiceToBox = new Map();   // 운송장번호 → 박스 (DB 저장분)
  const boxesByOrder = new Map();
  for (const b of ours.boxes) {
    const k = String(b.order_number);
    if (!boxesByOrder.has(k)) boxesByOrder.set(k, []);
    boxesByOrder.get(k).push(b);
    for (const inv of String(b.invoice_no || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!invoiceToBox.has(inv)) invoiceToBox.set(inv, b);
    }
  }
  for (const list of boxesByOrder.values()) list.sort((a, b) => (a.box_no - b.box_no) || (a.id - b.id));

  const used = new Set();   // 이미 배정된 박스 id (수량 추정에서 중복 배정 방지)
  const firstSeen = new Map();   // 발주번호 → 부착문서에서 처음 나온 순번 (순서 없는 발주서 묶음용)
  labelPages.forEach((p, i) => { if (p.order && !firstSeen.has(p.order)) firstSeen.set(p.order, i); });
  // 동봉문서 (PBL → 장) — 수량 추정이 애매할 때 그 박스의 바코드 구성으로 가린다
  //   PBL → 장 목록 (파일 순서 그대로). 한 박스가 여러 장이면 그 순서대로 같이 움직인다.
  const manifestByPbl = new Map();
  for (const m of manifestPages) {
    if (!m.pbl) continue;
    if (!manifestByPbl.has(m.pbl)) manifestByPbl.set(m.pbl, []);
    manifestByPbl.get(m.pbl).push(m);
  }

  // 수량 추정은 확정 열쇠(운송장)가 있는 장을 먼저 배정한 뒤에 돌린다 — 운송장으로 잡힌 박스가 추정 후보에서 빠지도록
  const pending = [];
  for (const p of labelPages) {
    p.box = null; p.method = null; p.ambiguous = false;
    let b = p.invoice ? invoiceToBox.get(p.invoice) : null;
    if (b) { p.method = 'invoice'; }
    else if (p.invoice && cjMap.has(p.invoice)) {
      const m = cjMap.get(p.invoice);
      b = (boxesByOrder.get(m.orderNo) || []).find((x) => x.box_no === m.boxNo) || null;
      if (b) p.method = 'cj';
      else { p.box = { orderNo: m.orderNo, boxNo: m.boxNo, size: null, virt: null }; p.method = 'cj-only'; }   // 엑셀엔 있는데 DB 박스가 없음 — 번호는 믿고 쓴다
    }
    if (b) { used.add(b.id); p.box = { orderNo: String(b.order_number), boxNo: b.box_no, size: b.box_size || null, virt: boxVirtKind(b, ours) }; }
    else if (!p.box) pending.push(p);
  }
  // 운송장으로 못 찾은 장: 발주번호 + 수량 → 여러 후보면 동봉문서 바코드 구성으로 가린다 → 그래도 여럿이면 첫 후보(ambiguous 표시)
  for (const p of pending) {
    if (!(p.order && p.qty != null)) continue;
    let cands = (boxesByOrder.get(p.order) || []).filter((x) => !used.has(x.id) && (ours.qtyByBox.get(x.id) || 0) === p.qty);
    if (cands.length > 1) {
      const ms = p.pbl ? (manifestByPbl.get(p.pbl) || []) : [];
      const bcs = [...new Set(ms.flatMap((m) => m.barcodes || []))];   // 여러 장이면 전부 합쳐서 그 박스의 상품 구성
      if (bcs.length) {
        const set = new Set(bcs);
        const byItems = cands.filter((x) => sameSet(ours.barcodesByBox.get(x.id), set));
        if (byItems.length >= 1) cands = byItems;
      }
    }
    if (!cands.length) continue;
    const b = cands[0];
    used.add(b.id);
    p.method = 'qty'; p.ambiguous = cands.length > 1;
    p.box = { orderNo: String(b.order_number), boxNo: b.box_no, size: b.box_size || null, virt: boxVirtKind(b, ours) };
  }
  for (const p of labelPages) {
    if (p.box) {
      const bs = ours.boxSeq.get(`${p.box.orderNo}|${p.box.boxNo}`);
      const os = ours.orderSeq.get(p.box.orderNo);
      p.seq = bs != null ? bs : (os != null ? os : null);
      p.orderSeq = os != null ? os : null;
    } else { p.seq = null; p.orderSeq = null; }
    // 발주번호 대조 — 운송장으로 찾은 박스의 발주번호와 부착문서에 찍힌 발주번호가 다르면 표시
    p.orderMismatch = !!(p.box && p.order && p.box.orderNo !== p.order);
  }

  const INF = Number.POSITIVE_INFINITY;
  const sorted = labelPages.slice().sort((a, b) => {
    const ak = a.box ? 0 : 1, bk = b.box ? 0 : 1;                 // 박스 못 찾은 장은 맨 뒤
    if (ak !== bk) return ak - bk;
    if (!a.box) return a.fileIdx - b.fileIdx || a.pageIdx - b.pageIdx;
    const ao = a.orderSeq == null ? INF : a.orderSeq, bo = b.orderSeq == null ? INF : b.orderSeq;
    if (ao !== bo) return ao - bo;                                   // 발주서 순서
    if (ao === INF) {                                                // 둘 다 순서 없음 → 부착문서 첫 등장 순으로 발주서 묶음
      const af = firstSeen.get(a.box.orderNo) ?? INF, bf = firstSeen.get(b.box.orderNo) ?? INF;
      if (af !== bf) return af - bf;
      if (a.box.orderNo !== b.box.orderNo) return a.box.orderNo < b.box.orderNo ? -1 : 1;
      return a.box.boxNo - b.box.boxNo;
    }
    if (a.box.orderNo !== b.box.orderNo) return a.box.orderNo < b.box.orderNo ? -1 : 1;
    const as = a.seq == null ? INF : a.seq, bs = b.seq == null ? INF : b.seq;   // 같은 발주서: 박스 순서 → 박스번호
    if (as !== bs) return as - bs;
    return a.box.boxNo - b.box.boxNo;
  });

  // 동봉문서는 PBL 로 부착문서 순서를 따른다
  const labelPbls = new Set(labelPages.map((p) => p.pbl).filter(Boolean));
  const unpairedLabel = labelPages.filter((p) => !p.pbl || !manifestByPbl.has(p.pbl));
  const seenU = new Set();   // 같은 박스의 여러 장은 한 번만 보고한다
  const unpairedManifest = manifestPages.filter((m) => {
    if (m.pbl && labelPbls.has(m.pbl)) return false;
    if (m.pbl) { if (seenU.has(m.pbl)) return false; seenU.add(m.pbl); }
    return true;
  });
  const dupLabel = labelPages.filter((p, i) => p.pbl && labelPages.findIndex((x) => x.pbl === p.pbl) !== i);

  // 표시용 순번 (정렬된 자리, 1부터) — 도장의 첫 숫자. 순서 없음/못 찾음은 '-' / '?'
  sorted.forEach((p, i) => { p.pos = i + 1; });
  return { sorted, manifestByPbl, unpairedLabel, unpairedManifest, dupLabel };
}

// 도장 문구 — 순서가 있으면 정렬 순번, 순서저장이 안 된 발주서는 "(순서X)", 우리 박스를 못 찾은 장은 "(못찾음)"
//   순서를 못 저장했어도 작업은 멈출 수 없으니 출력은 막지 않고 표시만 다르게 한다 (2026-10-15 사용자 요청)
//   virt: 박스가 실제 스캔인지 가상스캔인지 — '실제' · '가상' · '일부가상' (DB 박스를 못 찾은 장은 빈 문자열) (2026-10-15 추가)
const VIRT_LABEL = { real: '실제', virtual: '가상', mixed: '일부가상' };
function stampTextOf(p) {
//   size: 박스 크기(rk_ship_boxes.box_size, 극소·소·중·대·대2) — 없으면 빈 문자열 (2026-10-20 추가)
  if (!p.box) return { pos: '(못찾음)', mid: `${p.order || '?'}-?`, box: '?', size: '', virt: '' };
  return { pos: p.orderSeq == null ? '(순서X)' : String(p.pos), mid: `${p.box.orderNo}-${p.box.boxNo}`, box: `${p.box.boxNo}번`, size: String(p.box.size || '').trim(), virt: VIRT_LABEL[p.box.virt] || '' };
}

// 도장 그리기 — 오른쪽 아래. 기본 크기(순번 15 · 본문 10)의 STAMP_SCALE 배로 찍되, 장 너비에 안 들어가면 들어가는 만큼만 키운다.
//   "12  📋 144199497-4  📦 4번 · 대2  가상" — 순번은 크게, "(순서X)"/"(못찾음)" 은 본문 크기. 밑에 뭐가 있어도 읽히게 흰 바탕.
//   한 줄로는 STAMP_TWO_LINE_BELOW 배도 안 되는 좁은 장(라벨 크기)은 두 줄("순번 📋 발주-박스" / "📦 N번 · 크기 가상")로 쌓아 더 키운다.
//   2026-10-15: 글자를 3.5배로 키우고(현장에서 멀리서도 보이게) 실제/가상 표시를 붙였다.
const STAMP_SCALE = 3.5;
const STAMP_TWO_LINE_BELOW = 2.5;
function drawStamp(page, st, sub, kr, em) {
  const { width } = page.getSize();
  const posSize = /^\d+$/.test(st.pos) ? 15 : 10;
  const line1 = [[st.pos + '  ', kr, posSize], ['📋', em, 10], [' ' + st.mid, kr, 10]];
  const line2 = [['📦', em, 10], [' ' + st.box + (sub || '') + (st.size ? ' · ' + st.size : ''), kr, 10]];
  if (st.virt) line2.push(['  ' + st.virt, kr, 10]);
  const widthOf = (segs, sc) => segs.reduce((n, [t, f, s]) => n + f.widthOfTextAtSize(t, s * sc), 0);
  const fit = (w1) => Math.max(1, Math.min(STAMP_SCALE, (width - 28) / w1));   // 좌우 여백 14pt 씩은 남긴다
  const one = [...line1, [['  ', kr, 10]][0], ...line2];
  let lines = [one], scale = fit(widthOf(one, 1));
  if (scale < STAMP_TWO_LINE_BELOW) {
    const two = fit(Math.max(widthOf(line1, 1), widthOf(line2, 1)));
    if (two > scale) { lines = [line1, line2]; scale = two; }
  }
  const lineH = 19 * scale, h = lineH * lines.length, y0 = 10 * scale;
  const w = Math.max(...lines.map((l) => widthOf(l, scale)));
  page.drawRectangle({ x: width - 14 - w - 4 * scale, y: y0 - 3 * scale, width: w + 8 * scale, height: h, color: rgb(1, 1, 1) });
  lines.forEach((segs, i) => {   // 첫 줄이 위, 오른쪽 정렬
    const lw = widthOf(segs, scale), y = y0 + lineH * (lines.length - 1 - i);
    let x = width - 14 - lw;
    for (const [t, f, s] of segs) { page.drawText(t, { x, y, size: s * scale, font: f, color: rgb(0, 0, 0) }); x += f.widthOfTextAtSize(t, s * scale); }
  });
  return { scale, lines: lines.length, width: w, height: h };
}

// ── 공통: 업로드 → 파싱 → 매칭 ──
async function buildPlan(req) {
  const files = req.files || {};
  const [labelFiles, manifestFiles] = await Promise.all([parseFiles(files.label, 'label'), parseFiles(files.manifest, 'manifest')]);
  const cj = parseCjFiles(files.cj);
  // 칸을 바꿔 올려도 내용으로 종류를 정한다 (오류 표시는 남긴다)
  const allFiles = [...labelFiles, ...manifestFiles];
  const labelPages = allFiles.filter((f) => f.kind === 'label').flatMap((f) => f.pages.map((p) => ({ ...p, fileKey: `${f.formKind}:${f.fileIdx}` })));
  const manifestPages = allFiles.filter((f) => f.kind === 'manifest').flatMap((f) => f.pages.map((p) => ({ ...p, fileKey: `${f.formKind}:${f.fileIdx}` })));

  const orderNos = [...new Set(labelPages.map((p) => p.order).filter(Boolean))];
  for (const v of cj.map.values()) if (!orderNos.includes(v.orderNo)) orderNos.push(v.orderNo);
  const ours = await loadOurBoxes(orderNos);
  const m = matchAndSort(labelPages, manifestPages, cj.map, ours);
  return { labelFiles, manifestFiles, cj, labelPages, manifestPages, ours, ...m };
}

function planSummary(plan) {
  const { labelFiles, manifestFiles, cj, labelPages, manifestPages, sorted, unpairedLabel, unpairedManifest, dupLabel } = plan;
  const fileInfo = (f) => ({ name: f.name, kind: f.kind, pages: f.pages.length, error: f.error || null });
  const pageInfo = (p) => ({ pbl: p.pbl, center: p.center, boxIdx: p.boxIdx, boxTotal: p.boxTotal, invoice: p.invoice, order: p.order || (p.box && p.box.orderNo) || null, qty: p.qty });
  const notFound = sorted.filter((p) => !p.box);
  // 순서 없는 발주서 — 발주번호별 장수 (모달 경고 "순서X 출력: 발주번호 (N장)")
  const noSeqCount = new Map();
  for (const p of sorted) if (p.box && p.orderSeq == null) noSeqCount.set(p.box.orderNo, (noSeqCount.get(p.box.orderNo) || 0) + 1);
  const noSeqOrders = [...noSeqCount.keys()];
  const noSeqPages = [...noSeqCount.values()].reduce((a, b) => a + b, 0);
  const ambiguous = sorted.filter((p) => p.ambiguous);
  const mismatch = sorted.filter((p) => p.orderMismatch);
  const fileErrors = [...labelFiles, ...manifestFiles].filter((f) => f.error);
  const hasLabel = labelPages.length > 0, hasManifest = manifestPages.length > 0;
  const ok = hasLabel && hasManifest && !unpairedLabel.length && !unpairedManifest.length && !dupLabel.length && !fileErrors.length;
  return {
    ok, hasLabel, hasManifest,
    label: { files: labelFiles.map(fileInfo), pages: labelPages.length },
    manifest: { files: manifestFiles.map(fileInfo), pages: manifestPages.length, boxes: plan.manifestByPbl.size },   // 장수 ≠ 박스 수 (한 박스가 여러 장일 수 있음)
    cj: { files: (plan.cjFilesCount != null ? plan.cjFilesCount : 0), rows: cj.rows },
    pairs: labelPages.length - unpairedLabel.length,
    unpairedLabel: unpairedLabel.map(pageInfo),
    unpairedManifest: unpairedManifest.map(pageInfo),
    dupLabel: dupLabel.map(pageInfo),
    notFound: notFound.map(pageInfo),
    ambiguous: ambiguous.map((p) => ({ ...pageInfo(p), box: p.box })),
    mismatch: mismatch.map((p) => ({ ...pageInfo(p), box: p.box })),
    noSeqOrders,
    noSeq: noSeqOrders.map((o) => ({ order: o, pages: noSeqCount.get(o) })),
    noSeqPages,
    matched: sorted.filter((p) => p.box).length,
    withSeq: sorted.filter((p) => p.box && p.orderSeq != null).length,
    methods: { invoice: sorted.filter((p) => p.method === 'invoice').length, cj: sorted.filter((p) => p.method === 'cj' || p.method === 'cj-only').length, qty: sorted.filter((p) => p.method === 'qty').length },
    sequence: sorted.map((p) => ({ pos: p.pos, pbl: p.pbl, order: p.box ? p.box.orderNo : p.order, boxNo: p.box ? p.box.boxNo : null, size: p.box ? p.box.size : null,
      seq: p.seq, orderSeq: p.orderSeq, method: p.method, stamp: stampTextOf(p),
      manifestPages: p.pbl ? (plan.manifestByPbl.get(p.pbl) || []).length : 0 })),
    fileErrors: fileErrors.map((f) => ({ name: f.name, error: f.error })),
  };
}

router.post('/api/shipment/doc-sort/plan', upload.fields(FIELDS), async (req, res) => {
  try {
    const plan = await buildPlan(req);
    plan.cjFilesCount = ((req.files || {}).cj || []).length;
    res.json(planSummary(plan));
  } catch (e) {
    console.error('[rk] doc-sort/plan:', e);
    res.status(500).json({ error: '문서를 분석하지 못했습니다: ' + e.message });
  }
});

// ── 정리된 PDF 만들기 ──
let fontCache = null;
function fontBytes() {
  if (!fontCache) fontCache = { kr: fs.readFileSync(FONT_KR), emoji: fs.readFileSync(FONT_EMOJI) };
  return fontCache;
}
async function buildPdf(kind, plan, req) {
  const { sorted, manifestByPbl } = plan;
  const files = req.files || {};
  // 원본 문서 열기 (fileKey → PDFDocument)
  const srcDocs = new Map();
  const openSrc = async (fileKey) => {
    if (srcDocs.has(fileKey)) return srcDocs.get(fileKey);
    const [formKind, idx] = fileKey.split(':');
    const f = (files[formKind] || [])[Number(idx)];
    const doc = await PDFDocument.load(f.buffer);
    srcDocs.set(fileKey, doc);
    return doc;
  };
  // 출력 순서의 장 목록
  //   label    : 부착문서만, sorted 순서
  //   manifest : 동봉문서만 — 박스마다 PBL 로 대응되는 장(여러 장이면 그 순서대로)
  //   all      : 박스마다 [부착문서 1장 → 그 박스의 동봉문서 장들] 한 파일 — 화면 버튼은 뺐다(프린터가 달라 따로 뽑음). API 만 남겨 둠.
  //   동봉문서가 여러 장인 박스는 도장 끝에 " 1/3" 처럼 몇 장째인지 붙인다.
  const seq = [];
  for (const p of sorted) {
    const ms = p.pbl ? (manifestByPbl.get(p.pbl) || []) : [];
    if (kind === 'label' || kind === 'all') seq.push({ page: p, src: p, sub: '' });
    if (kind === 'manifest' || kind === 'all') ms.forEach((m, i) => seq.push({ page: p, src: m, sub: ms.length > 1 ? ` ${i + 1}/${ms.length}` : '' }));
  }
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const fb = fontBytes();
  const kr = await out.embedFont(fb.kr, { subset: false });     // 이미 잘라 둔 글꼴 — 런타임 subset 은 글리프가 깨진다
  const em = await out.embedFont(fb.emoji, { subset: false });

  for (const { page, src, sub } of seq) {
    const doc = await openSrc(src.fileKey);
    const [copied] = await out.copyPages(doc, [src.pageIdx]);
    out.addPage(copied);
    drawStamp(copied, stampTextOf(page), sub, kr, em);
  }
  return { bytes: await out.save(), pages: seq.length };
}

// ══════════════════════════════════════════════════════════════════
// [쉽먼트 등록] — 올린 PDF 를 박스별로 쪼개 Storage 에 보관
//   fields: label[] · manifest[] · cj[] (plan 과 같다)
//   부착문서 장마다 우리 박스를 찾아(plan 의 매칭) 그 장 1장을 label.pdf 로, PBL 이 같은 동봉문서 장들을 manifest.pdf 로 저장한다.
//   박스를 못 찾은 장·동봉문서만 있는 장은 저장하지 않고 돌려보낸다 (파일을 더 올려 다시 등록하면 된다 — 같은 박스는 덮어쓴다).
//   순서(rk_ship_seq)는 보지 않는다 — 등록은 순서와 무관하고, 출력 때 순서 있는 박스만 고른다.
//   응답: { registered:{label, manifest}, boxes:[{order, boxNo, label, manifest}], skipped:[장], dupLabel:[장], unpairedManifest:[장] }
// ══════════════════════════════════════════════════════════════════
router.post('/api/shipment/docs/register', upload.fields(FIELDS), async (req, res) => {
  try {
    const plan = await buildPlan(req);
    if (!plan.labelPages.length) return res.status(400).json({ error: '부착문서가 없습니다. 부착문서 PDF 를 올려주세요.' });
    const fileErrors = [...plan.labelFiles, ...plan.manifestFiles].filter((f) => f.error);
    if (fileErrors.length) return res.status(400).json({ error: '읽지 못한 파일이 있습니다: ' + fileErrors.map((f) => `${f.name} (${f.error})`).join(', ') });
    await ensureBucket();

    // 원본 문서는 미리 다 연다 (fileKey → PDFDocument) — 아래 pool 에서 같은 파일을 동시에 두 번 열지 않게
    const files = req.files || {};
    const srcDocs = new Map();
    for (const formKind of ['label', 'manifest']) {
      for (let i = 0; i < (files[formKind] || []).length; i++) srcDocs.set(`${formKind}:${i}`, await PDFDocument.load(files[formKind][i].buffer));
    }
    // 장들을 새 PDF 하나로 (원본 그대로, 도장은 출력 때 찍는다)
    const extract = async (pages) => {
      const out = await PDFDocument.create();
      for (const p of pages) {
        const [copied] = await out.copyPages(srcDocs.get(p.fileKey), [p.pageIdx]);
        out.addPage(copied);
      }
      return out.save();
    };

    // 박스별 작업 목록 — 같은 박스가 두 장이면(dupLabel) 먼저 온 장만 쓴다
    const jobs = [];
    const seenBox = new Set();
    const skipped = [];
    for (const p of plan.labelPages) {
      if (!p.box) { skipped.push(p); continue; }
      const key = `${p.box.orderNo}|${p.box.boxNo}`;
      if (seenBox.has(key)) continue;
      seenBox.add(key);
      jobs.push({ orderNo: String(p.box.orderNo), boxNo: p.box.boxNo, label: p, manifest: p.pbl ? (plan.manifestByPbl.get(p.pbl) || []) : [] });
    }
    if (!jobs.length) return res.status(400).json({ error: '우리 박스를 찾은 장이 하나도 없습니다. 운송장번호가 저장되지 않은 지난 쉽먼트면 CJ 운송장 엑셀을 같이 올려주세요.' });

    const now = new Date().toISOString();
    const rows = [];
    const results = await pool(jobs, 4, async (j) => {
      const labelPath = docPath(j.orderNo, j.boxNo, 'label');
      await putDoc(labelPath, await extract([j.label]));
      rows.push({ order_number: j.orderNo, box_no: j.boxNo, kind: 'label', path: labelPath, pages: 1, pbl: j.label.pbl || null, invoice_no: j.label.invoice || null, uploaded_at: now });
      let manifest = false;
      if (j.manifest.length) {
        const mPath = docPath(j.orderNo, j.boxNo, 'manifest');
        await putDoc(mPath, await extract(j.manifest));
        rows.push({ order_number: j.orderNo, box_no: j.boxNo, kind: 'manifest', path: mPath, pages: j.manifest.length, pbl: j.label.pbl || null, invoice_no: j.manifest[0].invoice || j.label.invoice || null, uploaded_at: now });
        manifest = true;
      }
      return { order: j.orderNo, boxNo: j.boxNo, label: true, manifest };
    });
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await S.supabase.from('rk_ship_docs').upsert(rows.slice(i, i + 200), { onConflict: 'order_number,box_no,kind' });
      if (error) throw error;
    }

    const pageInfo = (p) => ({ pbl: p.pbl, order: p.order || null, invoice: p.invoice || null, qty: p.qty });
    res.json({
      registered: { label: results.length, manifest: results.filter((r) => r.manifest).length },
      boxes: results.sort((a, b) => String(a.order).localeCompare(String(b.order)) || a.boxNo - b.boxNo),
      skipped: skipped.map(pageInfo),
      dupLabel: plan.dupLabel.map(pageInfo),
      unpairedManifest: plan.unpairedManifest.map(pageInfo),
      labelOnly: results.filter((r) => !r.manifest).map((r) => `${r.order}-${r.boxNo}`),   // 동봉문서가 안 올라온 박스
    });
  } catch (e) {
    console.error('[rk] docs/register:', e);
    res.status(500).json({ error: '서류 등록 실패: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// [순서대로] 탭 출력 — 순서 지정된 박스의 서류를 Storage 에서 꺼내 순서대로 한 PDF 로
//   body: { kind:'label'|'manifest', boxes?:[{ orderNumber, boxNo }] }
//     boxes 가 있으면(탭에서 체크한 박스) 그 박스만, 없으면 순서 있는 박스 전부. 어느 쪽이든 rk_ship_seq 에 있는 박스만 — 순서 없는 박스는 나가지 않는다.
//   도장: 순번 = 그 박스의 seq(스캔한 순서 그대로) · 발주번호-박스 · N번 · 크기 · 실제/가상. 동봉문서가 여러 장이면 " 1/3" 을 붙인다.
//   서류가 없는 박스는 건너뛰고 X-Print-Summary 헤더(JSON, encodeURIComponent)로 알린다. 하나도 없으면 400.
// ══════════════════════════════════════════════════════════════════
router.post('/api/shipment/docs/print', express.json(), async (req, res) => {
  try {
    const kind = req.body.kind === 'manifest' ? 'manifest' : 'label';
    const want = Array.isArray(req.body.boxes) && req.body.boxes.length
      ? new Set(req.body.boxes.map((b) => `${String(b.orderNumber || '').trim()}|${parseInt(b.boxNo, 10)}`))
      : null;
    const seqRows = (await S.pageAll(() => S.supabase.from('rk_ship_seq')
      .select('order_number, box_no, seq').not('box_no', 'is', null).order('seq', { ascending: true })))
      .filter((r) => !want || want.has(`${r.order_number}|${r.box_no}`));
    if (!seqRows.length) return res.status(400).json({ error: want ? '체크한 박스 중 순서가 지정된 박스가 없습니다.' : '순서가 지정된 박스가 없습니다. [순서지정] 으로 출고 순서를 먼저 스캔하세요.' });

    const orderNos = [...new Set(seqRows.map((r) => r.order_number))];
    const [docs, ours] = await Promise.all([
      S.chunked(orderNos, 200, (nos) => S.pageAll(() => S.supabase.from('rk_ship_docs')
        .select('order_number, box_no, kind, path, pages').in('order_number', nos).eq('kind', kind).order('id', { ascending: true }))),
      loadOurBoxes(orderNos),
    ]);
    const docByKey = new Map(docs.map((d) => [`${d.order_number}|${d.box_no}`, d]));
    const boxByKey = new Map(ours.boxes.map((b) => [`${b.order_number}|${b.box_no}`, b]));

    const missing = [];
    const seq = [];   // 출력 순서의 박스
    for (const r of seqRows) {
      const d = docByKey.get(`${r.order_number}|${r.box_no}`);
      if (!d) { missing.push(`${r.order_number}-${r.box_no}`); continue; }
      seq.push({ r, d });
    }
    if (!seq.length) return res.status(400).json({ error: `순서 지정된 박스 ${seqRows.length}개 모두 ${kind === 'label' ? '부착' : '동봉'}문서가 등록되지 않았습니다. [쉽먼트 등록] 으로 먼저 올려주세요.`, missing });

    const bufs = await pool(seq, 4, ({ d }) => getDoc(d.path));
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const fb = fontBytes();
    const kr = await out.embedFont(fb.kr, { subset: false });
    const em = await out.embedFont(fb.emoji, { subset: false });
    let pages = 0;
    for (let i = 0; i < seq.length; i++) {
      const { r } = seq[i];
      const b = boxByKey.get(`${r.order_number}|${r.box_no}`);
      const pseudo = { box: { orderNo: String(r.order_number), boxNo: r.box_no, size: b ? b.box_size : null, virt: b ? boxVirtKind(b, ours) : null }, orderSeq: r.seq, pos: r.seq };
      const st = stampTextOf(pseudo);
      const src = await PDFDocument.load(bufs[i]);
      const idx = src.getPageIndices();
      const copied = await out.copyPages(src, idx);
      copied.forEach((pg, k) => { out.addPage(pg); drawStamp(pg, st, idx.length > 1 ? ` ${k + 1}/${idx.length}` : '', kr, em); pages++; });
    }
    const bytes = await out.save();
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const name = `${kind === 'label' ? '부착문서' : '동봉문서'}_출력_${ymd}_${seq.length}박스_${pages}장.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(name)}`);
    res.setHeader('X-Print-Summary', encodeURIComponent(JSON.stringify({ boxes: seq.length, pages, missing })));
    res.send(Buffer.from(bytes));
  } catch (e) {
    console.error('[rk] docs/print:', e);
    res.status(500).json({ error: '출력 PDF 를 만들지 못했습니다: ' + e.message });
  }
});

router.post('/api/shipment/doc-sort/build', upload.fields(FIELDS), async (req, res) => {
  try {
    const kind = ['label', 'manifest', 'all'].includes(req.body.kind) ? req.body.kind : 'label';
    const plan = await buildPlan(req);
    if (!plan.labelPages.length) return res.status(400).json({ error: '부착문서가 없습니다.' });
    if (kind !== 'label' && !plan.manifestPages.length) return res.status(400).json({ error: '동봉문서가 없습니다.' });
    const { bytes, pages } = await buildPdf(kind, plan, req);
    if (!pages) return res.status(400).json({ error: '정리할 장이 없습니다.' });
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const name = `${{ label: '부착문서', manifest: '동봉문서', all: '전체문서' }[kind]}_순서정리_${ymd}_${pages}장.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(name)}`);
    res.send(Buffer.from(bytes));
  } catch (e) {
    console.error('[rk] doc-sort/build:', e);
    res.status(500).json({ error: 'PDF 를 만들지 못했습니다: ' + e.message });
  }
});

module.exports = router;
module.exports.drawStamp = drawStamp;   // 도장 렌더 확인 스크립트용
module.exports.fontBytes = fontBytes;
