# 신규 발주서 가상버전 설계 — 배정(재고+입고 통합) → 가상스캔 → 세로 박스라벨 → 모바일 [전체]/[입고]

> 작성: 2026-10-20 · 개정 1 (사용자 결정 반영 + 기존 기능 영향 점검 §12 추가) · 상태: **구현 완료 (2026-10-20, §13) · 미커밋 · 세로 템플릿 기본 교체는 배포 후**
> 대상: 신규 페이지 `/newOrderV` (newOrderVirtual.html) · routes/rkAllocate.js(신규) · rkShipScan · rkLabel · rkInbound · mobileInbound.html · label-service
> 전제 설계: docs/plan-shipping-list.md(rk_shipping_list) · plan-virtual-scan.md(가상스캔) · plan-ship-scan.md(박스)
> **원칙**: 기존 화면(/newOrder · /stockPrepare · /inboundArrange · /shipScan · /virtualConfirm · 쉽먼트 · 모바일 [입고])의 동작은 바꾸지 않는다. 공용 코드를 손대는 곳은 §12 에서 하나씩 "기존 호출자에게 달라지는 것이 없는지" 를 적는다.

---

## 0. 한 줄 요약과 운영 흐름

기존에는 **재고**(신규발주서 위치→준비)와 **입고**(입고정리 출고준비)를 두 화면에서 따로 배정했다.
가상버전 페이지는 발주서를 고르고 **재고·입고(입고코드별)를 한 번에 배정**한 뒤, 같은 화면에서 **가상스캔(다중) → 세로 박스라벨**까지 이어 간다.
모바일 입고는 첫 화면에서 **[전체]**(발주서 하나의 재고+입고 전부) / **[입고]**(기존 입고코드 방식) 중 하나로 들어간다.

```
[+발주서등록] ─▶ [배정](모달: 발주서·출처·순서 선택 → 계산 → 확정=저장) ─▶ [가상스캔](다중) ─▶ [박스라벨](세로)
                                                                                      │
          라벨 붙이고 찾기: 모바일 [전체] 또는 [입고] ─▶ 가상확정 ─▶ 발주서확정 ─▶ 순서저장 ─▶ CJ ─▶ 쉽먼트
```

> **용어**: 이 페이지에서는 '위치' 대신 **'배정'** 으로 부른다. (재고 위치 + 입고 분량을 함께 잡는 동작이라 '위치' 로 부르면 헷갈림)

### 결정 사항 (2026-10-20 사용자 확정)

| # | 결정 |
|---|---|
| D1 | 페이지 기반 = **신규 발주서(rk_new_orders) 표 + 등록 배지**. 흐름은 **등록 → 배정**. 배정·가상스캔·박스라벨은 등록된 발주서만 |
| D2 | 세로 라벨 템플릿을 **기본으로 교체**(용지 60×80 mm 가정 — §6-1) |
| D3 | **[준비] 버튼 없음** — 배정 모달의 [확정]이 저장을 겸한다 |
| D4 | 우선 순서는 **매번 선택** — `입고 → 재고` / `재고 → 입고` 두 가지(기본값 없음) |
| D5 | 기존 입고정리 [출고준비]에도 L3 수정 **적용**(별도 커밋). 남은 수량 = 원본 − 배정 − 재고확정(rk_cn_stock_arranges). 이미 저장된 배정은 무변경 |
| D6 | 모바일 [전체] 목록 = **가상 박스가 있는 발주서만** |
| D7 | **배정 취소** UI 필요 — 위치 열 hover 팝오버의 [배정 취소] |
| D8 | 라벨 출처 줄 = 이름만(`❷ 재고 · 1011`), 개수 포함 문자열은 필드로만 제공 |
| D9 | 입고 배정의 위치 표기 = **`입고코드-박스명`** (예 `1011-BR3`) — 표·hover·모바일 칩·라벨 출처 모두 같은 형식 |
| D10 | 세로 라벨 용지 = **60×80 mm** 로 진행(현재 템플릿 80×60·90도 회전에서 추정). 실제 치수가 다르면 템플릿 숫자만 수정 |

---

## 1. 조사 결과와 논리 점검 (설계의 근거 — 반드시 읽을 것)

### 1-1. 지금 데이터 (2026-10-20 조회)

| 항목 | 값 | 의미 |
|---|---|---|
| rk_new_orders(신규 발주서) | 20건 · **20건 전부 rk_orders 에도 존재** | 등록 RPC(`rk_register_neworders`)는 **복사만** 하고 신규 행을 지우지 않는다 |
| 진행중 rk_orders | 70건 | 가상스캔·입고배정·라벨·모바일은 전부 **rk_orders 기준** |
| 진행중/신규 상품행 확정수량 = 발주수량 | **100 %** (1,126 / 414행) | 배정 목표를 확정수량으로 잡아도 지금 데이터에선 차이 없음 |
| rk_shipping_list 출고예정 | 재고 8,264 · 입고 6,088행 | 입고 미러(cn_shipping_id) 누락 **0건** → rk_cn_shipping 행마다 미러 행이 있다 |
| 재고건 location 비어 있음 | 0건 | 위치 표시 안전 |
| 재고확정(rk_cn_stock_arranges)된 아이템 | **3,059건 / 20,771개** | 그중 **3,058건이 기존 출고준비 계산식에서는 "남은 수량 20,771개" 로 보임** (§1-2 L3) |
| 박스 라벨 템플릿 | "박스 라벨 (기본)" 80×60 · **print_rotate 90** · ZPL 203dpi · 기본 | 가로로 디자인해 돌려 찍는 중 → 세로 템플릿 신설·기본 교체 |

