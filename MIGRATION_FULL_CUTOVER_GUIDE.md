# MongoDB → Supabase 완전 전환 가이드 (풀 컷오버)

> 작성일: 2026-07-08
> 목표: **내일 아침부터 모든 이용자가 Supabase 기반으로 전체 업무 수행**
> 전제: 발주서 V2(Phase 1~6) 완료 상태. 이 문서는 "일부 V2 병행"이 아니라 **프로젝트 전체의 정본(source of truth)을 Supabase로 옮기는 계획**이다.

---

## 0. 핵심 전환 전략 — 이것이 하루 컷오버를 가능하게 한다

**"페이지는 안 고친다. API 경로·요청·응답 계약을 그대로 두고, 서버 내부 구현만 Mongo → Supabase로 교체한다."**

```
[기존]  rocket.html ──fetch──> /api/orders ──> mongoose(Order) ──> MongoDB
[전환]  rocket.html ──fetch──> /api/orders ──> supabase-js     ──> Supabase
        (페이지·경로·JSON 형태 동일 → 이용자는 아무 변화도 못 느낌)
```

- 이미 발주서 V2에서 검증됨: `routes/v2.js`가 Supabase 데이터를 기존 한글 JSON 형태로 완벽 복원 (원본 대비 진짜 불일치 0건)
- HTML 9개 페이지 전부 무수정 → 프론트 회귀 리스크 제거
- 롤백도 간단: 서버 코드만 이전 커밋으로 되돌리면 끝

---

## 1. 현재 상태 전수 조사 결과

### 1-1. 이미 Supabase인 것 (전환 불필요 ✅)

