# 쉽먼트 재설계 — 찾은 수량(가상확인) · 상태 탭 · 출고완료

> 작성: 2026-10-30 · 상태: **구현 완료 (2026-11-02, 커밋 전)** — 남은 것: supabase/rk_ship_boxes_shipped_at.sql 실행 전까지 [출고완료]·[출고] 탭은 안내 문구만 나온다
> 공용 판정: routes/rkMarks.js (boxFoundMap · boxReadiness · zeroFillUnmarked). rkShared 의 mobileFoundByKey/virtualReadiness 는 지웠다
> 대상: `/shipment`(shipment.html) · `/mobileInbound`(mobileInbound.html) · `routes/rkShared.js` · `routes/rkInbound.js` · `routes/rkOrdersExtra.js` · `routes/rkLabel.js` · `routes/rkShipScan.js` · 입고정리 / 재고준비 / 신규 발주서 가상버전 / 발주서 관리의 박스 칩
> 전제: docs/plan-neworder-virtual.md (가상스캔 · 모바일 입고), docs/plan-ship-docs.md (순서지정 · 서류)

---

## 0. 왜 바꾸나 — 지금의 모순 (2026-10-30 조사, 진행중 발주서 234건 · 박스 347개)

### 0-1. 숫자가 뜻하는 것이 화면마다 다르다
- `/shipment` 의 **스캔수량** = PC 출고스캔이 저장한 박스 수량(`rk_ship_box_items.qty`) = 실제 스캔 + **가상스캔**. 진행중 박스 347개 중 **346개가 가상** 이라 사실상 "가상으로 담기로 한 수량" 이다.
- 모바일 입고 [스캔] 은 그 수량을 바꾸지 않는다. "찾았다" 는 **표시**(`mobile_boxes` found) 만 남긴다.
- 모바일 입고 [없음] 도 표시(`missing`) 뿐이다. **스캔수량·배정(`ship_qty`)·재고(`rk_stocks`, 배정 때 이미 차감)·쉽먼트 파일 납품수량 어디에도 반영되지 않는다.** 지금 없음이 든 박스 28개가 쉽먼트 저장을 하면 전부 담긴 것으로 나간다.

### 0-2. 판정이 틀린다
| # | 모순 | 원인 (코드) |
|---|---|---|
| 1 | 박스 ✅ 가 **첫 상품 하나** 로 정해진다 — 145782435 의 1번(6개 못 찾음)이 ✅, 2·4번(다 찾음)이 👾 | shipment.html `shapeOrder` 가 `confirmed:p.confirmed` 를 박스의 첫 상품에서만 가져온다 |
| 2 | 박스별 찾음 기록(`mobile_boxes`)이 있어도 **발주서 전체 합계** 로 판정한다 — 한 상품이 여러 박스에 나뉘면 다 찾은 박스도 👾 | `rkShared.mobileFoundByKey` 가 키를 `발주번호\|바코드` 로만 합산, `virtualReadiness.keyOk` 도 같은 키 |
| 3 | [없음] 이 어디에도 안 보인다 — 전부 없음인 박스와 손도 안 댄 박스가 같은 👾 | `mobileFoundByKey` 는 found 만 센다 |
| 4 | 일부만 찾은 박스(진행 중)도 👾 | 진행 상태가 없다 |
| 5 | 상품 행 ✅ 와 박스 배지가 한 줄 안에서 엇갈린다 | 상품은 keyOk(발주서 합계), 박스는 첫 상품 |
| 6 | 라벨 확정(`virtual_confirmed_qty`)된 박스는 모바일 없음이 있어도 ✅ | `boxOk` 가 `boxConfirmed \|\| …` (지금 이 경로 박스 0개) |
| 7 | 박스라벨 "이미 뽑힌 라벨 제외" 가 2번 판정을 써서 **다 찾은 박스 라벨이 다시 나온다** (10-30 아침 71장) | `rkLabel.alreadyPrinted` |

