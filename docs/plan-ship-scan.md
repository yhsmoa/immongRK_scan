# 출고스캔 페이지 설계 (바코드 스캔 옆 신규 메뉴)

> 작성: 2026-07-14 · 대상: 발주서 단위 박스 출고 스캔 페이지 신설
> 골격은 재고스캔(/stockScan)과 동일 (2분할 4:6, 대형 입력, 태블릿 대응 inputmode=none, 최신행 pulse 등)

---

## 0. 목표

- 헤더 **바코드 스캔 옆에 [출고스캔]** 메뉴 추가 → `/shipScan` (신규 페이지 shipScan.html)
- 발주서를 불러와 **박스(1~20) + 크기(극소~대2)** 를 지정하고 바코드를 연속 스캔
- 스캔 이력(기록)과 박스별 출고리스트를 관리, [저장] 시 Supabase 반영

---

## 1. 화면 구성 (2분할, stockScan 골격 재사용)

```
┌────────────────────────────┬──────────────────────────────────────────────┐
│ 왼쪽 (입력, 4)              │ 오른쪽 (6)                  [기록] [저장]     │
│                            │                                              │
│ [ 발주서 입력폼 ]           │ ① HEADER 테이블 (박스 목록)                   │
│   (Enter→유효검증→배경확정) │   발주번호|박스번호|크기|박스ID|created_at     │
│                            │                                              │
│ [ 📦 박스번호 ] (클릭→모달) │ ② 출고리스트(스캔목록, 내부스크롤)             │
│                            │   박스ID|상품바코드|상품명|스캔수량            │
│ [극소][소][중][대][대2]     │   (스캔 시 해당 행 가운데로 스크롤+개수↑)      │
│  (단일선택, 기본 극소)      │                                              │
│                            │                                              │
│ [ 바코드 스캔 입력폼 ]      │                                              │
└────────────────────────────┴──────────────────────────────────────────────┘
```

### 1-1. 왼쪽 입력 영역

- **발주서 입력폼** (재고스캔의 위치 입력과 동일 UX)
  - 바코드/타이핑 입력 + Enter → **유효 발주서 검증** (기준: §6 질문) → 통과 시 파란 배경으로 확정 + 발주번호 유지 표시
  - 실패 시 토스트("존재하지 않는 발주서입니다" 등) + 흰 배경 유지
  - 재선택(focus) 시 초기화
  - 확정 시: 해당 발주서의 **기존 박스 목록(HEADER) + 출고리스트 로드**해 오른쪽에 표시
- **박스번호 버튼** — 클릭 → **박스 선택 모달**
  - 📦 이모지 + 번호, **1~20 (5개×4줄)** 그리드
  - **이미 생성된 박스(HEADER에 존재) = 컬러, 미생성 = 흑백**(grayscale)
  - 선택 시 버튼에 `📦 3` 형태로 표시, 모달 닫힘
  - 미생성 박스를 선택하면 **저장 시점(또는 첫 스캔 시점)에 새 박스 생성** + 현재 선택된 크기 적용
- **크기 선택 버튼** — `극소 / 소 / 중 / 대 / 대2`
  - 라디오형(하나만 선택), 기본 **극소**
  - 이미 생성된 박스를 선택하면 그 박스의 크기로 자동 표시
- **바코드 입력폼** — 재고스캔과 동일 (Enter 반영 후 초기화, focus 유지, inputmode=none)
  - 발주서+박스 미확정 상태면 토스트로 안내

### 1-2. 오른쪽 영역

- **① HEADER 테이블**: 발주번호 · 박스번호 · 크기 · 박스ID · created_at (이 발주서의 박스들)
- **② 출고리스트(스캔목록)**: 박스ID · 상품바코드 · 상품명 · 스캔수량
  - 발주서 확정 시 **기존 저장분이 먼저 로드**되어 표시
  - **같은 박스+같은 바코드는 1행으로 항상 합산** (재고스캔의 위치+바코드 합산과 동일)
  - **바코드 스캔 시 해당 행을 목록 가운데로 스크롤** + 개수 증가 + pulse 강조
  - 내부 스크롤 (페이지 스크롤 아님)
- 우측 상단: **[기록] [저장]** 버튼

