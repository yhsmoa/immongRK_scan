# 재고정리 + 로케이션 분리 설계 계획

> 작성: 2026-07-10 · 대상: CN입고 재고정리 기능 + 상품관리 위치 정규화
> 사전 검증 완료: `rk_inventories` 11,302건 — **바코드 중복 0 · 빈 바코드 0** → 바코드를 유일 비즈니스 키로 사용 가능

---

## 0. 목표

1. 입고정리(남은상품) → **재고정리** 페이지로 데이터 넘기기 (새 테이블)
2. 위치(로케이션)를 `rk_inventories.location` 텍스트 컬럼에서 분리 → **`rk_inventory_locations` 테이블**로 정규화
3. 재고정리 페이지에서 바코드 기준으로 위치 join 표시
4. 앞으로 반복될 join 을 위한 **상품 식별 기준(canonical ID) 정립**

---

## 1. 식별 체계 (질문 주신 부분 — 정석 답)

**상품의 진실의 원천(master) = `rk_inventories` (상품관리)**

| 키 | 용도 |
|---|---|
| `rk_inventories.id` (PK) | DB 내부 FK 용 — locations 등 마스터에 **직접 종속**된 테이블 |
| `barcode` (**UNIQUE 제약 추가**) | 비즈니스 매칭 키 — 발주서/CN입고 등 **외부 업로드 데이터**와 연결 |

**원칙:**
- 마스터에 종속된 데이터(위치 등) → `inventory_id` FK (id 기준)
- 업로드로 들어오는 데이터(발주서 상품행, CN입고 아이템) → 마스터에 없는 상품이 있을 수 있으므로 FK 강제하지 않고 **barcode 텍스트 보존**, 조회 시점에 join
- 이렇게 하면 "업로드가 마스터에 막히는" 문제 없이, join 은 항상 `barcode → rk_inventories.id → 종속 테이블` 한 경로로 통일됨

바코드 중복이 0건이므로 `UNIQUE INDEX` 를 걸어 앞으로도 이 체계가 깨지지 않게 DB 레벨에서 보장한다.
(직접등록 API 는 이미 중복 체크함 / 엑셀 업로드 upsert 는 SKU 기준이므로 바코드 충돌 시 DB 가 막아줌 → 에러 메시지 처리 추가)

---

## 2. 새 테이블 2개

### 2-1. `rk_inventory_locations` (위치 정규화)

```sql
create table rk_inventory_locations (
  id           bigint generated always as identity primary key,
  inventory_id bigint not null references rk_inventories(id) on delete cascade,
  location     text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (inventory_id, location)          -- 같은 상품+같은 자리 중복 방지
);
create index on rk_inventory_locations(inventory_id);
create index on rk_inventory_locations(location);
```

- **1:N 구조** (한 상품이 여러 자리에 있을 수 있음 — 현재는 1개씩 마이그레이션, 확장 여지 확보)
- 마이그레이션: `rk_inventories.location` 이 `-`/빈값이 아닌 **9,827건**을 INSERT
- `rk_inventories.location` 컬럼은 **당분간 유지 + 이중기록(dual-write)** → 전환 안정 후 제거 (Phase 참고)

### 2-2. `rk_cn_stock_arranges` (재고정리)

```sql
create table rk_cn_stock_arranges (
  id               bigint generated always as identity primary key,
  shipment_id      bigint not null references rk_cn_shipments(id) on delete cascade,
  shipment_item_id bigint not null references rk_cn_shipment_items(id) on delete cascade,
  barcode          text,                   -- 위치 join 용 (아이템 스냅샷)
  qty              integer not null,       -- 재고정리 시점의 남은수량 스냅샷
  created_at       timestamptz not null default now(),
  unique (shipment_item_id)               -- 아이템당 1행 (재실행 = 갱신)
);
create index on rk_cn_stock_arranges(shipment_id);
create index on rk_cn_stock_arranges(barcode);
```

- 박스명/중국번호/상품명은 **저장하지 않고** `shipment_item_id` join 으로 표시 (중복 저장 금지 — 원본과 어긋날 일 없음)
- 재고정리 재실행 시: 해당 shipment 의 기존 행 **삭제 후 현재 남은상품으로 재삽입** (멱등)
- 출고코드 재업로드 시 items 삭제 → cascade 로 같이 정리됨 (`rk_cn_shipping` 과 동일한 수명 정책)

