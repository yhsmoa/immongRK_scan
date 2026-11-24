# 와우출고 — 위해 창고 재고를 발주서에 배정 · 가상스캔 → 중국에서 쿠팡 센터로 바로 출고 (2026-11-18)

> 상태: **v1 — 로켓 쪽 구현 완료(2026-11-18, 미커밋 · 브라우저 확인 전 · `supabase/rk_wow.sql` 실행 필요)**, 1688-invoice 쪽 구현 중. 두 프로젝트: 로켓(`immongRK_scan`) · 1688-invoice(`D:\project\2026\1688-invoice`).
> DB 도 둘: 로켓 DB(`rk_*`) · 구매 DB(`ft_*`, manage-item — 구매 페이지와 1688-invoice 가 같이 쓴다). 두 DB 를 묶는 트랜잭션은 없다.
> 로켓 서버는 `routes/rkWeihai.js` 의 `odb`(**anon 키**)로 구매 DB 를 읽고 쓴다 → 로켓이 부르는 구매 DB 함수는 기존 `ft_storage_request_create` 와 같은 방식(SECURITY DEFINER + anon 실행 권한)이다.

## 1. 사용자 결정 (바꾸지 않는다)

| # | 결정 |
|---|---|
| U1 | 세는 재고는 1688-invoice 재고(보관) **[재고] 탭만** ([작업중] 제외). 계정은 `ORDER_ACCOUNT_USERNAME`(immongbr, user_code BR) |
| U2 | 배정 순서: 한국 재고 · 입고 먼저 → **모자란 것만** 위해 창고 |
| U3 | 배정에서 끝내지 않고 **가상스캔까지**. 위해 창고 분은 한국 분과 **박스를 따로** 만든다 |
| U4 | 위해 박스는 **중국에서 쿠팡 센터로 바로 출고** — 한국에 오지 않고 CN입고에도 안 잡힌다 |
| U5 | 1688-invoice 재고(보관) 하위메뉴 **`와우출고`** — 출고요청(발주번호-박스번호별 담을 상품 · 수량) |
| U6 | [재고] 탭 수량 옆에 **`출고예정` · `잔여수량`** |
| U7 | 재고(보관) 화면의 사업자 드롭박스 → **탭**(`전체` + 사업자별) |
| U8 | /storage 가 처음 여는 탭 = [재고]. 재고 화면 사진은 image-proxy 경유 |
| U9 | 하이브리드: **상자를 정한 요청**(와우출고)은 그 상자끼리만 담고, **그냥 출고 요청**(기존 쉽먼트 요청)은 지금처럼 순서대로 |
| U10 | 로켓 쉽먼트 화면: 위해 박스를 한국 박스와 **같이** 보여 주고 🇨🇳 표시 + 중국만 보는 필터 |
| U11 | 중국에서 출고하면 그 박스는 **출고완료** — 발주서의 모든 박스가 출고완료면 처리완료(기존 규칙) |
| U12 | 로켓 쉽먼트에 등록한 서류(부착문서 · 동봉문서)를 **1688-invoice 와우출고에서 바로 조회** |

## 2. 원칙

- **"로켓이 무엇을 원하는가"** = 로켓 DB: 위해 배정 행(`rk_shipping_list.source='위해'`, 발주번호+바코드당 1행) + 위해 박스(`rk_ship_boxes.origin='위해'` · 그 줄 `rk_ship_box_items`).
- **"재고가 잡혔는가 · 담았는가 · 출고했는가"** = 구매 DB. 상태는 저장하지 않고 읽어 낸다(줄: `picked_at`, 박스 출고: 묶인 1688 박스의 PACKED 행이 전부 `shipment_id` 를 가짐).
- 맞추는 길은 둘뿐이다.
  - **밀어주기** `syncOrder(발주번호)` — 로켓 DB 에서 그 발주서의 원하는 상태 전체를 **보내기 직전에 다시 읽어** `ft_wow_sync_order` 로 넘긴다. 멱등. 발주서별로 줄 세운다(서버 프로세스 1개 전제 — Procfile).
  - **끌어오기** `pull()` — 구매 DB 의 담은 수량 · 출고를 로켓에 반영하고, 양쪽 발주번호를 **합집합**으로 훑어 어긋난 발주서를 다시 밀어준다(로켓에 없는데 구매 DB 에 남은 예약도 여기서 풀린다).
