-- ══════════════════════════════════════════════════════════════════
-- 상품부족 현황 스냅샷 (/shortage [스냅샷])
--   server.js 의 /api/shortage/snapshots 가 쓴다.
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
-- 무엇을 저장하나
--   [스냅샷] 을 누른 순간 화면에 불러와 있던 행 전체(검색·표시 여부 무관)와 그때의 입력 수량,
--   조회 조건(모드·기간)을 이름을 붙여 통째로 보관한다.
--   이후 발주서가 지워지거나 처리완료되거나 입력값이 바뀌어도, 드롭다운에서 이름을 고르면
--   저장 당시 상태가 그대로 복원된다.
--   임시저장(coupang_order_save_temp)은 스냅샷 저장 때 건드리지 않는다.
--   불러올 때는 입력값을 임시저장에도 덮어써서 이우/위해 주문 복사·입력목록 등이 그 상태로 동작한다.
--
-- 열 규칙
--   · 헤더에 보이는 열은 각각 컬럼으로 둔다 (SKU, 바코드, 상품이름, Ord, Scan, Fail, 입력, 잔여,
--     주문, 재고, C 예상, C 예상 2W, -7-8W, -5-6W, -3-4W, -1-2W).
--   · row 는 /api/shortage 가 내려준 행 객체 원본(jsonb). 복원은 이 값을 그대로 쓰므로
--     이미지·배지처럼 헤더에 없는 필드도 빠지지 않는다. 개별 컬럼은 조회·확인용이다.
--   · seq 는 저장 당시 allData 순서. 복원 뒤 정렬은 화면 규칙대로 다시 한다.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.rk_shortage_snapshots (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  mode         text,                 -- all | shortage | pending
  start_date   date,
  end_date     date,
  row_count    integer not null default 0,
  input_count  integer not null default 0,   -- 입력 수량이 있는 행 수
  created_at   timestamptz not null default now()
);

create table if not exists public.rk_shortage_snapshot_items (
  id             bigserial primary key,
  snapshot_id    uuid not null references public.rk_shortage_snapshots(id) on delete cascade,
  seq            integer not null,
  sku_id         text,
  barcode        text,
  product_name   text,
  img            text,
  order_qty      integer,      -- Ord  (총발주수량)
  scan_qty       integer,      -- Scan (총스캔수량)
  shortage_qty   integer,      -- Fail (부족수량)
  input_qty      integer,      -- 입력
  remain_qty     integer,      -- 잔여 (remainQty)
  yiwu_qty       integer,      -- 주문 (yiwuTotalQty)
  stock_qty      integer,      -- 재고
  c_forecast     numeric,      -- C 예상
  c_forecast_2w  numeric,      -- C 예상 2W
  w78            integer,
  w56            integer,
  w34            integer,
  w12            integer,
  row            jsonb not null   -- 행 객체 원본 (복원 기준)
);

create index if not exists idx_rk_shortage_snapshot_items_snapshot
  on public.rk_shortage_snapshot_items (snapshot_id, seq);
