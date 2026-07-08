# 발주서 관리 V2 — MongoDB → Supabase(SQL) 마이그레이션 가이드

> 작성일: 2026-07-08
> 대상: 신규 발주서(`/newOrder`, `newOrders` 컬렉션) + 전체 발주서(`/rocket`, `orders` 컬렉션)
> 원칙: **기존 페이지·기존 데이터는 절대 건드리지 않는다.** V2는 병행 운영하며 비교/검증용으로 사용한다.

---

## 0. 왜 테이블을 2개로 쪼개야 하나? (지난 설명 다시, 이용자 입장에서)

지금 MongoDB는 **발주서 1건이 종이 서류 1장**처럼 저장되어 있습니다.
그 서류 안에 상품 목록이 **통째로 붙어** 있어요:

```
📄 발주서 #135798098 (문서 1개)
   ├─ 입고예정일: 20260716, 물류센터: 대구1 ...
   └─ 상품 목록 (서류 안에 같이 들어있음)
       ├─ 상품 A — 수영복, 10개
       ├─ 상품 B — 모자, 5개
       └─ 상품 C — 가방, 3개
```

SQL(Supabase)은 이런 "서류 안에 목록이 들어있는" 구조가 없습니다.
대신 **엑셀 시트 2장**이라고 생각하면 됩니다:

**시트 1: 발주서 목록 (`rk_orders`)** — 발주서 1건 = 1행

| id | 발주번호 | 입고예정일 | 물류센터 |
|----|----------|-----------|---------|
| 1  | 135798098 | 2026-07-16 | 대구1 |
| 2  | 135800001 | 2026-07-13 | 인천4 |

**시트 2: 발주 상품 목록 (`rk_order_items`)** — 상품 1개 = 1행, "몇 번 발주서 소속인지"를 `order_id` 칸에 적음

| id | order_id | 상품이름 | 발주수량 |
|----|----------|---------|---------|
| 1  | **1** | 수영복 | 10 |
| 2  | **1** | 모자 | 5 |
| 3  | **1** | 가방 | 3 |
| 4  | **2** | 신발 | 7 |

- 화면에서 발주서를 열면 → "시트 2에서 `order_id`가 1인 행을 전부 가져와" 라는 조회(JOIN)로 원래 모양을 복원합니다.
- **이용자 화면에서는 아무것도 달라지지 않습니다.** 데이터를 보관하는 창고 정리 방식만 바뀌는 것.
- 장점: 바코드로 상품 검색, 수량 합계, 중복 검사 같은 게 훨씬 빠르고 정확해집니다.

---

## 1. 전체 진행 순서 (큰 그림)

```
Phase 1  Supabase 테이블 생성 (rk_ 접두사, 4개 테이블)
Phase 2  데이터 복사 스크립트 작성 & 실행 (Mongo → Supabase, 읽기 전용)
Phase 3  데이터 검증 (건수·합계 비교)
Phase 4  서버에 V2 API 추가 (/api/v2/...) — Supabase 조회 전용
Phase 5  V2 페이지 생성 (rocket-v2.html, newOrder-v2.html)
Phase 6  메뉴 추가 (index.html 하단 카드 + header.html 상단 드롭다운)
Phase 7  기능 비교/분석 후 → 수정 기능(업로드/삭제/위치저장 등) 단계적 이식
```

- Phase 2는 **Mongo에서 읽기만** 합니다. 기존 데이터 변경 없음.
- Phase 4~6은 **새 파일 추가 + 메뉴 링크 추가**만. 기존 rocket.html / newOrder.html 은 수정하지 않음.
  (예외: index.html·header.html에 메뉴 **추가**는 필요 — 기존 항목은 건드리지 않고 항목만 추가)

---

## 2. Supabase 테이블 설계 (Phase 1)

### 2-1. 테이블 구성 — 4개

다른 프로젝트와 구분을 위해 전부 **`rk_` 접두사** 사용.

| Supabase 테이블 | 원본 Mongo 컬렉션 | 역할 |
|---|---|---|
| `rk_orders` | `orders` (70건) | 전체 발주서 헤더 |
| `rk_order_items` | `orders.상품정보[]` | 전체 발주서의 상품들 |
| `rk_new_orders` | `newOrders` (29건) | 신규 발주서 헤더 |
| `rk_new_order_items` | `newOrders.상품정보[]` | 신규 발주서의 상품들 |

