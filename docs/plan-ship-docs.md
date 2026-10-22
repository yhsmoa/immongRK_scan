# 쉽먼트 서류 보관·박스 단위 출고 순서 — [쉽먼트 등록] · [순서지정] · [순서대로] 출력

> 작성: 2026-10-22 · 대상: `/shipment` (shipment.html), `routes/rkShipDocs.js`, `routes/rkOrdersExtra.js`, `cjRef.js`, `supabase/rk_ship_docs.sql`
> 전제: docs/plan-ship-scan.md (rk_ship_boxes / rk_ship_box_items), 2026-10-15 의 [순서정리](rkShipDocs.js 머리말의 매칭 열쇠)

---

## 0. 왜 바꿨나

발주서 하나의 박스가 **한 번에 다 나가지 않는다.** 발주서 A 가 5박스인데 오늘 3박스, 이틀 뒤 2박스가 나가는 식이다.

그동안의 [순서정리] 는

- PDF 를 올릴 때마다 **분석만 하고 파일을 버려서**, 나갈 때마다 쿠팡 PDF 를 다시 찾아 올려야 했고
- 순서가 없는 박스도 **"(순서X)" 로 뒤에 붙어 출력**됐다 — 이번에 안 나가는 박스라 뽑아도 쓸 데가 없다
- 순서가 **발주서 단위**라 "이 발주서의 3박스만 오늘" 을 표현할 수 없었다

## 1. 바뀐 흐름 (버튼 순서 그대로)

```
박스라벨출력 → CJ 엑셀 → 순서지정 → 쉽먼트 저장 → 쉽먼트 등록 → [순서대로] 탭에서 출력
```

| 단계 | 하는 일 | 저장되는 것 |
|---|---|---|
| 박스라벨출력 | 박스마다 "발주번호-박스번호" 라벨 | — |
| CJ 엑셀 | CJ 접수용. 박스 한 행, **발주번호 열 = `[대2] 경기광주3 - 144300338 - 1번 (총 4박스) - 36개`** | rk_export_logs(CJ) |
| 순서지정 | 박스 라벨을 **출고할 순서대로** 스캔 (박스 단위만, 발주번호만 찍으면 오류) | rk_ship_seq — **저장 = 전체 교체** |
| 쉽먼트 저장 | CJ 결과 엑셀로 운송장번호 채워 쿠팡 쉽먼트 파일 | rk_ship_boxes.invoice_no |
| 쉽먼트 등록 | 쿠팡 부착문서·동봉문서 PDF → **박스별로 쪼개 Storage 보관** | storage `rk-ship-docs` + rk_ship_docs |
| 순서대로 탭 | 박스 하나 = 한 행, 순서 있는 박스만. [초기화] [동봉문서 출력] [부착문서 출력] | — |

### 순서와 서류는 서로 독립이다

- 순서지정 저장은 **전체 교체** — 이미 나간 박스가 오늘 목록에 남지 않게. 등록된 서류는 건드리지 않는다.
- 서류는 등록해 두면 **순서가 잡힐 때까지 남는다.** 이틀 뒤 남은 2박스를 순서지정에서 찍으면, 그때 Storage 의 장을 꺼내 출력한다.
- 출력은 **rk_ship_seq 에 있는 박스만.** 순서 없는 박스는 "(순서X)" 로도 나가지 않는다. 순서는 있는데 서류가 없는 박스는 건너뛰고 `X-Print-Summary` 로 알린다.

## 2. 데이터

```sql
rk_ship_docs (id, order_number, box_no, kind 'label'|'manifest', path, pages, pbl, invoice_no, uploaded_at)
  unique (order_number, box_no, kind)            -- 다시 등록하면 덮어씀 (upsert + storage upsert)
storage bucket rk-ship-docs (비공개, PDF, 50MB)
  {발주번호}/{박스번호}/label.pdf                 -- 부착문서 1장
  {발주번호}/{박스번호}/manifest.pdf              -- 동봉문서 1장 이상 (머리말 없는 이어지는 장 포함)
rk_ship_seq (order_number, box_no NOT NULL 로 쓴다, seq)
```

`/api/shipment/orders` 의 상품행에 `박스순서`(seq)·`서류부착`·`서류동봉` 이 실린다 → 배지 `2 극소 ✅📃`, [순서대로] 행의 서류 열.

## 3. API (routes/rkShipDocs.js · rkOrdersExtra.js)

| | 설명 |
|---|---|
| `POST /api/shipment/doc-sort/plan` | (기존) 올린 PDF 매칭 결과 — 등록 모달의 미리보기 |
| `POST /api/shipment/docs/register` | 부착문서 장마다 박스를 찾아 label.pdf, PBL 이 같은 동봉문서 장들을 manifest.pdf 로 저장. 못 찾은 장은 `skipped`, 동봉 없는 박스는 `labelOnly` |
| `POST /api/shipment/docs/print` | `{ kind, boxes?:[{orderNumber, boxNo}] }` — 체크한 박스(없으면 전부) 중 **순서 있는 것만** seq 순으로 합쳐 PDF. 도장 순번 = seq |
| `POST /api/shipment/sequence` | 박스 단위 코드만. rk_orders(미완료)·rk_ship_boxes 에 있는 박스만 저장. 전체 교체 |
| `DELETE /api/shipment/sequence` | [초기화] — rk_ship_seq 비움 |
| `POST /api/shipment/doc-sort/build` | (API 만 남김) 올린 파일을 바로 정리해 내려받기 — 화면에서는 뺐다 |

## 4. CJ 엑셀 발주번호 열 (cjRef.js)

- 만들기: `formatCjRef` → `[크기] 물류센터 - 발주번호 - N번 (총 M박스) - 수량개`. 수량은 **그 박스에 담긴 수량**(발주서 전체가 아님).
- **순서값은 넣지 않는다.** CJ 엑셀은 순서지정보다 먼저 뽑으므로 그 시점엔 순서가 없다.
- 읽기: `parseCjRef` — 8자리 이상 숫자 뒤의 " - 박스번호(번)" 만 본다. 예전 `144300338 - 1` 도 그대로 읽힌다.
  - 읽는 곳 둘: 송장번호 입력 모달(shipment.html `readInvoiceFile`, 같은 정규식 복사) · 등록 모달의 CJ 엑셀 보충(`parseCjFiles`)
- ⚠ CJ 쪽 그 칸의 글자수 제한은 확인하지 못했다 — 첫 접수 때 잘리지 않는지 본다. 잘리면 `formatCjRef` 만 줄인다 (읽기는 발주번호-박스만 쓰므로 영향 없음).

## 5. 검증 (2026-10-22, 가짜 발주 999999999 로 로컬 end-to-end 후 흔적 삭제)

- 부착 2장·동봉 3장(한 박스 2장) + CJ 결과 엑셀(새 형식) → plan 매칭 2박스(cj-only) → register 부착 2·동봉 2, Storage 4파일
- 임시 seq 101·102 → print label 2장 / manifest 3장, 도장 순번 = seq, 여러 장은 " 1/2 2/2"
- 필터 없이 print → 서류 없는 실제 박스 3개는 `missing` 으로 보고되고 빠짐
- 화면: 버튼 순서 · 배지 툴팁(출고 순서·서류) · [순서대로] 박스 행 3개(seq 순) · 등록 모달 [등록] 활성/비활성 · 콘솔 오류 없음
