-- ══════════════════════════════════════════════════════════════════
-- 내보내기 이력 (2026-10-20) — 확정·쉽먼트·CJ 파일을 언제 어떤 값으로 만들었나
--   routes/rkOrdersExtra.js 의 POST /api/orders/export · /api/shipment/export · /api/shipment/export-cj 가 쓴다.
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
-- 왜
--   어느 시점의 파일을 쿠팡에 올렸는지 앱에 기록이 없어, 발주서 144286429 에서 "가상스캔이 확정에
--   빠졌다"는 의문이 생겼을 때 Railway http 로그 시각으로만 추정해야 했다.
--   rk_orders.confirmed_qty / coupang_order_history.confirmed_qty 는 최초 업로드 값이고
--   재업로드는 중복으로 건너뛰므로 "파일에 적힌 값"은 따로 남겨야 한다.
--
-- 규칙
--   · 파일을 만들 때마다 rk_export_logs 1행 + 파일의 행마다 rk_export_log_items 1행.
--   · 기록이 실패해도 파일 응답은 그대로 내려간다 (console.error 만).
--   · kind: '확정'(발주리스트 확정) | '쉽먼트'(shipment) | 'CJ'(CJ 운송장 접수)
--   · confirmed_qty = 그 파일에 적힌 값
--       확정   → 확정수량 열 (= rk_ship_box_items.qty 합, 가상 분량 포함)
--       쉽먼트 → 납품수량(Shipped Qty) 열 (박스별 스캔수량), box_info = '박스번호-크기'
--       CJ     → 수량 없음(박스 단위), box_info = '박스번호-박스타입'
--   · virtual_qty = confirmed_qty 중 [가상스캔] 분량 (rk_ship_box_items.virtual_qty)
--   · 조회: GET /api/export-logs?orderNumber= (/api/orders/… 는 :orderNumber 라우트에 가로채임) → rocket.html 발주번호 옆 ⏱ (내보내기 이력)
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.rk_export_logs (
  id           bigserial primary key,
  kind         text not null check (kind in ('확정','쉽먼트','CJ')),
  exported_at  timestamptz not null default now(),
  order_count  integer not null default 0,   -- 파일에 들어간 발주서 수
  row_count    integer not null default 0,   -- 파일의 데이터 행 수
  filename     text
);

create table if not exists public.rk_export_log_items (
  id             bigserial primary key,
  log_id         bigint not null references public.rk_export_logs(id) on delete cascade,
  order_number   text not null,
  barcode        text,
  order_qty      integer,      -- 발주수량
  confirmed_qty  integer,      -- 파일에 적힌 값 (확정수량 / 납품수량)
  virtual_qty    integer,      -- 그중 가상스캔 분량
  box_info       text          -- 쉽먼트·CJ: '박스번호-크기'
);

create index if not exists idx_rk_export_log_items_order
  on public.rk_export_log_items (order_number, log_id);
create index if not exists idx_rk_export_log_items_log
  on public.rk_export_log_items (log_id);
create index if not exists idx_rk_export_logs_exported_at
  on public.rk_export_logs (exported_at desc);