### 1-2. 발견한 논리 오류 / 모순 — 이번 설계에서 어떻게 처리하는지

| # | 문제 | 어디서 | 처리 |
|---|---|---|---|
| **L1** | **신규 발주서(rk_new_orders)는 가상스캔·입고배정·박스라벨·모바일 어디에도 안 잡힌다.** `loadOrderScanState`·`saveShipState`·`/api/inbound/prepare`·`/api/label/order-boxes` 모두 `rk_orders` 를 찾는다 | rkShipScan.js `S.getOrderId('rk_orders')`, rkInbound.js prepare | (D1) 표는 신규 발주서를 보여주되 행마다 **등록 배지**. 배정 모달에 미등록 발주서는 빨간 "등록 필요" + [등록 후 계속] 버튼(기존 `/api/neworders/register` 호출, 사용자가 눌러야 진행). 가상스캔·박스라벨도 미등록 발주서는 건너뛰고 토스트로 알림 |
| **L2** | **소진량 계산이 두 경로에서 다르다.** 입고 prepare = `확정 − max(예약, 스캔)`, 재고 stock-allocate(excludeShipScan) = `발주 − 예약 − 스캔`(더함 → 예약된 물건을 스캔하면 이중차감) | rkShippingList.js:106, rkInbound.js:561 | 통합 배정은 **한 가지 규칙** `needed = 확정수량 − max(기존예약(재고+입고 출고예정), 출고스캔 합)`. 기존 두 화면 코드는 무변경 |
| **L3** | **기존 입고 출고준비가 '재고로 넘긴 분량(rk_cn_stock_arranges)' 을 안 뺀다.** 두 공식이 다르다: 재고정리 화면 남은상품 = `원본 − 출고 − 재고원장`(stock-arranges), 출고준비 내부 남은수량 = `원본 − 출고`(prepare:571). 데이터로 확인: 재고확정된 아이템 3,059건 중 **3,058건(20,771개)이 출고준비 쪽에서는 아직 남은 것으로 계산**된다 → 그 입고코드로 [출고준비]를 다시 돌리면 **선반에 올라간(rk_stocks 에도 있는) 물건을 입고분으로 또 배정**할 수 있다. (사용자 질문 "입고건에서 남은상품으로 계산되는 게 아니냐" → 재고정리 **화면**은 그렇게 계산하지만, **출고준비 API 는 재고원장을 보지 않는다**) | rkInbound.js:571 `remaining = total − allocatedByItem` | 통합 배정의 입고 가용 = **원본 − Σrk_cn_shipping − Σrk_cn_stock_arranges**(재고정리 화면과 같은 공식). 기존 prepare 도 같은 공식으로 수정(D5 확정, 별도 커밋) — 바뀌는 것은 "재고확정 끝난 분량은 출고준비를 다시 돌려도 더 배정되지 않는다" 하나. §12-11 |
| **L4** | 입고 미러링이 try/catch 라 실패하면 rk_shipping_list 에 입고 행이 없다. 가상스캔·모바일 [전체]·배정 needed 가 전부 rk_shipping_list 를 읽으므로 조용히 어긋남 (지금은 누락 0건) | rkInbound.js:632 | 통합 배정 저장은 **Postgres RPC 한 번**으로 rk_cn_shipping + rk_shipping_list + rk_stocks 차감 + 이력을 **한 트랜잭션**에 쓴다(§8). 실패하면 전부 롤백 |
| **L5** | 모바일 칩 배정 `assignVirtualBoxes` 가 `virtual_codes` 의 **'재고' 키를 버린다**. 재고 행에는 칩이 안 붙는다 | rkInbound.js loadVirtualBoxes | [전체] 모드 전용 조회 함수에서 '재고' 키도 코드로 다룬다. **[입고] 모드 함수는 그대로**(§12-5) |
| **L6** | 모바일 찾음(mobile_*)이 **rk_cn_shipping 에만** 있다. 재고 행은 기록할 곳이 없고 `mobileFoundByKey`(가상확정 ✅ 통합 규칙)도 입고만 센다 | rkShared.js:302 | `rk_shipping_list` 에 `mobile_status/mobile_at/mobile_by` 추가. 입고 행은 **두 테이블에 같이** 기록, 재고 행은 rk_shipping_list 만. `mobileFoundByKey` = rk_cn_shipping(found) ∪ rk_shipping_list(**source='재고'**, found) — 입고를 두 번 세지 않음 |
| **L7** | 일괄 가상스캔 API 는 **입고코드 1개**만 받는다 | rkShipScan.js virtual-batch | `inboundCodes:[…]` 배열 허용(계산기는 이미 배열 지원). 기존 `inboundCode` 호환 |
| **L8** | 박스 라벨에 "찾아야 할 곳" 정보가 없다. 출처는 `virtual_codes` 로만 알 수 있고 **실제 스캔으로 담긴 행은 출처 기록이 없다** | rkLabel.js | 라벨 출처 = 박스 안 virtual_codes 키 합집합. 가상 0 박스는 출처 칸 빈 칸·개수 0 |
| **L9** | 동시 배정 잠금이 없다(기존 두 화면도 동일) | 전체 | RPC 안에서 `rk_stocks … for update` + 재검증, 모자라면 그 호출 전체 거부·재계산 안내 |
| **L10** | 가상스캔 목표 = `min(배정, 확정)` — 배정 목표도 확정수량이어야 일관 | — | 배정 목표 = **확정수량**(지금 데이터는 확정=발주 100 %) |

### 1-3. 바꾸지 않는 것 (무변경 원칙)