### 1-3. [기록] — 스캔 이력 (오른쪽 슬라이드 모달)

- 클릭 → 오른쪽에서 슬라이드 패널: **박스위치 · 바코드 · 상품명 · 개수**
- **시간순 로그** (최신 위)
- 합산 규칙(출고리스트와 다름):
  - **직전 스캔**과 같은 박스+바코드면 그 항목 개수 +1
  - 사이에 다른 바코드/박스가 끼면 → **새 항목 생성** (과거 항목과 합치지 않음 — 이력이므로)
  - 예: A스캔, A스캔(+1 → A:2), B스캔, A스캔 → 기록은 [A:2, B:1, A:1] 세 줄

### 1-4. [저장]

- 기록(미저장분)을 **같은 박스+같은 바코드로 합산**해 서버 저장 → 기존 저장분과 다시 합산
- 저장 성공 시 기록 초기화, HEADER/출고리스트 재로드, 토스트
- 미저장 기록이 있으면 페이지 이탈 시 beforeunload 경고 (기존 관례)

---

## 2. 데이터 모델 (Supabase 신규 테이블 2개 — §6 확정 필요)

```sql
create table rk_ship_boxes (
  id           bigint generated always as identity primary key,  -- 박스 ID
  order_number text not null,                                    -- 발주번호
  box_no       integer not null,                                 -- 1~20
  box_size     text not null default '극소',                     -- 극소/소/중/대/대2
  created_at   timestamptz not null default now(),
  unique (order_number, box_no)
);

create table rk_ship_box_items (
  id           bigint generated always as identity primary key,
  box_id       bigint not null references rk_ship_boxes(id) on delete cascade,
  order_number text not null,
  barcode      text not null,
  product_name text,
  qty          integer not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (box_id, barcode)          -- 같은 박스+바코드 = 1행 합산
);
```

- HEADER 테이블 = `rk_ship_boxes`, 출고리스트 = `rk_ship_box_items`
- 기존 `/scan`(rk_order_items.scanned_qty) 및 rk_stocks 는 **무변경**

## 3. API (routes/rkShipScan.js 신규)

| 엔드포인트 | 동작 |
|---|---|
| `GET /api/ship-scan/order/:orderNumber` | 발주서 유효성 검증 + 상품목록(바코드→상품명) + 기존 박스/출고리스트 반환 |
| `POST /api/ship-scan/save` | body `{orderNumber, items:[{boxNo, boxSize, barcode, qty}]}` → 박스 upsert(없으면 생성) + (box, barcode) 합산 upsert |

- 상품명: 발주서 상품(rk_order_items)에서 매칭, 없으면 rk_inventories fallback

## 4. 메뉴/라우트

- header.html: `바코드 스캔` 옆 `<a href="/shipScan">출고스캔</a>`
- server.js: `app.get('/shipScan')` → shipScan.html

## 5. 재사용 (stockScan에서 그대로)

- 2분할 4:6 · 대형 입력폼(240px, 78px 폰트, placeholder 24px) · inputmode=none
- 확정 시 파란 배경(has-loc 패턴) · 최신행 pulse(#eff6ff) · 상품명 모델코드 배지 · 좁은 화면 상품명 줄바꿈
- 내부 스크롤 테이블 + sticky 헤더 · beforeunload 경고 · 토스트

---

## 6. 결정 완료

1. **유효한 발주서** = `rk_orders`(전체 발주서)에 존재하는 발주번호 ✅ (기존 /scan 과 동일 기준)
2. **저장 대상** = 신규 테이블 `rk_ship_boxes` + `rk_ship_box_items` ✅ (기존 /scan·rk_order_items 무영향)
3. **초과 스캔 = 차단** ✅
   - 바코드별 한도 = 발주서(rk_order_items, 박스행 제외)의 **확정수량 합**
   - 현재량 = 저장된 출고리스트 합 + 미저장 기록 합 (박스 무관, 발주서 전체 기준)
   - 한도 도달 후 스캔 시 에러 토스트("이미 확정수량만큼 스캔되었습니다") + 무반영
   - **발주서에 없는 바코드**도 차단 (토스트 "발주서에 없는 바코드입니다")
