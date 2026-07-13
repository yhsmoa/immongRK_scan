# 출고리스트 통합(rk_shipping_list) + 신규발주서 위치v2/준비v2 설계

> 작성: 2026-07-13 · 대상: 신규발주서 재고 출고배정 + 출고리스트 테이블 통합
> 결정사항: 출고수량 기준 = **발주수량** / 통합은 지금 하되 **기존 테이블·버튼 기능 무변경**

---

## 0. 목표

1. `/newOrder` 에 **[위치v2]** 버튼: 발주수량만큼 `rk_stocks` 재고에서 출고 배정 계산
   - 재고 열 = 출고 가능한(배정된) 수량, 위치 열 = 배정 위치
   - 단일 위치면 `LO-A`, 복수 위치 분할이면 `LO-A-2` ⏎ `LO-B-3`
   - 같은 바코드가 여러 행이면 위 행이 먼저 소진 → 아래 행은 남은 재고로 계산
2. **[준비v2]** 버튼: 위치v2로 계산된 배정을 **`rk_shipping_list`** 에 출고예정으로 저장
3. 출고리스트 통합: 기존 `rk_cn_shipping`(입고건)과 재고건을 `rk_shipping_list` 하나로
   - `source` = '입고' | '재고', `status` = '출고예정' (스캔 후 '출고' 는 추후 프로세스)
   - **기존 rk_cn_shipping 및 입고정리 버튼/화면은 그대로 유지** (동작 변경 없음)

---

## 1. 새 테이블 `rk_shipping_list`

```sql
create table rk_shipping_list (
  id               bigint generated always as identity primary key,
  source           text not null check (source in ('입고','재고')),
  status           text not null default '출고예정',
  barcode          text,
  product_name     text,                -- 상품명 스냅샷
  order_number     text,                -- 발주번호
  center           text,                -- 물류센터
  shipping_date    text,                -- 입고예정일
  qty              integer not null,
  location         text,                -- 재고건: 출고 위치 (위치당 1행)
  stock_id         bigint references rk_stocks(id) on delete set null,
  shipment_id      bigint references rk_cn_shipments(id) on delete cascade,
  shipment_item_id bigint references rk_cn_shipment_items(id) on delete cascade,
  cn_shipping_id   bigint,              -- 입고건: rk_cn_shipping 원본 id (sync 추적)
  batch_no         integer,
  prepared_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
```

- 재고건: (발주번호, 바코드, 위치) 배정당 1행 → 예: 출고 5 = LO-A 2 + LO-B 3 → 2행
- 입고건: 기존 rk_cn_shipping 1행 = 1행 복사 (`cn_shipping_id` 로 추적)
- 재업로드 시 shipment cascade 로 입고건 행 자동 정리 (기존 정책과 동일)

## 2. 동기화 정책 (기존 기능 무변경 원칙)

- **rk_cn_shipping 은 그대로 살아있는 원본** — 입고정리 출고준비는 기존대로 저장
- 마이그레이션: 기존 rk_cn_shipping 전량(9건) → rk_shipping_list 복사 (source='입고')
- 신규 입고건: `POST /api/inbound/prepare` 에 **비파괴 미러링**(dual-write) 추가
  - insert 성공 후 try/catch 로 rk_shipping_list 에도 복사, 실패해도 기존 응답 정상 (로그만)

## 3. 배정 계산 로직 (위치v2 / 준비v2 공용)

- 필요수량(needed) = 발주수량 − 이미 예약된 수량(rk_shipping_list, status='출고예정', 같은 발주번호+바코드, source 무관)
- 가용재고(avail) = rk_stocks.qty − 재고건 예약합계(rk_shipping_list, source='재고', status='출고예정', 같은 바코드+위치)
- 행 순서(화면 위→아래)대로 그리디 배정, 같은 바코드는 공유 풀 소진
- 위치 여러 개면 location 오름차순으로 소진
- 멱등성: 준비v2 재클릭 시 needed 가 이미 예약분만큼 줄어 0 → 중복 저장 안 됨

## 4. API (routes/rkShippingList.js 신규)

| 엔드포인트 | 동작 |
|---|---|
| `POST /api/shipping-list/stock-allocate` | body `{rows:[{orderNumber,center,shippingDate,barcode,productName,qty}], save:bool}` → 배정 계산. `save=true`(준비v2)면 rk_shipping_list 삽입까지 |
| `GET /api/shipping-list` | 통합 목록 (추후 통합 출고리스트 화면/스캔용) |

- 위치v2 = save:false (계산만, 화면 표시) / 준비v2 = save:true (저장 시점 재계산 후 저장 — 표시와 저장 일치)

## 5. UI (/newOrder)

- 버튼: [위치 불러오기] **[위치v2] [준비v2]** (기존 버튼 무변경)
- 위치v2: 선택 행(없으면 전체 뷰) → 계산 결과를 재고 열 + 위치 열에 **화면 표시만** (DB의 item location 은 건드리지 않음)
- 준비v2: 위치v2 로 표시된 행들 저장 → 토스트 "출고예정 N건 저장" → 표시 갱신
- 위치 열 복수 배정은 `<br>` 줄바꿈 표시

## 6. 건드리지 않는 것

- rk_cn_shipping 테이블/데이터, 입고정리(/inboundArrange) 출고준비·출고리스트 화면 전부
- 위치 불러오기(v1) 동작, rk_new_order_items.location 저장 방식
- 스캔에 의한 출고예정→출고 상태 전환 (추후 프로세스)