- `/newOrder` · `/stockPrepare` · `/inboundArrange`(출고준비는 D5 의 남은 수량 공식 한 줄만 수정) · `/shipScan` · `/virtualConfirm` · 쉽먼트 — 코드 경로 무변경. 새 페이지와 새 API 만 추가.
- `rk_cn_shipping` 은 여전히 입고 배정의 원본. 새 배정도 여기에 쓰고 rk_shipping_list 에 미러(트랜잭션).
- 모바일 **[입고]** 모드 = 지금 mobileInbound 2·3화면 그대로(이름 입력만 첫 화면으로).
- 공용 함수를 고칠 때는 **기존 호출자의 입력·출력이 그대로** 인지 §12 로 확인한다.

---

## 2. 메뉴 · 라우트 · 파일

| 항목 | 내용 |
|---|---|
| 헤더 드롭다운 (header.html) | 발주서 ▸ **신규 발주서** `/newOrder` · **신규 발주서 가상버전** `/newOrderV` · **전체 발주서** `/rocket`. `data-path` 에 `/newOrderV` 추가 |
| 페이지 | `newOrderVirtual.html` (newOrder.html 복제 후 개편) · server.js `app.get('/newOrderV')` |
| 서버 | `routes/rkAllocate.js` **신규** · rkShipScan(virtual-batch 배열) · rkLabel(필드 추가) · rkInbound(모바일 [전체] API, mobile-check 미러) · rkShared(mobileFoundByKey 확장) |
| 순수 로직 | `allocPlan.js` **신규**(DOM·DB 없는 배정 계산기, virtualPack.js 와 같은 UMD) · `tests/allocPlan.test.js` |
| DB | `supabase/rk_allocate.sql`(rk_shipping_list mobile 열 + RPC `rk_allocate_save`) · label-service `supabase/005_box_label_portrait.sql` |
| label-service | `lib/labelTypes.ts` BOX_FIELDS 추가 · `lib/careSymbols.ts` 박스 아이콘 · locales ko/zh · README 4-1 |

---

## 3. 화면 (`/newOrderV`)

### 3-1. 버튼 줄 (D3: [준비] 없음)

```
[전체보기] [배정] [가상스캔] [박스라벨] [엑셀] [인쇄] [삭제]                       [+발주서등록]
```
- [전체보기] 기존과 동일(슬라이드에서 발주서·날짜 토글 → 검색 필터).
- [배정] → §4 모달(계산 → [확정]=저장). [가상스캔] → §5. [박스라벨] → §6.
- [엑셀]/[인쇄]/[삭제]/[+발주서등록] = newOrder.html 기존 기능 그대로.
- 대상 행 규칙 = 기존과 동일: 체크한 행이 있으면 그 행, 없으면 **보이는 행 전체**.

### 3-2. 표

| 열 | 내용 |
|---|---|
| 발주번호 | 옆에 **등록 배지**: 초록 `등록` / 회색 `미등록` / 회색 `완료`(DONE) |
| 입고예정일 · 물류센터 · 상품명(모델 배지) · 바코드 · 발주수량 · 확정수량 | 기존 |
| **재고** | 재고 배정 합(저장분) |
| **입고** | 입고 배정 합(저장분) |
| **위치** | **`첫 항목 외 N건`** 한 줄. 재고 항목 = `LO-A-3`(위치-수량), 입고 항목 = **`1011-BR3-4`**(입고코드-박스명-수량, D9). 첫 항목 = 배정 순서상 첫 번째. hover 팝오버에 전부: `LO-A ×3 · LO-B ×2 · 1011-BR3 ×4` + **[배정 취소]**(D7, §4-4). 항목 하나면 그대로 한 줄. 재고 검정 / 입고 파랑 |
| **박스** | 출고스캔 박스 칩(입고정리·재고준비와 같은 규칙 📦1 👾/🔀/✅) — `/api/ship-scan/box-map` |
| 스캔수량 | rk_ship_box_items 합(scanned-map) |

- 진입 시 `GET /api/allocate/status?orderNumbers=…` 로 **보이는 발주번호만** 저장분 조회.

---

## 4. [배정] — 모달과 알고리즘

### 4-1. 모달 (중앙, 2단)

```
┌ 배정 · 발주서 선택 ─────────────────────────────────────────────────────── ✕ ┐
│ 왼쪽: 발주서 목록 (날짜 › 센터 › 발주번호, 전체선택 기본)                          │
│   ☑ 144532746 (38)  대구3  [등록]     ☐ 144540001 (12) 고양 [미등록] [등록 후 계속]   │
│ 오른쪽: 출처 (하나 이상)                                                        │
│   ☑ 재고 (rk_stocks)              가용 바코드 231종                                │
│   ☑ 입고  ☐ 1007 (남은 12종 40개)  ☑ 1011 (남은 88종 412개)  ☐ 1015 (…)            │
│   순서:  ( ) 입고 → 재고    ( ) 재고 → 입고        ← 기본값 없음, 골라야 [계산] 활성   │
│ ──────────────────────────────────────────────────────────────────────────── │
│ [계산] → 결과 표: 발주번호·상품·확정·기예약·스캔·필요·재고배정(위치)·입고배정(코드-박스)·부족 │
│   요약: 발주서 5건 · 상품 120행 · 필요 612 → 재고 380 + 입고 196 · 부족 36           │
│                                                            [취소]  [확정 — 저장]    │
└──────────────────────────────────────────────────────────────────────────────┘
```
- 입고코드 칩의 "남은 n종 m개" = 선택 발주서 바코드와 겹치는 아이템의 남은수량(§4-2 ⑤, L3 공식)만 센다.
- 출처 하나만 고르면(재고만 / 입고만) 순서 선택은 비활성(의미 없음).
- **순서는 매번 고른다**(D4). `입고 → 재고`: 들어온 물건을 선반에 올리지 않고 바로 내보냄. `재고 → 입고`: 선반 재고 소진 우선.
- [계산]은 읽기만. [확정]은 **그 시점 DB 로 다시 계산해 저장**(미리보기를 그대로 쓰지 않음 — virtual-batch 와 같은 규칙). 재계산 결과가 미리보기와 다르면(다른 PC 가 먼저 배정) 저장 후 "미리보기와 n행 달라짐" 토스트.