- 순서: 중국이 담을 수 있는 것이 **늘면 로켓 먼저**, **줄면 구매 DB 먼저**.
- 1688-invoice 는 로켓을 부르지 않는다.

## 3. 구매 DB — `1688-invoice/supabase/storage/005_wow.sql`

### 3-1. 테이블 · 뷰

- `ft_wow_boxes(id, user_id, order_number, box_no int, center, box_size, box_info_id unique null, label_path, manifest_path, picked_at, picked_by, created_at, updated_at)` · unique `(user_id, order_number, box_no)`
- `ft_wow_items(id, user_id, order_number, wow_box_id null → ft_wow_boxes on delete cascade, barcode, product_id, qty > 0, picked_qty null, outbound_id null, picked_at)` · unique `(user_id, order_number, wow_box_id, product_id) nulls not distinct`
  - `wow_box_id is null` = 배정만 됐고 박스 미정(예약은 되지만 담을 수 없다)
- 뷰 `ft_storage_available(user_id, product_id, qty, reserved, available)` — **출고예정·잔여수량의 유일한 정의**
  - `qty` = `ft_storage_balance` 의 상품 합 · `reserved` = 와우 미담음 줄(`picked_at is null`) 수량 합 + 쉽먼트 요청(REQUESTED) 수량 합 · `available = qty − reserved`
- 와우 대상 상품(바코드 → product_id)도 **한 곳**에서 정의: 그 계정의 `arrival_route='STOCK'` · DONE 아님 · `set_total ≤ 1` · `trim(barcode)` 일치. 여럿이면 `first_putaway_at` 빠른 순 → product_id 순. `ft_wow_available` 과 `ft_wow_sync_order` 가 같은 정의를 쓴다.

### 3-2. 로켓이 부르는 함수 (SECURITY DEFINER · anon 실행)

- `ft_wow_available(p_user_id)` → `(barcode, qty, reserved, available)` 바코드별(대상 상품 합).
- `ft_wow_sync_order(p_user_id, p_order_number, p_center, p_lines jsonb, p_boxes jsonb)` → 적용 뒤 상태
  - `p_lines = [{barcode, box_no|null, qty}]` (같은 barcode+box_no 는 한 줄) · `p_boxes = [{box_no, box_size, arrival_date, box_total, center_phone, center_address}]` (arrival_date = 입고예정일 · box_total = 그 발주서의 박스 전체 수(한국 박스 포함) · center_phone/center_address = 쿠팡 물류센터 연락처·주소 — 1688-invoice 와우출고 화면 · 택배엑셀용. null 이면 저장된 값 유지. 줄이 같아도 이 값이 다르면 끌어오기가 다시 밀어준다)
  - 1688-invoice 는 서류준비 박스에 서류를 붙인 뒤 [출고준비완료] 를 눌러 **출고준비** 단계로 넘긴다(`ft_wow_boxes.ready_at`) — 이때부터 1688 쉽먼트에서 출고할 수 있다. 로켓은 이 값을 읽어 쉽먼트 관리의 위해 박스 단계에 보여준다
  - 잠금: `ft_wow:user:order` → 관련 상품의 `ft_storage:product_id` 를 product_id 오름차순으로.
  - 담은 박스(`box_info_id` 있음)는 **얼어 있다**: 원하는 줄이 담은 수량과 같아야 하고 박스가 사라질 수 없다 → 아니면 `WOW_BOX_PICKED:<box_no>`. 같으면 줄의 `qty := picked_qty`.
  - 안 담은 박스 · 줄은 원하는 상태로 통째로 바꾼다. 바코드의 상품이 여럿이면 잔여수량 순서대로 나눈다(담은 줄의 상품은 고정).
  - 검증: 이번 호출로 **예약이 늘어난 상품**이 `available < 0` 이면 `WOW_SHORT:<barcode,…>` (줄이기만 하는 호출은 재고가 음수여도 통과). 대상 상품이 없으면 `WOW_BARCODE_NOT_FOUND:<barcode>`. 입력 오류는 `WOW_INVALID_INPUT`.
  - 예외는 전체 롤백. `p_lines = []` 이면 그 발주서의 안 담은 것을 모두 푼다.
