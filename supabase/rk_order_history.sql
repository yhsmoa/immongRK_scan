-- ══════════════════════════════════════════════════════════════════
-- 과거 발주 이력 (2026-11-12) — 운영 DB(rk_orders, 2026-07-27 입고예정분부터) 이전의 쿠팡 발주 SKU 자료
--   데이터 분석(/analytics)이 2022년부터 이어서 보려고 넣는다. rk_order_stats 가 운영 자료와 합쳐 집계한다.
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다. (설계: docs/plan-analytics.md §6)
--
-- 왜 운영 테이블(rk_orders / rk_order_items)에 넣지 않나
--   · 운영 화면(발주서 목록 · 출고스캔 · 랭킹)에 1만 건이 섞이면 안 된다.
--   · 과거 자료는 출고스캔 기록이 없다 → 확정수량을 파일의 확정수량 열에서 읽어야 한다 (운영은 스캔 합).
--   · 다시 바뀌지 않는 자료라 미리 더해 둔 요약(rk_order_history_ord)으로 빠르게 읽을 수 있다.
--
-- 원본
--   쿠팡 서플라이어 허브 "발주 SKU 목록" 엑셀 (발주번호 × SKU 1행).
--   적재: node scripts/load-order-history.js <엑셀 경로>   (검증 → upsert → 요약 다시 만들기 → DB 를 다시 읽어 대조)
--
-- 테이블
--   rk_order_history      발주번호 × 바코드 1행 (원본 그대로). 유일키 (order_number, barcode)
--   rk_order_history_ord  발주번호 × 브랜드 1행 요약 — rk_order_history_rebuild() 가 원본에서 다시 만든다 (직접 고치지 않는다)
--
-- 규칙 (rk_order_stats 와 맞춘다)
--   · brand   = 상품명 앞머리 (아이엠몽 / 이유몽 / 기타) — 생성 열이라 규칙이 한 곳(이 파일)에만 있다. rk_order_stats 의 운영 쪽 규칙과 같아야 한다.
--   · reg_date = 발주일(ordered_at)의 한국 날짜 — 생성 열. 운영의 (registered_at at time zone 'Asia/Seoul')::date 와 같은 규칙.
--   · 확정수량 = 파일의 확정수량(쿠팡에 확정해 올린 값). 과거 발주서는 모두 끝난 것(처리완료)으로 본다.
--   · 금액 = 수량 × 매입가(부가세 포함 단가).
--   · 문자열 키(발주번호 · 바코드 · 센터 · 브랜드)는 collate "C" — 기본(en_US ICU) 정렬로 count(distinct)·정렬을 하면 5배 느리다.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.rk_order_history (
  id              bigint generated always as identity primary key,
  order_number    text collate "C" not null,                 -- 발주번호
  barcode         text collate "C" not null,                 -- SKU Barcode
  sku_id          text,                                      -- SKU ID (쿠팡 상품번호)
  product_name    text not null,                             -- SKU 이름 (앞뒤 공백은 적재 때 뗀다)
  brand           text collate "C" generated always as (
                    case when product_name like '아이엠몽%' then '아이엠몽'
                         when product_name like '이유몽%'   then '이유몽'
                         else '기타' end) stored,
  center          text collate "C" not null,                 -- 물류센터
  arrival_date    date not null,                             -- 입고예정일
  ordered_at      timestamptz not null,                      -- 발주일 (파일의 한국 시각)
  reg_date        date generated always as ((ordered_at at time zone 'Asia/Seoul')::date) stored,
  order_type      text,                                      -- 발주유형 (일반 / 행사 / 매입용)
  order_status    text,                                      -- 발주현황 (거래명세서확인 …)
  order_qty       integer not null check (order_qty >= 0),       -- 발주수량
  confirmed_qty   integer not null check (confirmed_qty >= 0),   -- 확정수량
  received_qty    integer not null check (received_qty >= 0),    -- 입고수량 (쿠팡이 실제로 받은 수량)
  purchase_price  numeric not null check (purchase_price >= 0),  -- 매입가(VAT 포함)
  supply_price    numeric,                                   -- 공급가
  vat             numeric,                                   -- 부가세
  source_file     text,                                      -- 적재한 엑셀 파일 이름
  loaded_at       timestamptz not null default now(),
  constraint rk_order_history_uq unique (order_number, barcode)
);

-- 기간으로 줄을 읽는 색인 (rk_order_stats 의 hcur — 날짜 기준 둘)
create index if not exists rk_order_history_reg_idx     on public.rk_order_history (reg_date);
create index if not exists rk_order_history_arrival_idx on public.rk_order_history (arrival_date);