### 0-3. 흐름이 끊긴다
| # | 모순 |
|---|---|
| 8 | **"출고했다" 는 기록이 없다** — 나간 박스가 목록·순서·모바일 입고 목록에 계속 남고, /rocket [처리완료] 를 누를 때까지 모든 화면이 "아직 나갈 박스" 로 본다 (송장번호 있는 박스 243개) |
| 9 | [순서대로] 에서 박스 하나를 체크하고 [쉽먼트 저장]·[CJ 엑셀] 을 누르면 **그 발주서의 박스 전부** 가 나간다 — 체크는 박스, 버튼은 발주서 단위 |
| 10 | [부착문서 출력]·[동봉문서 출력]·[초기화] 는 체크가 없으면 **검색으로 걸러진 것과 무관하게 순서 있는 박스 전부** |
| 11 | "순서 지정된 박스 N개" 힌트가 검색 전 전체 수 |
| 12 | [전체]↔[순서대로] 를 오가면 체크 대상이 발주서↔박스로 바뀌는데 표시가 없고, 버튼은 그때 모드의 체크를 쓴다 |
| 13 | 순서대로 화면의 버튼 글자가 "발주서 펼쳐보기" |
| 14 | 필터 '스캔/가상' 이 발주서 단위라 실제·가상이 섞인 발주서는 '스캔' 에서 통째로 빠진다 |

---

## 1. 새 개념 — 찾은 수량 (가상확인 수량)

> 사용자 결정(2026-10-30): 찾음/없음 **구분을 없애고 찾은 수량을 숫자로** 넣는다.
> [스캔] = 그 카드의 몫 전부를 찾음 · [부족] = 키패드로 찾은 수량 입력(0 허용). 이 숫자가 "가상확인" 이라는 뜻의 값으로 모든 판정에 쓰인다.

### 1-1. 수량 세 가지 (이름을 고정한다)
| 이름 | 뜻 | 출처 |
|---|---|---|
| **담은 수량** | 박스에 담기로 한 수량 (실제 스캔 + 가상) | `rk_ship_box_items.qty` (예전 이름 "스캔수량") |
| **실제 스캔** | PC 출고스캔으로 실물을 찍어 담은 수량 | `qty − virtual_qty` |
| **가상확인** | 가상 분량 중 모바일 입고에서 **찾았다고 입력한 수량** | `mobile_boxes[박스].found` 의 합 (신규) |
| **확인 수량** | 실제 스캔 + 가상확인 = 지금 실제로 박스에 있는 수량 | 계산 |
| **부족** | 가상 − 가상확인 (표시가 끝난 상품만) | 계산 |

### 1-2. 데이터 (DB)
`rk_cn_shipping`(입고 배정) · `rk_shipping_list`(재고 배정, source='재고') 두 테이블 공통:

```
mobile_boxes      jsonb  { "<박스번호>": { found: <찾은 수량 0..qty>, qty: <그 박스 몫>, by, at } }   -- "0" = 박스 미정
mobile_found_qty  int    Σ found (신규 열) · NULL = 아직 아무 입력 없음
mobile_status     text   NULL(미입력) | 'found'(Σfound ≥ 몫 합) | 'short'(그 외, 0 포함)   -- 예전 'missing' 은 'short' 로
mobile_at / mobile_by  그대로 (마지막 입력)
```
- 기존 기록 변환(1회 SQL + 스크립트): 항목 `status:'found'` → `found = qty`, `status:'missing'` → `found = 0`; 행 `mobile_status='missing'` → `'short'`; `mobile_found_qty` 채움. 코드에서도 `found` 가 없는 예전 항목은 같은 규칙으로 읽는다(배포 사이 안전).
- 판정 열쇠는 **(발주번호, 바코드, 박스번호)**. 한 박스 상품(`rk_ship_box_items`, `virtual_codes {코드: n}`)은 입고코드별 행 여러 개에 걸칠 수 있으므로 같은 박스 번호의 `found` 를 합산한다 (예: 145782435 2번 R236078420011 = 1021행 13 + 1025행 3).