- `ft_wow_order_state(p_user_id, p_orders text[] default null)` → 줄 단위 `(order_number, box_no, barcode, qty, picked_qty, picked_at, box_code, shipped_at, shipment_no)`. `null` 이면 **출고 전 줄이 남은 모든 발주서**.
- `ft_wow_doc_set(p_user_id, p_order_number, p_box_no, p_kind 'label'|'manifest', p_path)` — 서류 경로 기록(박스가 있어야 한다).
- 서류 파일: private 버킷 `wow-docs`, 경로 `{발주번호}/{박스번호}/{label|manifest}.pdf`. 로켓(anon)이 올리고 1688-invoice(service)가 signed URL 로 읽는다 — 정책은 이 DB 의 기존 anon 업로드 버킷과 같은 방식으로, 이 버킷에만.

### 3-3. 1688-invoice 가 부르는 함수 (service role)

- `ft_wow_pick(p_user_id, p_wow_box_id, p_box_info_id, p_lines jsonb[{item_id, picks:[{location_id, qty}]}], p_operator_id, p_operator_name)`
  - 1688 박스 조건: 그 사업자 것 · 미출고 · PACKED 행이 한 번도 없음 · master 아님/없음 · 다른 와우 박스에 안 묶임.
  - 줄마다 담은 수량 ≤ 요청 수량(0 가능, 전부 0 은 거절). 타입은 `DIRECT`(X) 로 확정(`ft_storage_resolve_type(…, true)`).
  - 내부는 `ft_storage_pick_core` 를 쓴다(아래). 담으면 그 줄의 예약은 끝난다 — 적게 담은 나머지도 풀린다.
- `ft_wow_unpack(p_user_id, p_wow_box_id, …)` — 출고 전에만. PACKED 행을 재고로 되돌리고 묶음 · 담은 기록을 지운다(줄은 다시 요청 상태).
- 기존 함수 보강(서명 유지)
  - `ft_storage_pick_to_shipment` = 잠금 → 와우 박스면 거절 → **`balance − 와우 미담음` 까지만**(`PICK_OVER_AVAILABLE`; 쉽먼트 요청 수량은 이 꺼내기의 몫이라 빼지 않는다) → `ft_storage_pick_core` → 요청 DONE.
  - `ft_storage_request_create`: `p_qty ≤ available` (코드는 `REQUEST_INVALID_QTY` 그대로).
  - `ft_move_request_create`: 와우 박스의 행은 건너뛴다.
  - 수량 수정 · 위치 이동 · unpick 은 막지 않는다(실물 우선 — 모자라면 잔여수량이 음수로 보인다).
- 와우 박스 보호(다른 경로가 못 건드리게) — 트리거 2개
  - `ft_fulfillment_outbounds` BEFORE INSERT / UPDATE OF box_info_id, quantity / DELETE: 와우에 묶인 1688 박스를 건드리면 거절. 와우 함수는 트랜잭션 로컬 설정(`set_config('ft.wow','on',true)`)으로 통과. 출고(`shipment_id` · `shipment_no` 갱신)는 허용.
  - `ft_box_info` BEFORE UPDATE OF master_box_id: 와우 박스가 끼는 합치기 거절.

### 3-4. 출고 (1688-invoice `app/api/ft/shipments/route.ts`)