### 4-2. 계산 규칙 (`allocPlan.js` 순수 함수 + 서버 조회)

**입력 수집(서버)**
1. 발주서: 선택 발주번호 중 **rk_orders 에 있고 DONE 아닌 것**만. 상품행 = 원본(박스정보 없음) 바코드별 확정수량 합.
2. 기예약: `rk_shipping_list` status='출고예정' 를 발주번호+바코드로 합(재고+입고).
3. 출고스캔: `rk_ship_box_items` 발주번호+바코드 합.
4. 재고 풀: `rk_stocks`(바코드 in) → (바코드, 위치, qty>0, stock_id). 준비 시 즉시 차감 구조라 예약 재차감 없음(기존과 동일).
5. 입고 풀: 선택 입고코드의 `rk_cn_shipment_items`(바코드 in) → **남은 = quantity − Σrk_cn_shipping.ship_qty − Σrk_cn_stock_arranges.qty**(L3). 0 이하 제외. shipment_code·box_name·pallet 보존.
   - 즉 입고정리 [출고준비]와 같이 **그 코드의 남은 상품만** 발주서에 나눠 준다. 아직 재고정리를 하지 않은 코드(예: 새로 들어온 1018)는 두 공식의 결과가 같다. 차이는 일부를 재고확정한 코드에서만 생기며, 그때 선반에 올라간 분량은 입고가 아니라 **재고 출처**(rk_stocks)로 배정된다.

**배정 순서**
6. 발주서 순서 = **입고예정일 오름차순 → 발주번호**(입고 prepare FIFO 와 동일). 발주서 안은 화면 행 순서.
7. 행마다 `needed = 확정수량 − max(기예약, 스캔)`(L2). 0 이하면 건너뜀(사유 '이미 배정' / '이미 스캔').
8. 고른 순서의 첫 출처부터 채우고 모자라면 둘째 출처. 선택 안 된 출처는 건너뜀.
9. **입고 풀 안의 순서**: 입고코드 오래된 순(코드 문자열이 날짜라 숫자 정렬) → 같은 코드는 **팔렛·박스명 순**(팔렛을 차례로 열도록) → 아이템 id. 같은 바코드가 여러 박스에 있으면 **한 박스에서 다 채울 수 있는 박스 우선**, 없으면 큰 박스부터.
10. **재고 풀 안의 순서(동선)** — 바코드마다 후보 위치를 점수로:
    1. 필요량을 **한 위치에서 다 채울 수 있는 위치** 우선(분할 최소).
    2. 그중 **같은 발주서가 이미 쓴 구역**(위치 문자열의 첫 `-` 앞, 예 `LO`)과 같은 구역 우선.
    3. 그래도 같으면 위치 오름차순(기존 규칙, 멱등).
    4. 한 곳에서 못 채우면 가장 많은 위치부터 채워 분할 수를 줄인다.
    - 규칙·상수는 `allocPlan.js` `CONFIG` 한 곳. 구역 순회 순서 배열은 창고 체계가 정리되면 추가.
11. 같은 바코드는 발주서들 사이에 **풀을 공유**(먼저 온 발주서가 먼저 가져감). 부족 수량·사유 기록.

**출력**
```js
{ rows:[{ orderNumber, barcode, confirmedQty, reserved, scanned, needed,
          allocs:[{ source:'재고', location, stockId, qty } | { source:'입고', shipmentId, shipmentItemId, code, boxName, qty }],
          shortage }],
  summary:{ orders, rows, needed, stock, inbound, shortage },
  excluded:[{ orderNumber, reason:'미등록'|'처리완료' }] }
```

### 4-3. 저장 (RPC `rk_allocate_save(jsonb)` — 한 트랜잭션, L4·L9)

1. 재고: `rk_stocks` 대상 행 `for update` → `qty ≥ take` 재검증(모자라면 **전체 롤백**, 모자란 바코드·위치 반환 → 화면 "재계산하세요") → `rk_shipping_list`(source='재고', location, stock_id, batch_no, prepared_at) insert → `rk_stocks.qty −= take` → `rk_stock_histories`(change_type 'deduct', note '가상버전 배정').
2. 입고: `rk_cn_shipment_items` 행 잠금 → 남은수량(L3 공식) 재검증 → `rk_cn_shipping` insert(batch_no = 그 출고코드 max+1, prepared_at) → 같은 id 로 `rk_shipping_list`(source='입고', cn_shipping_id, shipment_id, shipment_item_id, batch_no, prepared_at) insert.
3. 회차: 재고건 = 재고 max+1(재고준비 체계), 입고건 = 출고코드별 max+1(입고정리 체계) → 두 기존 화면의 "최신 회차 NEW" 가 그대로 동작.
4. 반환 `{ savedStock, savedInbound, batchStock, batchByCode:{코드:회차} }`.
- 멱등: 같은 선택으로 다시 [확정]해도 needed 가 0 → 추가 저장 없음.