create table if not exists public.rk_order_history_ord (
  order_number  text collate "C" not null,
  brand         text collate "C" not null,
  center        text collate "C" not null,
  reg_date      date not null,
  arrival_date  date not null,
  lines         integer not null,      -- 이 발주서 · 브랜드의 SKU 줄 수
  oq            bigint  not null,      -- 발주수량 합
  cq            bigint  not null,      -- 확정수량 합
  rq            bigint  not null,      -- 입고수량 합
  amt           numeric not null,      -- 발주수량 × 매입가 합
  camt          numeric not null,      -- 확정수량 × 매입가 합
  primary key (order_number, brand)
);

-- 매입가가 들어 있다 — 브라우저(anon 키)로는 못 읽게. 서버(service_role)는 RLS 를 건너뛴다
alter table public.rk_order_history     enable row level security;
alter table public.rk_order_history_ord enable row level security;
grant all on table public.rk_order_history, public.rk_order_history_ord to service_role;

-- ── 점검: 원본 합계 · 요약 합계 · 운영 테이블과 겹치는 발주번호 수 ──
--   적재 스크립트가 엑셀 합계와 대조한다. raw 와 ord 의 lines/oq/cq/rq/amt/camt 는 항상 같아야 한다.
create or replace function public.rk_order_history_check()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'raw', (select jsonb_build_object(
              'lines', count(*), 'orders', count(distinct order_number), 'barcodes', count(distinct barcode),
              'oq', coalesce(sum(order_qty), 0), 'cq', coalesce(sum(confirmed_qty), 0), 'rq', coalesce(sum(received_qty), 0),
              'amt', coalesce(sum(order_qty * purchase_price), 0), 'camt', coalesce(sum(confirmed_qty * purchase_price), 0),
              'minArrival', min(arrival_date), 'maxArrival', max(arrival_date), 'minReg', min(reg_date), 'maxReg', max(reg_date))
            from rk_order_history),
    'ord', (select jsonb_build_object(
              'rows', count(*), 'orders', count(distinct order_number), 'lines', coalesce(sum(lines), 0),
              'oq', coalesce(sum(oq), 0), 'cq', coalesce(sum(cq), 0), 'rq', coalesce(sum(rq), 0),
              'amt', coalesce(sum(amt), 0), 'camt', coalesce(sum(camt), 0))
            from rk_order_history_ord),
    -- 운영 테이블에도 있는 발주번호 (0 이어야 한다. 있으면 rk_order_stats 는 운영 쪽만 센다)
    'overlapLive', (select count(*) from (select distinct order_number from rk_order_history) h
                    where exists (select 1 from rk_orders o where o.order_number collate "C" = h.order_number)),
    'brands', (select coalesce(jsonb_object_agg(brand, n), '{}'::jsonb) from (select brand, count(*) as n from rk_order_history group by 1) b)
  );
$$;

-- ── 요약 다시 만들기 — 원본(rk_order_history)을 넣거나 고친 뒤 반드시 부른다 (적재 스크립트가 부른다) ──
--   한 트랜잭션이라 읽는 쪽(rk_order_stats)은 예전 요약 아니면 새 요약만 본다.
--   delete 에 where true: API(PostgREST) 세션은 WHERE 없는 DELETE 를 거부한다 (safeupdate).
create or replace function public.rk_order_history_rebuild()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_bad integer;
begin
  -- 한 발주서 = 센터 · 입고예정일 · 발주일 하나. 어긋나면 발주서 단위 집계가 틀어지므로 멈춘다
  select count(*) into v_bad
  from (select order_number from rk_order_history group by order_number
        having count(distinct center) > 1 or count(distinct arrival_date) > 1 or count(distinct reg_date) > 1) t;
  if v_bad > 0 then
    raise exception 'rk_order_history_rebuild: 센터·입고예정일·발주일이 줄마다 다른 발주서가 %건 있습니다', v_bad;
  end if;

  delete from rk_order_history_ord where true;
  insert into rk_order_history_ord (order_number, brand, center, reg_date, arrival_date, lines, oq, cq, rq, amt, camt)
  select order_number, brand, min(center), min(reg_date), min(arrival_date), count(*),
         sum(order_qty), sum(confirmed_qty), sum(received_qty),
         sum(order_qty * purchase_price), sum(confirmed_qty * purchase_price)
  from rk_order_history
  group by order_number, brand;

  return rk_order_history_check();
end;
$$;

-- 매입 금액이 나오므로 서버(service_role)만
revoke execute on function public.rk_order_history_check()   from public, anon, authenticated;
revoke execute on function public.rk_order_history_rebuild() from public, anon, authenticated;
grant  execute on function public.rk_order_history_check()   to service_role;
grant  execute on function public.rk_order_history_rebuild() to service_role;

-- 새 테이블 · 함수를 API(PostgREST)가 바로 보게
notify pgrst, 'reload schema';