- 박스 갱신에 `.eq('user_id').is('shipment_id', null)` 추가(같은 코드의 옛 박스를 덮어쓰던 기존 버그).
- 와우 박스는 **통째로만** 출고(일부 행만 고르면 거절) · 와우 박스와 일반 박스를 한 출고번호에 **섞지 않는다**(행선지가 다르다).

## 4. 로켓 (이 저장소)

### 4-1. DB — `supabase/rk_wow.sql` (사용자가 SQL Editor 에서 실행 · 다시 실행해도 안전)

- `rk_shipping_list.source` check 에 `'위해'` · 부분 unique `(order_number, barcode) where source='위해' and status='출고예정'`
- `rk_ship_boxes.origin text` (`'위해'` 또는 null) + check
- `rk_allocate_save`: `p->'weihai' = [{orderNumber, barcode, qty, …}]` 를 받아 upsert(`qty = qty + excluded.qty`). 재고 차감 없음. 확정수량 상한은 기존 검증이 모든 source 를 센다. 반환에 `weihai` 추가(되돌리기용).

### 4-2. 동작

| 동작 | 순서 · 규칙 |
|---|---|
| [배정] 계산 | 출처에 위해 창고. 한국 재고 · 입고를 다 쓴 뒤 남은 `필요` 만 `ft_wow_available.available` 에서(여러 발주서가 같은 풀을 나눠 쓴다). 구매 DB 를 못 읽으면 **오류로 멈춘다** |
| [배정] 확정 | 로켓 RPC → 발주서별 `syncOrder`. `WOW_SHORT` · `WOW_BARCODE_NOT_FOUND` 면 그 바코드의 위해 행을 **박스에 담긴 수량까지** 줄이고 다시 밀어준다. 연결 오류면 이번에 늘린 위해 수량을 되돌리고 알린다 |
| [배정 취소] | 남는 위해 배정 ≥ 위해 박스에 담긴 수량일 때만. `syncOrder`(줄인 상태) → 행 삭제 |
| [가상스캔] | 위해 분이 있으면 먼저 `syncOrder` 성공을 확인(실패면 위해 분만 건너뛰고 알림) → 박스 저장 → `syncOrder` |
| 위해 박스 삭제 | `syncOrder`(박스 뺀 상태) 먼저 — 담은 박스면 `WOW_BOX_PICKED` 로 거절 |
| 출고완료 · 출고취소 | 위해 박스는 손으로 못 한다 — `pull` 만 바꾼다 |
| 처리완료(DONE · `/api/orders/complete`) | 원하는 상태에서 **박스 미정 분을 뺀다** → 그 예약이 풀린다. 로켓 행은 기존 재고 · 입고처럼 그대로 둔다 |
| 센터 변경 | `syncOrder` |