`rk_ship_boxes`: `shipped_at timestamptz` (신규) — [출고완료] 시각. `shipped_by` 는 /shipment 에 작업자 입력이 없어 두지 않는다.

### 1-3. 판정 (routes/rkShared.js — 모든 화면이 이 하나를 쓴다)
`mobileFoundByBox(orderNumbers)` → `Map("발주번호|바코드" → { byBox: { 박스번호: { found, qty, marked:true } }, row: { found, marked, legacy:true|false } })`

`boxReadiness(items, found)` → 박스마다
```
items   : 가상 수량 > 0 인 상품들 (실제 스캔만인 박스는 items 가 비어 '실제')
item    : share = virtual_qty
          e = byBox[박스번호] (행에 박스별 기록이 있으면) / 없으면 row (예전 기록) / 없으면 미입력
          state = 미입력 | 부족(found < share) | 찾음(found ≥ share)
box.found     = Σ min(found, share)        -- 가상확인
box.short     = Σ (share − found)  [표시된 상품만]
box.state     = 실제(items 없음) | 미진행(모두 미입력) | 진행(일부 입력) | 완료(모두 입력)
box.allFound  = 완료 && short == 0          -- ✅
box.labelOk   = virtual_confirmed_qty == 가상 합 (라벨 확정, 예전 경로) → 완료·allFound 로 본다
```
- `boxOk`(라벨 제외·입고정리 칩이 쓰던 이름) = `allFound || labelOk` 로 유지해 호출처가 안 깨지게 한다.
- `keyOk`(상품 단위) 는 없앤다 — 상품 행의 표시도 **그 박스의 그 상품** 상태로 (모순 5 해소).

### 1-4. 상태 탭 (발주서 = 박스들의 묶음)
| 박스 상태 | 기준 |
|---|---|
| 미진행 | 가상 상품 중 입력된 것이 하나도 없음 |
| 진행 | 하나라도 입력됐지만 미입력 상품이 남음 |
| 완료 | 모든 가상 상품이 입력됨 — ✅ 전부 찾음 / ⚠ 부족 n |
| 출고 | `shipped_at` 있음 |
| (실제) | 가상 없음 → 찾을 것 없음 → **완료** 로 센다 (배지는 📠) |

발주서 탭 = 출고 안 된 박스 기준: 전부 미진행 → 미진행 · 전부 완료 → 완료 · 그 밖 → 진행. 박스가 전부 출고 → 출고 탭(그리고 DONE, §3).
지금 데이터로: 박스 미진행 94 · 진행 15 · 완료 237(부족 포함 28) · 실제 1 / 발주서 미진행 41 · 진행 75 · 완료 81.

---

## 2. 모바일 입고 (/mobileInbound)

### 2-1. 버튼
`[메모] [부족] | [스캔]` — "없음" → **"부족"**.
- [스캔] = 이 카드의 몫(`marksFor` 의 박스별 qty) 을 전부 찾음: `found = qty`.
- [부족] = **키패드 시트**(새 UI) — 큰 숫자 키패드(0~9, ⌫, 확인), 제목 "찾은 수량 / 몫 n개", 0~n 만 허용, 0 은 "하나도 못 찾음". 확인 → `found = 입력값`. 카드가 두 박스에 걸친 전체 보기(curBox == null)면 박스마다 한 줄씩 입력(위에서부터 채우는 기본값 제안).
- 띠(band): `찾음 12/12`(초록) · `부족 7/12`(빨강, 0/12 포함). 띠를 누르면 키패드가 다시 열려 수정. [취소] 는 입력을 지운다(미입력으로).
- 박스 칩 표시: `✓` → `✓` / `7/12`.
- 진행 표시·다음 카드(`nextLeft`·`updateDots`) = **입력된 카드** 기준 (찾음/부족 구분 없음).
- 완료 카드: 타일 `찾음 합 / 부족 합 / 전체`, 아래 "부족으로 입력한 상품" 목록에 `n개 중 m개 찾음`.
- 소리: 스캔 = 기존 ok, 부족 = 기존 none.

