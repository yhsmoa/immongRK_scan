/**
 * CJ 운송장 접수 엑셀의 "발주번호" 열(E) — 만들기와 읽기를 한 곳에.
 *
 * 이 값은 CJ 결과 엑셀의 Z열("발주번호 - 박스")로 그대로 돌아오고, 그걸로
 *   · 송장번호 입력 모달이 박스별 운송장번호를 자동으로 채우고 (shipment.html readInvoiceFile)
 *   · [쉽먼트 등록] 이 운송장 저장분이 없는 지난 쉽먼트의 박스를 찾는다 (routes/rkShipDocs.js parseCjFiles)
 * 그래서 형식을 바꾸면 읽는 쪽도 같이 바꿔야 한다. 브라우저 쪽은 require 를 못 쓰므로 같은 정규식을 복사해 둔다.
 *
 * 2026-10-22 형식 (현장에서 박스만 보고도 어느 발주서의 몇 번째 박스인지 알게):
 *   [대2] 경기광주3 - 144300338 - 1번 (총 4박스) - 23개
 *   └크기┘ └물류센터┘  └발주번호┘ └박스┘ └발주서 박스 수┘ └그 박스 수량┘
 *   순서값은 넣지 않는다 — CJ 엑셀은 [순서지정] 보다 먼저 뽑으므로 그 시점엔 순서가 없다.
 * 이전 형식 "144300338 - 1" 도 그대로 읽힌다 (지난 쉽먼트의 결과 엑셀).
 */
function formatCjRef({ boxType, center, orderNo, boxNo, boxTotal, qty }) {
  return `[${boxType || ''}] ${center || ''} - ${orderNo} - ${boxNo}번 (총 ${boxTotal}박스) - ${qty}개`;
}

// 발주번호(8자리 이상 숫자) 바로 뒤의 " - 박스번호(번)" 만 본다 — 물류센터 이름 끝의 숫자("경기광주3")나 수량은 8자리가 안 돼 걸리지 않는다
const CJ_REF_RE = /(\d{8,})\s*-\s*(\d+)\s*번?/;

/** "…" → { orderNo, boxNo } · 형식이 아니면 null */
function parseCjRef(s) {
  const m = String(s == null ? '' : s).match(CJ_REF_RE);
  if (!m) return null;
  const boxNo = parseInt(m[2], 10);
  if (!Number.isFinite(boxNo)) return null;
  return { orderNo: m[1], boxNo };
}

module.exports = { formatCjRef, parseCjRef, CJ_REF_RE };