---

## 3. API (routes/rkInbound.js + rkInventory.js)

| 엔드포인트 | 동작 |
|---|---|
| `POST /api/inbound/stock-arrange` | body `{shipmentCode}` → 현재 남은상품(아이템수량−배정합계) 계산 → 기존 행 삭제 후 삽입 |
| `GET /api/inbound/stock-arranges?shipmentCode=` | arranges ⨝ items ⨝ shipments ⨝ (barcode→inventories⨝locations) → 출고코드·박스명·중국번호·상품명·수량·바코드·**위치** |
| (수정) `POST /api/inventory/update-location` 등 위치 쓰기 3곳 | **dual-write**: `rk_inventories.location` + `rk_inventory_locations` upsert 동시 기록 |

위치 쓰기 지점 (전수):
1. `update-location` (셀 클릭/일괄 위치저장)
2. `upload-locations` (엑셀업로드2)
3. `register` (직접 등록, 위치 입력 시)

---

## 4. UI

### 4-1. 입고정리 페이지 (`/inboundArrange`)
- 출고준비 버튼 옆 **[재고정리]** 버튼 추가
- 활성화 규칙: **남은상품 탭 + 출고코드 선택 시에만 활성** (그 외 disabled)
- 클릭 → `POST /api/inbound/stock-arrange` → 토스트 "재고정리 N건 저장" → 재고정리 페이지로 이동 여부는 토스트 안내만 (자동 이동 X)

### 4-2. 재고정리 페이지 (`/stockArrange`, 신규)
- 헤더 CN입고 드롭다운에 **재고정리** 추가 (입고리스트/입고정리/재고정리)
- 입고정리와 동일 골격: 연/월/출고코드 드롭박스 + 검색 + 인쇄
- 테이블: **출고코드 · 박스명 · 중국번호 · 상품명 · 수량 · 바코드 · 위치** (회차 없음)
- 위치: `barcode → rk_inventories.id → rk_inventory_locations` join, 복수 위치면 `,` 로 병기, 없으면 `-`

---

## 5. 실행 순서 (Phase)

| # | 작업 | 리스크 |
|---|---|---|
| 1 | `rk_inventories.barcode` UNIQUE 인덱스 (중복 0 확인됨) | 없음 |
| 2 | `rk_inventory_locations` 생성 + 9,827건 마이그레이션 (단일 SQL) | 없음 (읽기만) |
| 3 | 위치 쓰기 3개 API dual-write 전환 | 낮음 — 실패 시 기존 컬럼은 정상 |
| 4 | `rk_cn_stock_arranges` 생성 | 없음 |
| 5 | stock-arrange API 2개 + 입고정리 버튼 + 재고정리 페이지 + 메뉴 | 낮음 |
| 6 | 검증: 마이그레이션 건수 대조, 남은상품→재고정리 흐름, 위치 join, dual-write 일치 | — |
| 7 | (추후 별도 승인) 읽기 전환 → `rk_inventories.location` 컬럼 제거 | 상품관리/발주서 위치불러오기 영향 → **이번엔 안 함** |

**이번 작업에서 건드리지 않는 것:** 상품관리 화면의 위치 표시(기존 컬럼 그대로 읽음), `/api/inventory/locations` (발주서 위치 불러오기), importChina 전체.

---

## 6. 엣지 케이스

- 마스터에 없는 바코드의 남은상품 → 위치 `-` 표시 (join miss 허용, 에러 아님)
- 재고정리 후 출고준비를 또 하면 남은수량이 줄어듦 → 재고정리 스냅샷과 어긋날 수 있음 → 재고정리 **재실행으로 갱신**하는 운영 규칙 (버튼 재클릭 = 최신화)
- 재업로드 시 arranges cascade 삭제 → 재고정리 다시 실행 필요 (기존 shipping 과 동일 정책이라 일관적)
- dual-write 중 한쪽 실패 → 트랜잭션 아님(supabase-js) → 쓰기 순서: 마스터 컬럼 먼저, locations 나중 + 실패 로그. Phase 7 전까지 진실은 기존 컬럼.