> 신규/전체 발주서는 **컬럼 구조가 100% 동일**합니다 (요구사항 3번: 같은 데이터 = 같은 칼럼명).
> 테이블을 합치고 `order_type` 컬럼으로 구분하는 방법도 있지만, 지금 단계에서는
> **기존 컬렉션과 1:1 대응**시키는 게 데이터 비교·검증에 유리하므로 분리를 추천.
> (안정화 후 통합은 언제든 가능)

### 2-2. 컬럼 매핑표 — 헤더 테이블 (`rk_orders` = `rk_new_orders`)

| Mongo 필드 (한글) | Supabase 컬럼 (영문) | 타입 | 정제 규칙 |
|---|---|---|---|
| `_id` | `mongo_id` | `text` (unique) | 원본 추적용 — 비교 검증에 필수 |
| `발주번호` | `order_number` | `text` | 숫자처럼 보여도 앞자리 0 보존 위해 text |
| `입고예정일` | `arrival_date` | `date` | `"20260716"` → `2026-07-16` |
| `물류센터` | `logistics_center` | `text` | |
| `상품수` | `product_count` | `integer` | |
| `발주수량` | `order_qty` | `integer` | |
| `확정수량` | `confirmed_qty` | `integer` | |
| `스캔수량` | `scanned_qty` | `integer` (default 0) | |
| — | `id` | `bigint` PK (identity) | 새로 생성 |
| — | `created_at` | `timestamptz` default now() | |

### 2-3. 컬럼 매핑표 — 상품 테이블 (`rk_order_items` = `rk_new_order_items`)

| Mongo 필드 (한글) | Supabase 컬럼 (영문) | 타입 | 정제 규칙 |
|---|---|---|---|
| (소속 발주서) | `order_id` | `bigint` FK → 헤더 `id` | ON DELETE CASCADE |
| `_id` | `mongo_id` | `text` | 원본 추적용 |
| `상품번호` | `product_number` | `text` | |
| `상품바코드` | `barcode` | `text` + **인덱스** | Mongo에도 인덱스 있던 핵심 조회 경로 |
| `상품이름` | `product_name` | `text` | |
| `발주수량` | `order_qty` | `integer` | |
| `확정수량` | `confirmed_qty` | `integer` | |
| `스캔수량` | `scanned_qty` | `integer` default 0 | |
| `입고유형` | `receiving_type` | `text` | 예: "쉽먼트" |
| `발주상태` | `order_status` | `text` | 예: "거래처확인요청" |
| `유통(소비)기한` | `expiry_date` | `text` → 추후 `date` | `""` → NULL. 형식 불명이라 우선 text |
| `제조일자` | `manufacture_date` | `text` | `""` → NULL |
| `생산년도` | `production_year` | `text` | `""` → NULL |
| `납품부족사유` | `shortage_reason` | `text` | `""` → NULL |
| `회송담당자` | `return_manager` | `text` | |
| `회송담당자 연락처` | `return_manager_phone` | `text` | |
| `회송지주소` | `return_address` | `text` | |
| `매입가` | `purchase_price` | `numeric` | |
| `공급가` | `supply_price` | `numeric` | |
| `부가세` | `vat` | `numeric` | |
| `총발주 매입금` | `total_purchase_amount` | `numeric` | |
| `발주등록일시` | `registered_at` | `timestamptz` | `"2026-07-02 12:22:37"` → 파싱 (KST 기준) |
| `박스정보` | `box_info` | `text` | 없는 문서 있음 → NULL 허용 |
| `입고1` | `receiving_1` | `text` | `'-'` → NULL |
| `입고2` | `receiving_2` | `text` | `'-'` → NULL |
| `위치` | `location` | `text` | `'-'`, `'.'` → NULL |

### 2-4. 데이터 정제 규칙 정리 (요구사항 2번)

실제 데이터 샘플링 결과 기반:

1. **`입고예정일`**: 전부 `YYYYMMDD` 8자리 문자열 (`20260710`, `20260713`, `20260716` 확인) → `date` 변환
2. **`발주등록일시`**: `YYYY-MM-DD HH:mm:ss` 형식 → `timestamptz` (Asia/Seoul 기준으로 저장)
3. **빈 문자열 `""`** (유통기한·제조일자·생산년도·납품부족사유 등) → `NULL`
4. **의미 없는 placeholder `'-'`, `'.'`** (입고1, 입고2, 위치) → `NULL`
   - ⚠️ 단, 화면에서는 `-`로 다시 표시해주면 기존과 동일하게 보임 (표시 계층에서 처리)