### 2-2. API
`POST /api/inbound/mobile-check` · `POST /api/mobile/check`
```
body: { allocId | listId, worker, marks:[{ boxNo, qty(몫), found }], shareTotal }   -- found 없으면 지운다
```
- 서버 `markPatch`: `boxes[k] = { found, qty, by, at }`, `mobile_found_qty = Σfound`, `mobile_status = Σfound ≥ shareTotal ? 'found' : 'short'`, 전부 지우면 NULL.
- 예전 화면(새로고침 안 한 폰)이 보내는 `status:'found'|'missing'` 는 `found = qty | 0` 으로 받는다 (2026-10-22 와 같은 호환 조치).
- 입력 검증: `0 ≤ found ≤ qty` 정수, 아니면 400.
- 이름 없는 입력 거부는 그대로.

### 2-3. 목록(mobile-orders · all-orders)
`{ total, done(입력된 카드), short(부족 카드), foundQty, shareQty }` — `found/missing` 자리를 바꾼다. 화면 알약: `n / total` → 완료면 `✓ 완료` 또는 `부족 3` (빨강).

### 2-4. 박스 나눔(mobile-box-split)·박스 이동 정리(moveMarks)
항목 모양이 `{found, qty}` 로 바뀌므로 옮긴 몫의 `found` 도 비례가 아니라 **옮긴 박스의 새 입력으로 다시 받는다**(기록 지움) — 지금과 같은 정책(원래 박스 기록만 정리).

---

## 3. 쉽먼트 (/shipment)

### 3-1. 화면 구조
```
[상태 탭]  전체 · 미진행 · 진행 · 완료 · 출고          [보기]  발주서 | 순서대로        [필터] 전체 / 실제 / 가상
```
- 상태 탭과 보기 토글은 **독립** 이다. 순서대로 = 순서 있는 박스만 박스 한 줄씩(지금과 같음), 상태 탭이 그 위에 또 걸린다.
- 상단 숫자: `발주서 n · 박스 n · 담은 n · 확인 n · 부족 n`.
- 열(발주서 보기): 발주번호 · 물류센터 · 품목 · **담은** · **확인** · **부족** · 박스수 · 박스 · 입고예정일. 상세 행: 발주 · 확정 · 담은 · 확인 · 부족 (확인 = 실제 + 찾음, 부족은 빨강).
- 열(순서대로): 순번 · 발주번호-박스 · 센터 · 크기 · 담은 · 확인 · 상태 · 서류 · 입고예정일.

### 3-2. 박스 배지
| 배지 | 뜻 |
|---|---|
| 📠 회색 | 실제 스캔만 (찾을 것 없음) |
| 👾 진보라 | 전부 가상 · 미진행 |
| 🔄 보라 `3/8` | 진행 — 입력된 상품 / 전체 |
| ✅ 초록 | 완료 · 전부 찾음 |
| ⚠ 주황 `부족 n` | 완료 · 부족 n개 |
| 🔀 | 실제+가상 섞임 — 가상 부분의 상태 색을 따른다 (📠 와 함께) |
| 📃 | 서류 등록됨 (그대로) |
| 🚚 | 출고완료 (출고 탭) |
가이드 범례도 같이 바꾼다.

### 3-3. [출고완료] — 순서대로 보기, [초기화] 왼쪽
- 대상 = 체크한 박스, 없으면 **지금 화면에 보이는** 순서 박스 전부(검색·탭 반영 — 모순 10 해소). 확인 창에 박스 수·발주서 수.
- 서버 `POST /api/shipment/ship { boxes:[{orderNumber, boxNo}] }`:
  1. `rk_ship_boxes.shipped_at = now` (이미 출고된 박스는 건너뜀)
  2. 그 박스의 `rk_ship_seq` 행 삭제 (남은 박스 순서는 그대로 — 번호는 다시 매기지 않는다)
  3. 발주서의 **모든 박스** 가 출고되면 `rk_orders.status = 'DONE'` (사용자 결정) — 응답에 `doneOrders`
  4. 부족 반영(§5 결정 사항 B) 이 켜져 있으면 여기서 실행