- 가상스캔 엔진(`virtualPack.js`): `'위해'` 를 세 번째 출처로(담는 순서 맨 끝). 위해 분은 **항상 새 박스**(채우기 없음), 한국 분의 채우기 대상에서 위해 박스 제외, 실제 스캔은 위해에 귀속하지 않는다.
- `saveShipState` 지킴 규칙: 위해 박스의 줄은 DB 와 같아야 하고 `'위해'` 코드는 위해 박스에만. 어기면 409. 모바일 박스 나누기 · 이동, 스캔상세 저장도 위해 박스/행은 거절.
- `pull()`: (1) 담은 줄의 `picked_qty < 로켓 줄` 이면 박스 줄(`qty` · `virtual_qty` · `virtual_codes['위해']`)을 담은 수량으로 **맞추고** 위해 배정 행을 같은 차이만큼 줄인다(0 이면 삭제) → 발주서에 부족이 다시 생긴다. (2) 출고된 박스는 `markShipped`(기존 출고완료의 `shipped_at` · 순서 삭제 · DONE 판정을 함수로 뺀 것). (3) 합집합 발주서 다시 밀어주기. 한국 박스 · `rk_stocks` · `rk_cn_shipping` · 모바일 기록은 건드리지 않는다.
- 한국에서만 뜻이 있는 것에서 위해를 뺀다: 가상확정 목록 · 모바일 입고 [전체] · 박스라벨 · 순서지정 · CJ 접수 · 서류 출력. 입고정리 [출고준비] 의 기존 예약 합은 위해도 센다(지금은 재고만 세어 이중 배정된다).
- 박스 준비 상태(`rkMarks`): 위해 박스는 한국에서 찾는 대상이 아니다 → 상태 `'위해'`, 발주서 상태 계산에서는 아직 진행 중.
- 쉽먼트 화면: 🇨🇳 표시 · 중국만 보는 필터. [쉽먼트 등록] 으로 위해 박스 서류가 들어오면 `wow-docs` 에도 올리고 `ft_wow_doc_set`(실패해도 등록은 막지 않고 응답에 알림). 서류 매칭의 수량 추정은 위해 박스와 한국 박스를 서로 다른 후보군으로.
- /newOrderV: 배정 창 출처에 위해 창고 · 표에 위해 열 · 구매 DB 와 어긋난 발주서 표시.
- /shortage 🇨🇳 재고 = `available`(잔여수량).
- API 는 `/api/wow/*` (사원도 쓴다 — `ADMIN_ONLY` 에 넣지 않는다): `GET /api/wow/status` · `POST /api/wow/pull`.

## 5. 1688-invoice

- 메뉴 `와우출고`(ko · zh) · `/storage/wow`: 박스 카드(발주번호-박스번호 · 센터 · 크기 · 요청/담음/출고) · 줄(요청 · 담은 수량) · [담기](위치별 수량 · 빈 X 박스 고르기/만들기 · 적게 담을 때 확인) · [담기 취소] · 서류 보기 · 박스 미정 줄은 따로 표시.
- [재고] 탭: `출고예정` · `잔여수량` 열 — **상품 합계**(행은 상품×위치라 위치별로 나누면 거짓이 된다). 잔여수량 음수는 빨갛게. [쉽먼트] 모달은 `PICK_OVER_AVAILABLE` 처리.
- 사업자 탭(`전체` + 사업자별) — [작업중] · [재고] · 와우출고 공통. 한 번에 전부 받아 탭으로 거른다. 모달은 **행의 사업자**로 동작. `전체` 에서 막는 것: 사업자가 섞인 [쉽먼트], 두 사업자에 같은 주문번호가 있는 스캔.
- /storage → `/storage/stock`. `ProductCell` 사진은 `proxyImageUrl(img, THUMB_WIDTH)`.

## 6. 순서별 점검

| 상황 | 결과 |
|---|---|
| 두 발주서가 같은 재고를 동시에 배정 | 늦은 쪽 `WOW_SHORT` → 그 바코드의 위해 행이 줄고 부족으로 남는다 |
| 로켓 저장 뒤 밀어주기가 연결 오류 | 이번에 늘린 위해 수량을 되돌린다. 응답만 잃어 구매 DB 에 예약이 남았으면 다음 `pull` 의 합집합 훑기가 푼다 |
| 밀어주기 안 된 채 가상스캔 | 가상스캔 전에 `syncOrder` 성공을 요구 — 실패면 위해 분은 박스를 만들지 않는다 |
| 배정과 가상스캔이 같은 발주서에서 겹침 | 발주서별 줄 세우기 + 보내기 직전 다시 읽기 → 늦게 도착한 옛 상태가 덮지 못한다 |
| 요청보다 적게 담음 | 그 줄의 예약은 끝. `pull` 이 로켓 박스 · 배정을 담은 만큼으로 줄여 발주서에 부족이 생긴다. 실물이 정말 없으면 중국에서 [재고] 수량을 고친다(안 고치면 다음 배정이 다시 잡는다 — 담기 화면이 안내) |
| 담은 뒤 로켓에서 취소 · 박스 삭제 · 줄 수정 | `WOW_BOX_PICKED` 로 거절. 중국의 [담기 취소] 뒤에는 가능 |
| 담기와 취소가 동시에 | 둘 다 `ft_wow:user:order` 잠금 — 먼저 된 쪽이 이기고 늦은 쪽이 거절된다 |
| 한국 박스를 먼저 출고완료 | 위해 박스가 남아 있어 발주서는 진행중 |
| 박스 미정 위해 배정이 남은 채 처리완료 | 그 예약은 풀린다 |
| [재고] 탭에서 와우 예약분을 꺼내려 함 | `PICK_OVER_AVAILABLE` |
| 일반 스캔 · 이동 · 합치기가 와우 박스를 건드림 | 트리거가 거절 |
| 재고 수량 수정으로 잔량 < 출고예정 | 수정은 된다. 잔여수량이 음수로 보이고 담을 때 모자란 만큼 적게 담게 된다 |
| 구매 DB 연결 불가 | 위해 배정 계산은 오류, 표의 어긋남 표시는 "확인 불가", 한국 분 동작은 그대로 |
| 와우 박스 일부만 출고 · 일반 박스와 한 출고번호 | 거절 |