5. **금액류** (`매입가`, `공급가`, `부가세`, `총발주 매입금`): 이미 number → `numeric` 그대로
6. **`발주번호`, `상품번호`, `상품바코드`**: 숫자처럼 보이지만 `text` 유지 (앞자리 0, 영문 포함 바코드 `R227921770004` 존재)

### 2-5. DDL 초안

```sql
-- 헤더 (rk_new_orders 는 테이블명만 다르고 동일)
create table rk_orders (
  id               bigint generated always as identity primary key,
  mongo_id         text unique not null,
  order_number     text not null,
  arrival_date     date,
  logistics_center text,
  product_count    integer,
  order_qty        integer,
  confirmed_qty    integer,
  scanned_qty      integer default 0,
  created_at       timestamptz default now()
);
create index on rk_orders (arrival_date, logistics_center, order_number); -- /rocket 정렬 순서 그대로

-- 상품 (rk_new_order_items 는 FK 대상만 rk_new_orders)
create table rk_order_items (
  id                    bigint generated always as identity primary key,
  order_id              bigint not null references rk_orders(id) on delete cascade,
  mongo_id              text,
  product_number        text,
  barcode               text,
  product_name          text,
  order_qty             integer,
  confirmed_qty         integer,
  scanned_qty           integer default 0,
  receiving_type        text,
  order_status          text,
  expiry_date           text,
  manufacture_date      text,
  production_year       text,
  shortage_reason       text,
  return_manager        text,
  return_manager_phone  text,
  return_address        text,
  purchase_price        numeric,
  supply_price          numeric,
  vat                   numeric,
  total_purchase_amount numeric,
  registered_at         timestamptz,
  box_info              text,
  receiving_1           text,
  receiving_2           text,
  location              text
);
create index on rk_order_items (barcode);
create index on rk_order_items (order_id);
```

> RLS: 이 앱은 서버(service role key)에서만 접근하므로 RLS 활성화 + 정책 없음(서비스롤은 우회)으로 두면 안전.

---

## 3. 데이터 복사 (Phase 2~3)

### 3-1. 방법

Node 스크립트 1개 (`scripts/migrate-to-supabase.js`):

1. Mongoose로 `orders`, `newOrders` **읽기만** 수행
2. 정제 규칙(2-4) 적용해 변환
3. `@supabase/supabase-js`(이미 설치됨 + 서버에 URL/SERVICE_ROLE_KEY 환경변수 이미 있음)로 insert
4. `mongo_id` unique 제약 덕분에 **재실행해도 중복 안 생김** (upsert 사용)
5. 실행 전 대상 테이블 truncate 옵션 제공 (Supabase 쪽만 비움 — Mongo는 절대 안 건드림)

### 3-2. 검증 쿼리 (Phase 3)

| 검증 항목 | Mongo | Supabase |
|---|---|---|
| 발주서 건수 | `orders` 70건 / `newOrders` 29건 | `select count(*) from rk_orders` 등 |
| 상품 행 수 | `상품정보` 배열 길이 총합 | `select count(*) from rk_order_items` |
| 수량 합계 | `발주수량` 총합 | `sum(order_qty)` |
| 금액 합계 | `총발주 매입금` 총합 | `sum(total_purchase_amount)` |
| 무작위 5건 | 발주번호로 원본과 필드별 대조 | JOIN 결과와 비교 |

---

## 4. V2 API (Phase 4)

기존 API는 그대로 두고, **`/api/v2/` 네임스페이스**로 Supabase 조회 API만 추가:

| 신규 API | 대응하는 기존 API | 내용 |
|---|---|---|
| `GET /api/v2/orders` | `GET /api/orders` | 전체 발주서 목록 (입고예정일→물류센터→발주번호 정렬) |
| `GET /api/v2/orders/:orderNumber` | `GET /api/orders/:orderNumber` | 발주서 상세 (items JOIN) |
| `GET /api/v2/neworders` | `GET /api/neworders` | 신규 발주서 목록 |
| `GET /api/v2/neworders/:orderNumber` | 〃 상세 | |

- **1차 목표는 조회 전용.** 업로드/삭제/위치저장 등 쓰기 기능은 Phase 7에서 비교 분석 후 이식.
- 서버에 이미 `supabase` 클라이언트가 생성되어 있음 (server.js:1442) → 그대로 재사용.