- 되돌리기: 출고 탭 [출고 취소] → `shipped_at = null`, 그 발주서가 DONE 이면 NULL 로 되돌리고 알림. 서류(rk_ship_docs)는 건드리지 않는다.
- 출고된 박스는 **모든 화면에서 "나갈 박스" 에서 빠진다**: `/api/shipment/orders`(출고 탭 외) · 박스라벨 order-boxes · CJ 엑셀 · 쉽먼트 저장 · 모바일 all-orders/mobile-orders · 순서 저장(거부, invalid) · 서류 출력(제외) · box-map(`shipped:true` → 칩 회색 🚚).
- `/api/shipment/orders` 는 DONE 발주서를 빼므로 출고 탭을 위해 `?shipped=1` 로 **출고 박스가 있는 발주서(DONE 포함, 최근 30일)** 를 따로 준다.

### 3-4. 순서대로 화면의 나머지 모순
- 발주서 단위 버튼(박스라벨출력·CJ 엑셀·쉽먼트 저장)이 순서대로에서 눌리면 **체크한 박스만** 대상으로 보낸다 — 서버 `export`·`export-cj`·`order-boxes` 에 `boxes:[{orderNumber, boxNo}]` 선택 인자를 추가한다 (모순 9).
- 출력·초기화는 "보이는 것" 기준 (모순 10). 힌트는 화면 기준 수 (11). 모드를 바꾸면 체크를 비우고 토스트로 알린다 (12). 버튼 글자 "펼쳐보기/접기" (13). 필터 '실제/가상' 은 박스 단위로 거른다 (14).

### 3-5. 납품수량 = 확인 수량 (사용자 결정 필요 — §5 A)
- [쉽먼트 저장]·[CJ 엑셀] 의 수량을 **확인 수량(실제 + 찾음)** 으로 쓴다. 지금은 담은 수량(가상 포함) 이라 없음이 그대로 나간다(모순 0-1).
- 대상 박스에 **미진행·진행 박스가 있으면 막는다** — "모바일 입고를 끝내지 않은 박스 n개: …" (확인 수량이 실제 수량이 아니므로).
- 찾은 수량이 0 인 상품은 파일에서 빠지고, 박스의 확인 수량이 0 이면 박스째 빠지며 알린다.
- 내보내기 이력(`rk_export_log_items`)에 `found_qty` 를 같이 남긴다.

---

## 4. 다른 화면 — 숫자로 바뀌면 손봐야 하는 곳 (전수)

| 파일 | 지금 | 바꿀 것 |
|---|---|---|
| `routes/rkShared.js` | `mobileFoundByKey` / `virtualReadiness` | `mobileFoundByBox` / `boxReadiness` (§1-3). 예전 이름은 새 함수를 감싸 남긴다 |
| `routes/rkInbound.js` | `markPatch`·`boxMark`·mobile-orders·all-orders·mobile-check·check·box-split·moveMarks | §2 |
| `routes/rkOrdersExtra.js` | shipScanOrders(가상확정·스캔수량)·export·export-cj·sequence | §3 — 상품 행에 `확인수량·부족수량·입력여부`, 박스에 `state·shipped_at`, 박스 선택 인자, 납품수량 규칙, 출고 API |
| `routes/rkLabel.js` | `alreadyPrinted` (실제 스캔 / 가상확정) | `box.allFound || labelOk` → "가상확정" 이유 그대로. 출고 박스 제외. (별도: 뽑은 기록 남기기는 이번 범위 밖) |
| `routes/rkShipScan.js` | `activeBoxesAndItems`·box-map·virtual-boxes·box·scanned-map | 새 판정으로. box-map 에 `state·found·short·shipped` 추가, `/box` 의 `mobileFound` → 상품별 `found/share` |
| `routes/rkAllocate.js` status | `mobile: mobile_status` | `+ mobileFound: mobile_found_qty` |
| `routes/rkInbound.js` arranged | `모바일·모바일박스` | `+ 모바일찾음(mobile_found_qty)` |
| `mobileInbound.html` | 찾음/없음 | §2 |
| `shipment.html` | | §3 |
| `inboundArrange.html` 모바일 열 | ✅ / ❌ / 🔸 | `12/12` 초록 · `7/12` 빨강 · 일부 입력은 박스별 툴팁. 박스 칩에 진행·부족 상태 |
| `stockPrepare.html` · `newOrderVirtual.html` 박스 칩 | ✅ 👾 🔀 | + 🔄 진행 · ⚠ 부족 · 🚚 출고 (`box-map` 의 state) |
| `newOrderVirtual.html:668` 배정 칩 | `✓찾음 / ✕없음` | `✓ / 부족 n` |
| `rocket.html` 가상확정수량 | scanned-map 의 confirmed | 그대로(allFound) + 툴팁에 부족 |
| `virtualConfirm.html` (라벨 확정) | 별도 확정 경로 | 유지하되 설명에 "모바일 입고 입력이 우선" (§5 D) |
| `/shortage` Scan 열 | 담은 수량(가상 포함) | **이번 범위 밖**, 다음에 "실제 + 찾음" 으로 (10-29 보류 건과 함께) |