### 4-4. 배정 취소 (D7)

- 위치 열 hover 팝오버의 **[배정 취소]**(행 단위 = 발주번호+바코드의 저장분 전부, 항목별 체크로 일부만도 가능).
- `POST /api/allocate/cancel { orderNumber, barcode, listIds? }` → 재고 행은 기존 `stock-cancel` 로직(rk_shipping_list 삭제 + rk_stocks 복원 + 이력), 입고 행은 기존 `inbound/shipping/delete` 로직(rk_cn_shipping 삭제 + 미러 삭제). 두 기존 핸들러의 본문을 함수로 빼서 재사용(기존 라우트는 그 함수를 부르도록 — 동작 동일).
- **이미 가상스캔으로 박스에 담긴 분량이 있으면 거부**: 그 발주번호+바코드의 `rk_ship_box_items.virtual_qty` 합 > 0 이면 "출고스캔에서 박스를 먼저 비우세요". (가상 분량의 근거가 사라지는 것을 막음)

---

## 5. [가상스캔] — 다중 처리

- 대상 = 체크한 행(없으면 보이는 행)의 **발주번호(중복 제거, 등록·진행중만)**.
- 모달 = 입고정리 `openVirtualBatch` 이식. 옵션 **기본값 없음**:
  - 기존 박스: 채우기 / 새 박스만
  - 대상: 전체 / 입고 / 재고
  - 입고코드: 선택 발주서의 배정에 있는 코드들을 칩으로(`allocInboundByCode` 합) — **복수 선택**. 대상 '재고' 면 비활성.
- 서버 `virtual-batch` 에 `inboundCodes:[…]`(L7). 전체+여러 코드면 한 박스에 코드가 섞일 수 있음 → 결과 표 박스별 `codes` 표시, 섞인 박스 경고 배지(이미 `virtualCodes` 로 DB 에 남는다).
- 확정 후 박스 열 갱신.

---

## 6. [박스라벨] — 세로 템플릿

### 6-1. 용지·방향 (D2)
- 현재 80×60 + print_rotate 90 → 실제 용지는 **세로 60(가로)×80(세로)** 로 추정. 새 템플릿 **width 60 · height 80 · print_rotate 0**.
- label-service `supabase/005_box_label_portrait.sql`: **"박스 라벨 (세로)"** insert, `is_default=true`; 기존 "(기본)" `is_default=false`(삭제 안 함 — 드롭다운에서 선택 가능). `box_per_order=false`.
- 영향: 쉽먼트·발주서 관리·입고정리의 [박스라벨출력]도 **기본이 세로 템플릿으로 바뀐다**(사용자 승인). 프린터 지정은 템플릿별로 기억되므로(`label_printer_map_v1`) 새 템플릿은 **PC 마다 한 번** 프린터를 다시 고른다 — 임베드 모달이 안내.

### 6-2. 양식 (위→아래, mm)

```
┌──────────────────────── 60 ────────────────────────┐
│ 144532746                              (발주번호, 굵게 22pt)   y 2
│ [□] 1 · 12개                       (박스 아이콘 + 박스번호 · 개수, 18pt)  y 13
│ 1016 · 대구3                            (입고예정일 월일 · 센터, 14pt)  y 23
│ ❷ 재고 · 1011                   (찾을 곳 개수(흑백 원) + 출처들, 굵게 16pt, 2줄까지)  y 32
│
│ ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌                    (Code128 bx_order_box, 높이 11, narrow 2)  y 52
│ 144532746 - 1                                                 (사람 읽는 숫자 8pt)
│ 1/3 · 중                                   (순번 · 크기, 8pt)  y 73
└────────────────────────────────────────────────────┘  80
```
- 출처 줄이 2줄이 되면 바코드 높이를 9mm 로 — 템플릿 편집기에서 조정.
- **숫자+동그라미(흑백)**: 유니코드 흑원 숫자 `❶❷…❿`(U+2776~) · `⓫…⓴`(U+24EB~)를 텍스트로. 캔버스 → 1비트 비트맵이라 글꼴 대체로도 깨끗. 0 이면 빈 칸. (2안: BoxElement `shape:'ellipse'` — 코드 변경 큼)
- **박스 이모지 📦**: 컬러 이모지는 1비트 변환 시 뭉개짐 → `careSymbols.ts` 에 선화 SVG `box` 심볼 추가, 이미지 요소 6×6mm.

### 6-3. 호스트 필드 추가 (rkLabel.js `order-boxes`, L8 · D9)

| 필드 | 값 | 예 |
|---|---|---|
| `bx_source_count` | 박스 안 `virtual_codes` 키 종류 수('재고' 포함) | `2` |
| `bx_source_badge` | 흑원 숫자 | `❷` |
| `bx_sources` | 재고 먼저, 입고코드 오름차순 | `재고 · 1011` |
| `bx_sources_qty` | 출처별 개수 | `재고 8 · 1011 4` |
| `bx_sources_line` | 배지 + 출처 (템플릿 요소로 쓰는 값, D8) | `❷ 재고 · 1011` |
| `bx_inbound_boxes` | 입고 분량의 `입고코드-박스명` 목록(그 박스의 입고 바코드가 배정된 rk_cn_shipping 박스명, 중복 제거) | `1011-BR3 · 1011-BR7` |

- 박스 출처 = 그 박스 `rk_ship_box_items.virtual_codes` 합산. 가상 0(실제 스캔) 박스 → 0 / 빈 문자열.
- `bx_inbound_boxes` 는 라벨에 넣을지 선택(기본 양식에는 넣지 않음 — 길어질 수 있어 모바일 카드가 담당).
- label-service: `BOX_FIELDS` 6개 추가 · 샘플 데이터 · locales ko/zh · README 4-1. 검증 `npm run type-check`.
- 기존 `skipPrinted`·`noBox` 규칙 그대로.