### 참고: 기존 페이지가 쓰는 API 전체 목록 (Phase 7 이식 대상)

**rocket.html (전체 발주서):**
`/api/upload`(업로드), `/api/orders`(목록), `/api/orders/:no`(상세), `/api/download`, `/api/orders/delete`, `/api/orders/export`, `/api/inventory/locations`, `/api/orders/update-location`, `/api/orders/update-date`, `/api/orders/logistics-centers`, `/api/orders/update-center`

**newOrder.html (신규 발주서):**
`/api/neworder/upload`, `/api/neworders/register`, `/api/inventory/locations`, `/api/neworders/batch-update-location`, `/api/neworders/update-location`, `/api/neworders/delete`, `/api/neworders/export`, `/api/neworders`(목록)

---

## 5. V2 페이지 (Phase 5)

| 새 파일 | 원본 복사 대상 | 라우트 | 데이터 소스 |
|---|---|---|---|
| `rocket-v2.html` | `rocket.html` 복제 후 API만 `/api/v2/*`로 교체 | `GET /rocket-v2` | Supabase |
| `newOrder-v2.html` | `newOrder.html` 복제 후 〃 | `GET /newOrder-v2` | Supabase |

- 원본 HTML을 복제하므로 **화면·기능이 동일하게 보임** → 나란히 띄워 비교 가능.
- 페이지 상단에 `V2 (Supabase)` 뱃지를 달아 어느 버전인지 헷갈리지 않게 표시.
- 1차에서는 쓰기 버튼(업로드/삭제 등)은 "V2 준비중" 비활성 처리 → 실수로 이중 데이터 생성 방지.

---

## 6. 메뉴 추가 (Phase 6)

### 6-1. `index.html` (홈 화면)

- 퀵링크 카드 목록 **제일 하단**에 카드 추가:
  - 제목: **발주서 관리 V2**
  - 설명: "Supabase 기반 발주서 (비교/검증용)"
  - 클릭 → `/rocket-v2`

### 6-2. `header.html` (상단 공통 메뉴)

- 기존 `발주서` 드롭다운 **바로 옆**에 `발주서 V2` 드롭다운 추가:
  ```
  발주서 V2 ▾
   ├─ 신규 발주서 V2  → /newOrder-v2
   └─ 전체 발주서 V2  → /rocket-v2
  ```
- 기존 `발주서` 메뉴는 링크·순서 모두 변경 없음.

---

## 7. 안전장치 & 롤백

- Mongo 접근은 마이그레이션 스크립트에서 **읽기 전용** (find만 사용, write 코드 자체를 넣지 않음)
- V2 API는 조회 전용으로 시작 → Supabase 데이터도 스크립트 외에는 변경 경로 없음
- 문제가 생기면: V2 메뉴 링크 2곳만 제거하면 기존 시스템은 아무 영향 없음
- Supabase 테이블 삭제(drop)로 완전 초기화 가능 — `rk_` 접두사라 다른 프로젝트 테이블과 격리됨

---

## 8. 진행 체크리스트

- [ ] **Phase 1** — Supabase에 `rk_orders`, `rk_order_items`, `rk_new_orders`, `rk_new_order_items` 생성 (MCP `apply_migration`)
- [ ] **Phase 2** — `scripts/migrate-to-supabase.js` 작성 & 실행
- [ ] **Phase 3** — 건수/합계/샘플 검증 (3-2 표)
- [ ] **Phase 4** — `/api/v2/orders`, `/api/v2/neworders` (+상세) 추가
- [ ] **Phase 5** — `rocket-v2.html`, `newOrder-v2.html` + 라우트 추가
- [ ] **Phase 6** — index.html 하단 카드 + header.html 드롭다운 추가
- [ ] **Phase 7** — 기능 비교 분석 → 쓰기 기능(업로드/수정/삭제) 단계적 이식 (별도 계획)

---

## 9. 미결 사항 (진행하며 결정)

1. `유통(소비)기한` 실데이터가 현재 전부 빈 값 → 형식 확인되면 `date`로 승격
2. `inventories`(11,292건), `chinaimports`(499건)는 이번 범위 밖 — 발주서 V2 안정화 후 같은 패턴으로 진행
3. 신규/전체 발주서 테이블 통합 여부 (현재: 분리, 검증 완료 후 재검토)