| 페이지 | API | Supabase 테이블 |
|---|---|---|
| 쿠팡 물류센터 (`/warehouse`) | `/api/warehouse/centers` CRUD+upload (5개) | `coupang_centers` |
| 판매데이터 (`/salesdata`) | `/api/salesdata/coupang-stock` | `coupang_stocks` |
| 상품부족 (`/shortage`) 일부 | forecast/upload, order-history/*, yiwu-orders, save-temp (8개) | `coupang_weekly_forecast`, `coupang_order_history`, `yiwu_br_orders`, `coupang_order_save_temp` |
| 쉽먼트 export 일부 | 물류센터 주소 조회 | `coupang_centers` |

### 1-2. Mongo 의존 — 전환 대상 (4개 컬렉션, 43개 중 약 35개 엔드포인트)

| Mongo 컬렉션 | Supabase 대상 테이블 | 상태 |
|---|---|---|
| `orders` (70건) | `rk_orders` + `rk_order_items` | ✅ 테이블 있음, 데이터 복사됨 |
| `newOrders` (29건) | `rk_new_orders` + `rk_new_order_items` | ✅ 테이블 있음, 데이터 복사됨 |
| `inventories` (11,292건) | `rk_inventories` | ❌ **테이블 신규 생성 필요** |
| `chinaimports` (499건) | `rk_china_imports` | ❌ **테이블 신규 생성 필요** |

### 1-3. DB와 무관 — 그대로 유지

- socket.io 실시간 스캔 알림 (`io.emit('scan-update')`) — DB 무관, 유지
- multer 엑셀 업로드, xlsx 파싱/생성, docx 단종문서 생성(libreoffice) — 유지
- 크론 작업: **없음** (node-cron은 설치만 되고 미사용)
- `/upcoming` 링크: 라우트 자체가 없음(현재도 404) — 기존 이슈, 이번 범위 밖

---

## 2. 신규 테이블 2개 DDL

### 2-1. `rk_inventories` (← inventories 11,292건)

```sql
create table rk_inventories (
  id           bigint generated always as identity primary key,
  mongo_id     text unique,
  sku_id       text,
  name         text,
  barcode      text,
  order_status text,
  quantity     text,          -- 원본이 '-' placeholder 문자열 → text 유지
  location     text,
  last_update  timestamptz,
  created_at   timestamptz default now()
);
create index on rk_inventories (barcode);
create index on rk_inventories (sku_id);
alter table rk_inventories enable row level security;
```

### 2-2. `rk_china_imports` (← chinaimports 499건)

```sql
create table rk_china_imports (
  id               bigint generated always as identity primary key,
  mongo_id         text unique,
  shipment_code    text not null,
  pallet           text,
  box_name         text,
  order_number     text,
  product_name     text,
  quantity         text,      -- 원본 String
  barcode          text,
  available_orders text,
  shipping_date    text,
  created_at       timestamptz default now()
);
create index on rk_china_imports (shipment_code, barcode);
create index on rk_china_imports (barcode);
alter table rk_china_imports enable row level security;
```

### 2-3. 마이그레이션 스크립트 확장

`scripts/migrate-to-supabase.js`에 두 컬렉션 복사 함수 추가 (기존과 동일한 멱등 패턴, mongo_id upsert). 11,292건은 1,000건 배치 insert로.

---

## 3. 엔드포인트 전환 전수 목록

> ⭐ = 특수 로직 (§4에서 상세). 난이도: 하(단순 CRUD 치환) / 중(조인·집계) / 상(트랜잭션·원자성)

### 3-A. 발주서 도메인 — `rk_orders`/`rk_order_items` (rocket.html, scan.html, shipment.html)

| # | API | Mongo 동작 | 전환 방법 | 난이도 |
|---|---|---|---|---|
| 1 | `GET /api/orders` | Order.find + referer별 가공 | v2 listOrders 재사용 + referer 분기(쉽먼트=박스행만/기타=dedup) 유지 | 하 (v2로 80% 완성) |
| 2 | `GET /api/orders/:orderNumber` | Order.findOne + 가공 | v2 getOrder 재사용 + referer 분기 | 하 |
| 3 | `POST /api/upload` | 엑셀 파싱 → Order.insertMany | 파싱 그대로, 헤더 upsert + items insert (v2 마이그레이션 변환함수 재사용) | 중 |
| 4 | `POST /api/orders/delete` | 비밀번호검증 + deleteMany | `delete from rk_orders where order_number in (...)` (items는 FK cascade) | 하 |
| 5 | `POST /api/orders/export` | Order.find → xlsx | 조회만 교체 | 하 |
| 6 | `GET /api/download` | 발주서 xlsx | 조회만 교체 | 하 |
| 7 | `POST /api/orders/update-location` | 위치 벌크수정 | `update rk_order_items set location=... where order_id=.. and barcode=..` | 하 |
| 8 | `POST /api/orders/update-date` | 입고예정일 수정 | 헤더 update | 하 |
| 9 | `POST /api/orders/update-center` | 물류센터 수정 | 헤더 update | 하 |
| 10 | `GET /api/orders/logistics-centers` | distinct 물류센터 | `select distinct logistics_center` | 하 |
| 11 ⭐ | `POST /api/scan` | 스캔 → 원본행 스캔수량↑ + 박스행 생성/증가 + 헤더 합계 | **Postgres RPC 함수로 원자화** (§4-1) | **상** |
| 12 ⭐ | `POST /api/scan/update` | 스캔수량 직접 수정 | RPC 또는 단건 update + 합계 재계산 | 중 |
| 13 ⭐ | `POST /api/scan/delete` | 박스행 삭제 + 합계 재계산 | 동일 RPC 패턴 | 중 |
| 14 ⭐ | `POST /api/scan/updateBox` | 박스정보 변경 | items update + 합계 재계산 | 중 |
| 15 | `POST /api/shipment/export` | Order.find(박스행) + coupang_centers → xlsx | 조회만 교체 (centers는 이미 Supabase) | 하 |
| 16 | `POST /api/shipment/export-cj` | 〃 CJ양식 | 〃 | 하 |
| 17 | `GET /api/products/barcode/:barcode` | 바코드로 상품 검색 (scan 페이지) | `rk_order_items where barcode=... join rk_orders` | 하 |
| 18 | `POST /api/orders/parse-excel` | 엑셀 파싱(등록 미리보기) | DB 무관, 유지 | - |
| 19 | `POST /api/orders/register` | 파싱결과 → Order 저장 | upsert 패턴 | 중 |
| 20 ⭐ | `POST /api/orders/updateImport1` | 중국입고 → 입고1 벌크 반영 | items 벌크 update (§4-3) | 중 |
| 21 ⭐ | `POST /api/orders/updateImport2` | 〃 입고2 | 〃 | 중 |
| 22 | `POST /api/orders/resetImport12` | 입고1/2 초기화 | `update ... set receiving_1=null, receiving_2=null` | 하 |

### 3-B. 신규 발주서 — `rk_new_orders`/`rk_new_order_items` (newOrder.html)

| # | API | Mongo 동작 | 전환 방법 | 난이도 |
|---|---|---|---|---|
| 23 | `POST /api/neworder/upload` | 엑셀 → NewOrder.insertMany (발주번호 중복 skip) | upsert-검사 후 insert | 중 |
| 24 | `GET /api/neworders` | NewOrder.find 정렬 | v2 listOrders 재사용 (완성됨) | 하 |
| 25 | `POST /api/neworders/delete` | 비밀번호 + deleteMany | delete cascade | 하 |
| 26 | `POST /api/neworders/export` | xlsx | 조회 교체 | 하 |
| 27 | `POST /api/neworders/update-location` | 위치 수정 | items update | 하 |
| 28 | `POST /api/neworders/batch-update-location` | 위치 일괄 | items 벌크 update | 하 |
| 29 ⭐ | `POST /api/neworders/register` | **NewOrder → Order 복사** (발주번호 중복 skip) | 트랜잭션 RPC 권장 (§4-2) | 중 |

### 3-C. 재고 — `rk_inventories` (inventory.html + rocket/newOrder의 위치 불러오기)

| # | API | 전환 방법 | 난이도 |
|---|---|---|---|
| 30 | `GET /api/inventory/list` | select * | 하 |
| 31 | `POST /api/inventory/upload` | 엑셀 → 배치 insert | 하 |
| 32 | `POST /api/inventory/delete-selected` | delete in | 하 |
| 33 | `POST /api/inventory/search` | ilike 검색 | 하 |
| 34 | `POST /api/inventory/update-location` | update | 하 |
| 35 ⭐ | `POST /api/inventory/locations` | 바코드 배열 → 위치 맵 (rocket·newOrder '위치 불러오기'가 호출) | `.in('barcode', [...])` — 200개 배치 (§4-4) | 하 |
| 36 | `POST /api/inventory/upload-locations` | 위치 일괄 업로드 | 벌크 update | 하 |
| 37 | `POST /api/inventory/register` | 재고 등록 | insert | 하 |
| 38 | `POST /api/inventory/generate-discontinue-doc` | 단종 docx 생성 (조회만 DB) | 조회 교체 | 하 |

### 3-D. 중국입고 — `rk_china_imports` (importChina.html)

| # | API | 전환 방법 | 난이도 |
|---|---|---|---|
| 39 | `POST /api/importChina/upload` | shipmentCode별 deleteMany→insertMany | delete+insert 동일 패턴 | 하 |
| 40 | `GET /api/importChina/data`, `GET /api/importChina` | select | 하 |
| 41 | `DELETE /api/importChina/delete/:shipmentCode` | delete where | 하 |
| 42 ⭐ | `POST /api/importChina/organize` | 정리 로직 + Order 대조 | rk_order_items 조인으로 교체 (§4-3) | 중 |
| 43 | `POST /api/importChina/updateAvailableOrders` | 가용발주 갱신 | update | 중 |

### 3-E. 상품부족 — 혼합 (shortage.html)

| # | API | 현재 | 전환 방법 | 난이도 |
|---|---|---|---|---|
| 44 ⭐ | `GET /api/shortage` | **Order.find + Inventory.find** + Supabase(forecast/yiwu/hist) | Mongo 2개 조회를 rk_* 조회로 교체, Supabase 부분은 그대로 | 중 |
| 45 | `POST /api/shortage/export` | 위 결과 xlsx | 조회 교체 | 하 |
| (나머지 shortage 8개) | 이미 Supabase | 무변경 | - |

---

## 4. 특수 로직 5가지 — 반드시 정확히 이식해야 하는 것

### 4-1. 스캔 (`POST /api/scan`) — 가장 중요, 유일한 "상" 난이도 ⚠️

현재 Mongo 로직 (server.js:381):
1. 발주서에서 바코드로 **원본 상품행**(박스정보 없음) 찾기
2. 확정수량 초과 검사 (기존 박스행 스캔수량 합 + 이번 수량)
3. 같은 박스에 같은 바코드 행이 있으면 스캔수량 증가, 없으면 **박스행 복제 생성** (`박스정보='1-대'` 형태)
4. 원본행 스캔수량 = 모든 박스행 합계로 갱신
5. 발주서 헤더 스캔수량 = 원본행들 합계로 갱신
6. `io.emit('scan-update')` 실시간 알림

**SQL 이식 원칙:**
- 이 다단계 read-modify-write를 **Postgres 함수(RPC) 하나**로 만들어 원자화한다. 여러 작업자가 동시에 스캔해도 (Mongo 시절보다 오히려) 안전해짐.
- 함수 시그니처: `rk_scan(p_order_number text, p_barcode text, p_box_info text, p_qty int) returns json`
- 함수 내부에서 초과검사→박스행 upsert→원본행 합계→헤더 합계까지 한 트랜잭션으로.
- Node에서는 `supabase.rpc('rk_scan', {...})` 한 줄. socket.io emit은 기존대로 Node에서.
- scan/update·scan/delete·updateBox도 같은 패턴의 소형 RPC 3개.

### 4-2. 발주서 등록 (`POST /api/neworders/register`)

신규발주서 → 전체발주서 **복사** (발주번호 중복이면 skip; 원본 코드는 신규측 삭제를 주석처리로 남겨둠 — 현행 유지).
- SQL: `rk_new_orders`+items 읽기 → `rk_orders`+items insert. 중복검사 포함 RPC 1개로 묶으면 부분실패 없음.

### 4-3. 중국입고 ↔ 발주서 연동 (`updateImport1/2`, `organize`)

중국입고 데이터의 바코드·수량을 발주서 items의 `입고1`/`입고2`(receiving_1/2)에 벌크 반영.
- SQL: 바코드 목록 기반 `update rk_order_items ... where barcode = any(...)`. 발주번호 매칭 조건이 코드에 있으면 그대로 재현 (구현 시 원본 코드 라인 단위로 대조할 것).

### 4-4. 위치 불러오기 (`POST /api/inventory/locations`)

rocket·newOrder 페이지가 발주서의 바코드 배열을 보내면 재고에서 위치를 찾아 돌려줌.
- SQL: `rk_inventories.select('barcode,location').in('barcode', batch)` — **Supabase `.in()`은 URL 길이 제한이 있으므로 200개 배치** (이미 shortage 코드가 이 패턴 사용 중, 그대로 복사).

### 4-5. shortage 집계 (`GET /api/shortage`)

바코드 기준 발주수량 vs 스캔수량 부족분 계산. Mongo Order/Inventory 조회 2개만 `rk_order_items`(barcode별 sum) / `rk_inventories`로 교체. 이후 Supabase forecast/yiwu/hist 로직은 무변경.

### 공통 주의 (v2.js에서 검증된 규칙 재사용)

- **날짜 복원**: `arrival_date(date)` → `"YYYYMMDD"` 문자열, `registered_at` → KST `"YYYY-MM-DD HH:mm:ss"` (routes/v2.js의 `dateToYmd`/`tsToKst` 재사용)
- **placeholder 복원**: null → `'-'` (입고1/입고2/위치)
- **1000행 제한**: 모든 목록 조회는 `.range()` 페이지네이션 (v2.js `fetchAllItems` 재사용)
- **referer 분기 유지**: `/api/orders`는 쉽먼트/rocket/scan에서 각각 다른 형태를 기대함 — 기존 분기 로직을 그대로 살리고 데이터 소스만 교체

---

## 5. 코드 구조 제안

```
server.js            ← 라우트 마운트 + 정적 페이지만 남김 (점진적으로)
routes/
  v2.js              ← 기존 (유지, 헬퍼 export해서 공유)
  orders.js          ← 3-A (발주서/스캔/쉽먼트)
  neworders.js       ← 3-B
  inventory.js       ← 3-C
  chinaImport.js     ← 3-D
  shortage.js        ← 3-E 수정분
supabase/
  functions.sql      ← rk_scan 등 RPC 함수 정의 (migration으로 적용)
```

- 기존 server.js의 Mongo 엔드포인트는 **삭제하지 말고 새 라우터가 같은 경로를 먼저 가로채게** 마운트(app.use를 위에) → 문제 시 라우터 한 줄 제거로 롤백.
- 단, Express는 먼저 등록된 라우트가 이기므로 새 라우터 마운트를 **기존 정의보다 위**에 배치.

---

## 6. 컷오버 런북 (오늘 밤 → 내일 아침)

### D-0 (오늘, 이용자 작업 종료 후)

| 시각 | 작업 | 확인 |
|---|---|---|
| 1 | **개발·테스트 완료 상태에서 시작** (§3 전환 + §7 검증을 낮에 끝냄) | 체크리스트 통과 |
| 2 | 이용자 작업 중단 공지 (업로드·스캔 금지 시간 명시) | |
| 3 | **Mongo 최종 백업**: `mongodump` 또는 JSON export 4개 컬렉션 | 파일 보관 |
| 4 | **최종 동기화**: `node scripts/migrate-to-supabase.js` (멱등이므로 그냥 재실행 — orders/newOrders/inventories/chinaimports 4개) | 검증 스크립트 건수·합계 일치 |
| 5 | 새 서버 코드 배포(재시작) | 헬스체크 |
| 6 | §7 스모크 테스트 (10분) | 전부 통과 |

### D-Day (내일 아침)

| 시각 | 작업 |
|---|---|
| 업무 시작 전 | 관리자가 실데이터로 1회 왕복 테스트: 신규발주 업로드 → 등록 → 스캔 1건 → 쉽먼트 확인 → 부족확인 |
| 업무 시작 | 이용자 정상 사용 개시. **Mongo는 끄지 말고 읽기전용 보존** (최소 2주) |
| 첫날 종료 | Supabase 건수/합계 점검, 이상 없으면 성공 선언 |

### 안전장치

- `.env`의 `MONGODB_URI`는 당분간 유지 (재동기화·롤백용)
- mongoose 연결도 당분간 유지 (기존 코드가 남아있는 동안 서버 크래시 방지)
- V2 페이지(`/rocket-v2`)는 그대로 두면 "Supabase 조회 전용 뷰"로 계속 유용

---

## 7. 페이지별 검증 체크리스트 (컷오버 전 필수)

### rocket (전체 발주서)
- [ ] 목록/상세/검색/펼침
- [ ] 엑셀 업로드 → 새 발주서 반영 → **Supabase에 들어갔는지 SQL로 확인**
- [ ] 위치 불러오기(재고 연동) / 입고일 변경 / 센터변경 / 발주서 저장(xlsx) / 삭제(비밀번호)
### scan (바코드 스캔)
- [ ] 바코드 조회 → 스캔(+1, 지정수량) → 확정수량 초과 거부
- [ ] **동시 스캔 2건**(두 브라우저) → 합계 정확
- [ ] scan-update 실시간 반영(socket), 스캔 삭제/박스 변경
### shipment (쉽먼트)
- [ ] 박스행만 표시, export/export-cj 엑셀 열어 물류센터 주소 확인
### newOrder (신규 발주서)
- [ ] 업로드(중복 skip 메시지) → 목록 → 위치 일괄 → **등록 → 전체발주서에 나타남** → 삭제
### importChina (중국입고)
- [ ] 업로드/조회/정리(organize)/가용발주 갱신/입고1·입고2 반영 → rocket 화면에서 입고1/2 확인 → 초기화
### inventory (재고)
- [ ] 목록(11,292건 로딩 시간) / 검색 / 위치수정 / 업로드 / 단종 docx 생성
### shortage (상품부족)
- [ ] 부족 목록(발주 vs 스캔) / forecast·발주내역·이우 연동(기존 Supabase 부분 회귀 확인) / export
### warehouse·salesdata
- [ ] 무변경이지만 회귀 스모크 1회

---

## 8. 롤백 플랜

| 시나리오 | 조치 |
|---|---|
| 특정 API만 오류 | 해당 라우터 마운트 한 줄 주석 → 기존 Mongo 코드가 다시 받음 (Mongo가 살아있으므로 즉시 복귀) |
| 전면 문제 | `git revert` 후 재시작 → 100% Mongo 복귀. 단, **컷오버 후 Supabase에만 쓰인 데이터는 Mongo에 없음** → 복귀 전 신규 데이터 수동 이관 필요 (이것이 롤백의 유일한 비용 — 첫날 오전에 문제를 발견할수록 싸다) |

---

## 9. 전환 완료 후 정리 (안정화 2주 후)

- [ ] server.js에서 Mongo 엔드포인트 원본 코드 삭제, `models/` 삭제, mongoose·mongodb 의존성 제거
- [ ] `backup.js`(Mongo 재고 백업 스크립트) 폐기 → Supabase는 자체 백업/PITR 사용
- [ ] `.env`에서 `MONGODB_URI` 제거, MongoDB Atlas 클러스터 정리(비용 절감)
- [ ] V2 페이지·메뉴 거취 결정: (a) 새 디자인이 마음에 들면 **rocket-v2 디자인을 본편 rocket으로 승격**, (b) V2 메뉴 제거
- [ ] `rocket-v2.html.bak` 삭제
- [ ] MIGRATION_V2_GUIDE.md → 이 문서로 대체 표기

---

## 10. 리스크 및 결정 필요 사항

| # | 항목 | 내용 | 권장 |
|---|---|---|---|
| 1 | **스캔 동시성** | 유일한 원자성 요구 지점. RPC로 만들면 Mongo보다 안전해짐 | RPC 필수 |
| 2 | **작업량** | 전환 엔드포인트 ~35개 (하 25 / 중 9 / 상 1). 집중 작업으로 하루 내 구현+검증 가능하나 빠듯함 | 우선순위: scan·orders → neworders → inventory → chinaImport → shortage |
| 3 | **referer 분기** | `/api/orders`가 호출 페이지에 따라 3가지 형태 반환 — 놓치면 쉽먼트/스캔 깨짐 | 기존 분기 코드 보존, 소스만 교체 |
| 4 | **데이터 정합** | 컷오버 직전 최종 동기화 필수 (오늘 낮에 복사한 데이터는 이미 구버전일 수 있음) | 런북 D-0 4번 |
| 5 | **11,292건 재고 목록** | `/api/inventory/list`가 전체 반환 — 페이지네이션 필수 (v2 fetchAllItems 패턴) | 필수 |
| 6 | **끝공백 trim** | 마이그레이션이 텍스트 trim함 — 회송지주소 등. 업무 영향 없음 확인됨 | 그대로 |
| 7 | **비밀번호 삭제 검증** | orders/neworders delete의 비밀번호 로직 그대로 이식 | 유지 |
| 8 | **RLS** | rk_* 신규 테이블은 RLS on(서비스롤만). 기존 15개 테이블 RLS off는 별도 과제 | 별도 진행 |

---

## 11. 실행 순서 요약 (체크리스트)

- [ ] **Step 1**: `rk_inventories`, `rk_china_imports` 테이블 생성 (§2)
- [ ] **Step 2**: 마이그레이션 스크립트에 2개 컬렉션 추가 → 실행 → 검증
- [ ] **Step 3**: RPC 함수 작성 (`rk_scan` + scan 계열 3개, `rk_register_neworders`)
- [ ] **Step 4**: 라우터 5개 작성 (§5) — v2.js 헬퍼 재사용, 기존 응답 계약 유지
- [ ] **Step 5**: 페이지별 검증 (§7) — 특히 scan 동시성, referer 3분기, 등록 워크플로우
- [ ] **Step 6**: 컷오버 런북 실행 (§6) — 백업 → 최종 동기화 → 배포 → 스모크
- [ ] **Step 7**: 첫날 모니터링 → 2주 후 정리 (§9)