## 7. 범위 밖 · 알려 둘 것

- 위해 박스의 운송사 · 송장: 정해지지 않았다. 지금은 CJ 접수에서 빼고, 송장번호는 기존 [송장번호 입력] 으로 넣을 수 있게만 둔다.
- 구매 페이지(purchase_agent)의 쉽먼트 요청 창 최대 수량 표시는 그대로다 — 잔여수량을 넘으면 함수가 거절한다.
- 로켓이 구매 DB 를 anon 키로 쓰는 것은 기존 방식 그대로다(서비스 키로 바꾸는 것은 별도 결정).

## 8. 로켓 구현 메모 (2026-11-18)

- 모듈 `routes/rkWow.js`: `available` · `wowOrder(no, push => …)`(발주서별 줄 세우기, push 는 안에서 로켓 DB 를 다시 읽는다) · `syncOrder(s)` · `shrink`(줄이기: 구매 DB 먼저) · `commitAllocated` · `pull` · `pushDocs`. `odb` · 계정 · 읽기 재시도는 `rkWeihai` 것을 쓴다.
- `markShipped` 는 `rkMarks` 로 옮겼다(쉽먼트 [출고완료] · 끌어오기 공용). 처리완료가 된 발주서는 그 자리에서 `syncOrders` 로 박스 미정 예약을 푼다(실패는 응답 `wowErrors`, 끌어오기가 다시 맞춘다).
- `syncOrders` 는 한 번에 읽어 위해 배정·위해 박스가 있는 발주서만 보낸다(처리완료 · 센터 변경).
- 끌어오기 합집합 = 구매 DB 의 출고 전 줄이 있는 발주서 ∪ 출고 안 된 위해 박스가 있는 발주서 ∪ 진행중 발주서 중 위해 배정이 있는 것. 할 일이 없는 발주서(담음·출고 없음, 상태 같음)는 줄 세우지 않고 건너뛴다. 열 때 부르는 화면: /newOrderV · 쉽먼트.
- `saveShipState`(출고스캔 저장 · 일괄 가상스캔 공용) 전체를 발주서별로 줄 세운다. 새 위해 박스 = `'위해'` 코드만 든 새 박스(origin 은 서버가 정한다). 먼저 밀어주기가 실패하거나 위해 배정이 줄었으면 위해 박스만 빼고 저장 → `wowWarning`.
- 가상스캔: 실제 스캔이 한국 배정보다 많으면 남은 목표를 넘지 않게 위해분을 줄인다(확정수량 초과 방지).
- 서류 매칭 수량 추정: 같은 수량의 위해 · 한국 후보가 함께 있으면 부착문서에 CJ 운송장이 찍힌 장은 한국 박스, 아니면 위해 박스에서 고르고 애매함으로 표시.
- /shortage 🇨🇳 = `ft_wow_available.available` — 예전 `storageQtyByBarcode`(대표 행 매핑)와 X-CnStock-Warn(바코드 못 찾음)은 없앴다.
- 모바일 [박스 이동 › 기존박스] 후보에서 위해 박스를 뺀다(번호는 비켜 간다).