---

## 7. 모바일 입고 개편 (`/mobileInbound`)

### 7-1. 화면 흐름

```
1화면  [본인 이름 ______]      (localStorage 유지)
       [ 전체 ]   [ 입고 ]      ← 큰 버튼 2개 (이름 없으면 토스트)

[입고] → 1-b: 연/월/입고코드 휠 (지금 1화면에서 이름만 뺀 것) → [다음] → 기존 2화면 → 3화면
[전체] → 2-a: [발주번호 입력] [📷] [진행] + (아래) 가상 박스 목록(§7-3) → 3화면
```
- 휠 핸들러 주의(표시 중에만 바인딩, `active.code` 스냅샷)는 1-b 로 옮겨 그대로 유지.
- 3화면 카드·[없음][✓ 스캔]·박스 크기 변경·섞임 확인 모달은 공용. `mode:'inbound'|'all'` 로 **데이터 소스·저장 API 만** 갈린다.

### 7-2. [전체] 모드 카드

- 행 = 그 발주서의 `rk_shipping_list` status='출고예정' **전부(재고+입고)**.
  - 재고 행: 꺼내는 곳 칩 = 위치 `LO-A`, 보조 `재고`.
  - 입고 행: 꺼내는 곳 칩 = **`1011-BR3`**(D9), 보조 `중국번호`(shipment_item_id 조인).
- 순서(동선): 박스 번호 → 출처(입고 먼저 = 가상스캔이 담는 순서) → 입고코드 → 박스명 / 위치 오름차순 → id.
- 담는 곳 칩 = [전체] 전용 `assignVirtualBoxesAll`('재고' 키 포함, L5). 재고 행은 virtual_codes 의 `재고` 분량에서, 입고 행은 그 코드 분량에서, 미기록분은 앞에서부터.
- `발주번호-박스번호` 스캔이면 그 박스 몫 행만(기존 boxNo 규칙). 섞임 모달은 **입고코드 둘 이상 또는 재고+입고 섞임**이면 띄움(문구 "출처 확인").

### 7-3. [전체] 목록 (D6)

- `GET /api/mobile/all-orders` → 진행중(DONE 아님) 발주서 중 **가상 박스(virtual_qty>0)가 있는 것**을 (발주서, 박스) 단위로 — mobile-orders 와 같은 모양(총/찾음/없음, 개수·kg, 크기, 섞임). "박스 미정" 줄 동일.
- 정렬: 입고예정일 → 센터 → 발주번호 → 박스번호.

### 7-4. 저장 (L6)

- `POST /api/mobile/check { listId, status, worker }`(전체 모드, `rk_shipping_list.id`):
  - source='재고' → rk_shipping_list.mobile_* 만.
  - source='입고' → rk_shipping_list.mobile_* **+** rk_cn_shipping(cn_shipping_id).mobile_* 둘 다(PC 입고정리 '모바일' 열 그대로 보임).
- 기존 `POST /api/inbound/mobile-check`([입고] 모드): rk_cn_shipping 갱신(기존) 뒤 `rk_shipping_list where cn_shipping_id=allocId` 도 갱신. **미러 갱신 실패·0행은 로그만** — 기존 응답·성공 조건은 그대로(§12-4).
- `S.mobileFoundByKey` = rk_cn_shipping found(입고) + rk_shipping_list found **where source='재고'** → `virtualReadiness` 가 재고까지 포함. 박스 라벨 skipPrinted·가상확정 페이지·쉽먼트 ✅ 자동 반영.

---

## 8. DB 변경 (supabase/rk_allocate.sql — 적용은 구현 단계에서 사용자 확인 후)

```sql
-- 1) 모바일 찾음을 재고 행에도 (입고 행은 rk_cn_shipping 과 이중 기록)
alter table rk_shipping_list
  add column if not exists mobile_status text check (mobile_status in ('found','missing')),
  add column if not exists mobile_at timestamptz,
  add column if not exists mobile_by text;
create index if not exists rk_shipping_list_mobile_idx on rk_shipping_list (order_number) where mobile_status = 'found';

-- 2) 통합 배정 저장 RPC (한 트랜잭션)
--    입력: {stock:[{orderNumber,center,shippingDate,barcode,productName,stockId,location,qty}],
--           inbound:[{orderNumber,center,shippingDate,barcode,productName,shipmentId,shipmentItemId,qty}]}
create or replace function rk_allocate_save(p jsonb) returns jsonb language plpgsql as $$
  -- for update 잠금 → 재검증(rk_stocks.qty ≥ take / 입고 남은수량(L3) ≥ take) → insert → 차감 → 이력
  -- 모자라면 raise exception → 전체 롤백 (서버는 400 으로 전달)
$$;
```
- label-service: `005_box_label_portrait.sql` — 세로 템플릿 insert(layout = §6-2 좌표), 기존 기본 해제.
- 적용: immong-rocket(bzufmxzjanhihxahyvhb) `apply_migration`. 사본은 두 저장소 supabase/ 에.

---