---

## 5. 결정 (2026-11-02 확정)

- **A. 납품수량 = 가상확인 수량(실제 스캔 + 찾은 수량).** [쉽먼트 저장]·[CJ 엑셀] 대상에 입력이 안 끝난 상품이 있으면 모달로 `발주서 · 박스 · 바코드 · 상품명 · 담은 수량` 목록을 보여주고 **[중단] / [0개로 처리하고 계속]** 을 묻는다. 처리 = 그 상품들에 found 0(부족) 을 기록(기록자 "PC(쉽먼트)") 한 뒤 파일을 만든다. 0개 상품은 파일에서 빠지고, 박스가 통째로 0이면 박스도 빠지며 모달에 미리 알린다.
- **B. 부족분은 재고·입고로 되돌리지 않는다.** 10개 입고·10개 배정 후 7개만 찾았다면 3개는 "애초에 덜 들어온 것" 이다. 배정(`ship_qty`)·재고(`rk_stocks`)·박스 담은 수량은 그대로 두고, 부족은 숫자로 기록만 한다. 그래야 반복 작업에서 남은 수량이 실물과 맞는다. [출고완료] 는 재고를 건드리지 않는다.
- **C. 이모지** 📠 실제 스캔 · 👾 미진행 · 🔄 진행 n/m · ✅ 전부 찾음 · ⚠ 부족 n · 🚚 출고완료.
- **D. /virtualConfirm** 은 메뉴에서 내린다 (주소로는 열림, 기존 라벨 확정 기록은 판정에 계속 쓴다).
- 용어: "확인 수량" 은 쓰지 않고 **가상확인 수량** 하나로 부른다 (실제 스캔분은 확인된 것으로 센다).

---

## 6. 순서와 검증

1. **DB** — `rk_ship_boxes.shipped_at`, `mobile_found_qty` 두 테이블, 기존 기록 변환 스크립트(건수 전후 비교).
2. **공용 판정 + /shipment API** — `boxReadiness`, shipScanOrders 응답 확장(상품 확인·부족, 박스 state·shipped). 145782435 로 기대값 검증: 1번 진행(6개 미입력) · 2·3·4번 ✅.
3. **/shipment 화면** — 상태 탭 · 보기 토글 · 배지 · 열 · 출고완료/출고 취소 · 순서대로 모순 9~14.
4. **모바일 입고** — 부족 키패드 · 숫자 저장 · 목록 진행 · 호환(예전 status).
5. **다른 화면** — §4 표.
6. **내보내기** — 납품수량 규칙(A) · 박스 선택 인자 · 출고완료 반영(B).
7. **검증** — 실제 발주서 1건으로 모바일 입력 → 쉽먼트 상태 → 출고완료 → DONE → 출고 취소까지 로컬 end-to-end, 흔적 복구. 박스라벨 제외가 다 찾은 박스를 빼는지 확인.