## 9. 1688-invoice 와우출고 흐름 변경에 맞춤 (2026-11-24)

1688-invoice 쪽 설계: `1688-invoice/supabase/storage/010_wow_flow.sql` · `011_wow_alloc.sql`.

- 단계가 늘었다: 신규 › 작업중 › 작업완료 › 서류준비 › **순서지정 › 합포장** › 출고준비 › 출고. 작업은 중국 모바일(1688-invoice `/m/wow`)에서 박스 라벨을 찍어 한다.
- **"담았다" = `ft_wow_boxes.picked_at`**. 마킹 상자(`box_info_id`)는 이제 [출고준비완료] 때 정해지고, 마대면 여러 위해 박스가 한 상자를 쓴다. 그래서 `rkWow.stageOf` 는 `picked_at` 으로 담음을 본다(예전: `box_info_id`). `ft_wow_order_state` 의 `box_code` 는 출고준비 전까지 비어 있다 — 로켓은 이 값을 쓰지 않는다.
- 박스 크기: 중국 작업자가 모바일에서 바꾸면 `ft_wow_boxes.packed_box_size` 에 남는다. 끌어오기(`pull`)가 출고 전 위해 박스의 `rk_ship_boxes.box_size` 를 그 값으로 맞추고 다시 밀어준다(응답 `sized`).
- 하나도 담지 못하고 작업완료한 박스: 담은 수량 0 으로 끌어오기가 박스 줄 · 위해 배정을 줄이고, 다음 밀어주기 때 구매 DB 가 그 박스 기록을 지운다.
- 선반 배정은 구매 DB 가 박스가 들어올 때 잡아 둔다(`ft_wow_alloc`) — 로켓이 보내는 값은 그대로다.

## 10. 중국 [발주취소] 반영 (2026-11-24)

1688-invoice 쪽 설계: `1688-invoice/supabase/storage/012_wow_cancel.sql`.

- 1688-invoice 와우출고 화면의 **[발주취소]** 는 출고 전 박스를 어느 단계에서든 없앤다. 구매 DB 는 그 박스의 줄 · 선반 배정을 지우고 박스 행만 "취소됨"(`ft_wow_boxes.cancelled_at`)으로 남긴다. 이미 꺼낸 상품은 중국 재고의 배치 대기로 돌아간다(선반으로 되돌리지 않는다).
- 취소된 박스 행이 남아 있는 동안 `ft_wow_sync_order` 는 그 박스의 줄을 다시 넣지 않는다 — 로켓이 아직 그 박스를 들고 밀어줘도 되살아나지 않는다.
- 끌어오기(`pull`)가 취소를 반영한다: 출고 전 위해 박스 중 구매 DB 에서 취소된 것은 **박스를 지우고(줄 포함) 그 수량만큼 위해 배정(`rk_shipping_list` source=위해)을 줄인다** → 발주서에 부족이 다시 생긴다(응답 `cancelled`). 그 뒤 박스를 뺀 상태를 다시 밀어주면 구매 DB 가 취소된 박스 행을 지운다.
  - 순서: 박스 삭제 → 배정 줄이기. 중간에 끊기면 그 배정이 박스 미정으로 남을 뿐, 다음 끌어오기가 배정을 두 번 줄이지 않는다.
  - 취소된 박스 행이 남은 발주서는 로켓에 위해 배정 · 박스가 없어도 끌어오기 대상에 넣고 한 번 밀어준다(행 정리). 행이 남아 있으면 같은 박스 번호를 다시 만들어도 줄이 들어가지 않기 때문이다.
- `rkWow.stageOf` 는 취소된 박스를 `발주취소` 로 돌려준다(끌어오기 전 잠깐만 보인다).