## 9. API 목록

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/allocate/sources?orderNumbers=` | 모달 오른쪽: 재고 가용 종수 · 입고코드별 남은 종수/개수(L3) · 발주서별 등록/DONE |
| `POST /api/allocate/run` | `{ orderNumbers, sources:{ stock:bool, inboundCodes:[…] }, order:['입고','재고']|['재고','입고'], save:bool }` → §4-2 결과. save 면 RPC 저장 후 결과+회차 |
| `GET /api/allocate/status?orderNumbers=` | 표 채우기: 발주번호+바코드별 저장분 `[{listId, source, location | code+boxName, qty, batchNo}]` + 스캔 합 |
| `POST /api/allocate/cancel` | `{ orderNumber, barcode, listIds? }` → 재고 복원 + 입고 삭제(가상 박스 분량 있으면 거부) |
| `POST /api/ship-scan/virtual-batch` | `inboundCodes:[…]` 추가(기존 `inboundCode` 호환) |
| `POST /api/label/order-boxes` | 응답 data 에 `bx_source_*`·`bx_sources*`·`bx_inbound_boxes` 추가 |
| `GET /api/mobile/all-orders` · `GET /api/mobile/all-list?orderNumber=&boxNo=` · `POST /api/mobile/check` | 모바일 [전체] |
| `POST /api/inbound/mobile-check` | (변경) rk_shipping_list 미러 기록 추가(실패해도 기존 응답) |

---

## 10. 구현 순서와 검증

| 단계 | 작업 | 검증 |
|---|---|---|
| 1 | `allocPlan.js` + `tests/allocPlan.test.js`(needed 규칙, 순서, 동선 점수, 공유 풀, 멱등, L3) | `node tests/allocPlan.test.js` |
| 2 | DB: rk_shipping_list mobile 열 + RPC | 샘플 저장/모자람 롤백 확인 |
| 3 | `routes/rkAllocate.js` 4개 API | 로컬 3004 curl → 결과·저장·회차·취소. 저장 후 **/stockPrepare 예정 탭·/inboundArrange 출고리스트에 새 회차로 보이는지** |
| 4 | `newOrderVirtual.html` + 헤더/라우트 | 미등록 차단, 계산→확정, 새로고침 후 저장분, 위치 '외 N건'·hover·취소 |
| 5 | virtual-batch `inboundCodes[]` + [가상스캔] 모달 | 발주서 2건·코드 2개 확정 → 박스 칩·virtual_codes. **입고정리의 기존 일괄 가상스캔(코드 1개) 결과 동일** |
| 6 | rkLabel 필드 + label-service + 세로 템플릿 SQL + [박스라벨] | `npm run type-check`, 임베드 미리보기. 쉽먼트 [박스라벨출력]이 세로로 나오는지 |
| 7 | 모바일: 1화면 분기, [전체] API, mobile-check 미러, `assignVirtualBoxesAll`, `mobileFoundByKey` | 폰 375px 전체/입고 양쪽 → 입고정리 '모바일' 열·가상확정 ✅. **[입고] 모드 기존 동작 동일** |
| 8 | **D5**: rkInbound.js prepare 남은 수량에 rk_cn_stock_arranges 차감 추가(별도 커밋) | 재고확정 끝난 코드로 [출고준비] 재실행 → 신규 배정 0건. 재고확정 없는 코드 → 결과 전과 동일 |
| 9 | 메모리·docs 갱신 | — |

- virtualPack 테스트 31건 그대로 통과(계산기 무변경, 옵션만 추가).

---

## 11. 남은 결정

없음 — D1~D10 확정(2026-10-20). 구현 시작 가능.

---

## 12. 기존 기능 영향 점검 — 공용 코드를 건드리는 곳마다 "달라지는 것이 없는지"

| # | 바꾸는 것 | 기존 호출자 | 달라지는 점 | 판정 |
|---|---|---|---|---|
| 12-1 | `rk_shipping_list` 열 3개 추가 | `GET /api/shipping-list`(newOrder·stockPrepare), stock-allocate, stock-cancel, prepare 미러 | 모두 열을 이름으로 골라 읽거나 insert 시 생략 → NULL. 응답 매핑에 새 열 없음 | 영향 없음 |
| 12-2 | `S.mobileFoundByKey` 에 재고 found 합산 | rkShipScan box-map·virtual-boxes·box·scanned-map, rkOrdersExtra 가상확정, rkLabel skipPrinted | found 가 **커질 수만** 있다(재고 행 찾음 추가). 입고 행은 rk_cn_shipping 에서만 세므로 이중 합산 없음. 결과: 재고 가상 상품도 모바일로 찾으면 ✅ — 의도한 확장. 재고 행을 아무도 찾지 않으면 지금과 100 % 동일 | 의도된 확장, 회귀 없음 |
| 12-3 | `virtual-batch` 에 `inboundCodes[]` | 입고정리 일괄 가상스캔(`inboundCode` 1개) | `inboundCode` 가 오면 `[inboundCode]` 로 감싼다 → 계산 입력 동일 | 영향 없음 |
| 12-4 | `/api/inbound/mobile-check` 에 미러 갱신 | 모바일 [입고] | rk_cn_shipping 갱신·404 조건·응답 그대로. 미러는 그 뒤에 try/catch(0행·오류는 로그) → **새 실패 경로 없음** | 영향 없음 |
| 12-5 | 모바일 칩 '재고' 키 | `loadVirtualBoxes`·`assignVirtualBoxes`·`mixedInboundCodes`([입고] 모드 mobile-orders/list) | **기존 함수는 그대로 두고** [전체] 전용 `loadVirtualBoxesAll`/`assignVirtualBoxesAll`/`mixedSourcesAll` 을 추가. [입고] 모드의 "입고일 섞임" 판정에 '재고' 가 끼지 않음 | 영향 없음 |
| 12-6 | `order-boxes` 응답 필드 추가 | 쉽먼트·rocket·입고정리 [박스라벨출력], label-service 바인딩 | 필드 추가만. 기존 템플릿은 모르는 필드를 무시 | 영향 없음 |
| 12-7 | 기본 박스 템플릿 교체(D2) | 위 세 페이지 | **기본 출력 양식이 세로로 바뀐다**(승인됨). 가로가 필요하면 임베드 드롭다운에서 "(기본)" 선택. 새 템플릿은 PC 마다 프린터 1회 재지정 | 의도된 변경 |
| 12-8 | 통합 배정이 rk_cn_shipping·rk_shipping_list 에 쓰기 | 입고정리 출고리스트·남은상품·모바일 [입고], 재고준비 예정 탭, 신규발주서 위치/준비 needed, 입고 prepare consumedMap·재고예약, 가상스캔 allocByBarcode | 모두 "저장된 배정 행" 을 읽는 쪽 → 새 행이 **다른 화면에서 저장된 것과 구분 없이** 보인다. 회차 체계도 각 화면 규칙과 같게 부여. 재고 즉시 차감·이력 note 만 다름('가상버전 배정') | 기존 로직과 동일한 데이터 형식 |
| 12-9 | 배정 취소가 기존 stock-cancel·shipping/delete 본문을 함수로 추출 | /stockPrepare [취소], /inboundArrange 배정 삭제 | 라우트는 추출한 함수를 호출 — 입력·응답 동일 | 리팩터만, 동작 동일 |
| 12-10 | 헤더 드롭다운 항목 추가 | 전 페이지 | 링크 1개 추가 | 영향 없음 |
| 12-11 | L2 규칙(max)은 **새 API 안에서만** · L3 규칙은 새 API + 기존 prepare(D5) | 기존 stock-allocate·prepare | stock-allocate 무변경. prepare 는 남은 수량 공식 한 줄만 바뀜: 재고확정(rk_cn_stock_arranges)이 있는 아이템만 배정 가능량이 줄고, 없는 아이템은 전과 동일. 이미 저장된 rk_cn_shipping 행·회차·미러는 건드리지 않음. 두 경로를 번갈아 써도 needed 는 서로의 저장분을 보므로 중복 배정 없음 | 의도된 수정(D5), 그 외 동일 |
| 12-12 | 신규 발주서 [+발주서등록]·[삭제]·[엑셀]·[인쇄] | /newOrder | 같은 API 재사용, 서버 변경 없음 | 영향 없음 |

---

## 13. 구현 결과 (2026-10-20)

| 단계 | 결과 | 검증 |
|---|---|---|
| 1 | `allocPlan.js` + `tests/allocPlan.test.js` | 17건 통과 (기존 virtualPack 42건도 통과) |
| 2 | `supabase/rk_allocate.sql` 운영 DB 적용 (rk_shipping_list mobile_* 3열 + `rk_allocate_save`) | 트랜잭션 안에서 실행 후 예외로 롤백: 정상 저장(재고 차감·이력·입고 배정·미러·회차), 입고 남은 수량 초과 / 확정수량 초과 / 미등록 발주서 / 없는 재고 위치 → 모두 거부 |
| 3 | `routes/rkAllocate.js` (sources · run · status · cancel), server.js 마운트 | 로컬 계산(save:false) 결과 확인. 저장·취소는 운영 데이터라 실행 안 함 (RPC 는 2에서 검증) |
| 4 | `newOrderVirtual.html` + `/newOrderV` + 헤더 메뉴 | 표·등록 배지·위치 "외 N건"·hover 팝오버·배정 모달 계산 확인 |
| 5 | virtual-batch `inboundCodes[]` (기존 `inboundCode` 그대로 받음) | 코드 2개 미리보기 확인 (저장 안 함) |
| 6 | rkLabel `bx_source_*`·`bx_sources*`·`bx_inbound_boxes` / label-service BOX_FIELDS·샘플·locales·`box_icon` 심볼·README / `005_box_label_portrait.sql` | `npm run type-check` 통과. 실제 가상 박스(144800624)로 `❶ 1011` · `1011-BR25 · 1011-BR30` 확인 |
| 7 | 모바일 0화면 [전체]/[입고], `/api/mobile/all-orders`·`all-list`·`check`, mobile-check 미러, `loadVirtualBoxes(…, {includeStock})`, `mobileFoundByKey` 재고 합산 | 375px 에서 두 모드 진입·카드·섞임 모달 확인. 저장은 빈 행 2건에 찾음 기록 → 되돌림으로 확인 |
| 8 | D5: 입고정리 [출고준비] 남은 수량 − 재고확정 | 모듈 로드 확인 (운영 저장이라 실행 안 함) |

### 계획과 달라진 점
- **세로 템플릿은 기본으로 바꾸지 않고 추가만 했다** (`박스 라벨 (세로)`, is_default=false). 운영 서버에 새 필드가 배포되기 전에 바꾸면 쉽먼트·입고정리 라벨이 바로 세로가 되고 PC 마다 프린터를 다시 골라야 해서. 배포 후 `005_box_label_portrait.sql` 의 2) update 를 실행하면 기본 교체. label-service 도 `box_icon` 심볼이 배포돼야 아이콘이 찍힌다.
- 표에서 상품번호·created_at 열을 빼고 **박스** 열을 넣었다 (가로 폭).
- 배정 취소 보호 규칙: 취소 후 남는 배정 ≥ 가상스캔 분량이면 허용 (전부 막지 않음).
- 모바일 [전체] 모드의 입고 행 찾음 상태는 rk_cn_shipping(원본)을 읽는다 — 예전에 [입고] 모드로 표시한 것도 그대로 보인다.
