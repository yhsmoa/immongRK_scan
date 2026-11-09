-- ══════════════════════════════════════════════════════════════════
-- 데이터 분석 (/analytics) — 발주수량·확정수량을 일·주·월·연도로 집계
--   routes/rkAnalytics.js 가 supabase.rpc('rk_order_stats') 로 부른다.
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다. (설계: docs/plan-analytics.md)
--
-- 왜 DB 함수인가
--   품목 행(rk_order_items)이 한 달에 1만 행씩 쌓인다. 서버로 받아 와 더하면 1000행 페이지를 수십 번 돈다.
--   집계는 DB 가 한 번에 하고, 결과는 jsonb 한 덩어리로 돌려준다 (PostgREST 1000행 제한도 피한다).
--
-- 집계 규칙
--   · 원본 행만 (box_info is null) — 박스 행은 출고 스캔이 만든 분할이라 발주수량이 중복된다 (랭킹과 같은 기준).
--   · 발주수량 = rk_order_items.order_qty 합.
--   · 확정수량 = 출고스캔(rk_ship_box_items) 발주번호+바코드별 qty 합.
--       rk_order_items.confirmed_qty 는 업로드 시점(거래처확인요청) 값이라 발주수량과 항상 같다 — 쓰지 않는다.
--       쿠팡에 올리는 "발주리스트 확정" 파일의 확정수량도 같은 스캔 합이다 (routes/rkOrdersExtra.js /api/orders/export).
--   · 처리완료(DONE) 발주서의 확정수량은 끝난 값, 진행중(PROCESSING)은 지금까지 스캔한 값.
--       → _done / _open 으로 나눠 준다. 확정률은 화면에서 DONE 만으로 계산한다.
--       DONE 인데 스캔이 0 인 발주서는 전량 미납(확정 0)이다.
--   · 금액 = 수량 × 매입가(purchase_price, 부가세 포함 단가).
--   · 날짜 기준 p_basis: 'reg' = 발주등록일시(registered_at, 한국 시간 날짜) · 'arrival' = 입고예정일(arrival_date).
--       한 발주서의 품목은 모두 같은 등록일이다 (2026-10-21 확인) — 발주서 수를 날짜별로 더해도 겹치지 않는다.
--   · 주 = 월요일 시작 (date_trunc('week')).
--   · 브랜드 = 상품명 앞머리 (아이엠몽 / 이유몽 / 기타).
--   · 상품 묶음 = 상품명 끝 두 마디(색상·사이즈)를 뗀 이름 (랭킹과 같은 규칙).
-- ══════════════════════════════════════════════════════════════════

drop function if exists public.rk_order_stats(date, date, text, text, text);

create or replace function public.rk_order_stats(
  p_from   date,
  p_to     date,
  p_basis  text default 'reg',   -- 'reg' | 'arrival'
  p_brand  text default null,    -- null | '아이엠몽' | '이유몽' | '기타'
  p_center text default null     -- null | 물류센터명
)
returns jsonb
language plpgsql
stable
set search_path = public
set work_mem = '64MB'           -- count(distinct)·정렬이 디스크로 넘치지 않게 (기본값이면 주 단위 집계가 external merge)
as $$
declare
  v_len   integer;
  v_pfrom date;
  v_pto   date;
  v_out   jsonb;
begin
  if p_basis is null or p_basis not in ('reg', 'arrival') then
    raise exception 'rk_order_stats: p_basis 는 reg, arrival 중 하나여야 합니다 (받은 값: %)', p_basis;
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'rk_order_stats: 기간이 올바르지 않습니다 (% ~ %)', p_from, p_to;
  end if;
  if p_to - p_from > 1100 then
    raise exception 'rk_order_stats: 기간은 3년(1100일) 이내로 고르세요';
  end if;
  v_len   := p_to - p_from + 1;
  v_pto   := p_from - 1;            -- 바로 앞 같은 길이 기간 (비교용)
  v_pfrom := p_from - v_len;

  with
  -- 발주서+바코드 단위 줄 (전체 기간 — 연도 비교표가 기간 밖도 보므로. 필터는 브랜드·센터만)
  raw as (
    -- 문자열 키는 collate "C"(바이트 비교): 기본 정렬 규칙(en_US ICU)으로 count(distinct)·정렬을 하면 5배 느리다
    select o.id as order_id, o.order_number collate "C" as order_number, coalesce(o.status, 'PROCESSING') as status,
           coalesce(nullif(o.logistics_center, ''), '(없음)') collate "C" as center,
           i.barcode collate "C" as barcode, i.product_name,
           case when p_basis = 'arrival' then o.arrival_date
                else (i.registered_at at time zone 'Asia/Seoul')::date end as d,
           coalesce(i.order_qty, 0) as oq,
           coalesce(i.purchase_price, 0) as price,
           case when i.product_name like '아이엠몽%' then '아이엠몽'
                when i.product_name like '이유몽%'   then '이유몽'
                else '기타' end collate "C" as brand
    from rk_order_items i
    join rk_orders o on o.id = i.order_id
    where i.box_info is null
  ),
  ln as (
    select r.order_id, r.order_number, r.status, r.center, r.barcode, r.brand,
           min(r.d) as d, max(r.product_name) as product_name,
           sum(r.oq) as oq, max(r.price) as price
    from raw r
    where r.d is not null
      and (p_brand  is null or r.brand  = p_brand  collate "C")
      and (p_center is null or r.center = p_center collate "C")
    group by 1, 2, 3, 4, 5, 6
  ),
  -- 출고스캔 합: 테이블 전체를 한 번에 묶는다 (작은 테이블 — 발주번호로 좁히는 것보다 빠르다)
  sc as (
    select b.order_number collate "C" as order_number, b.barcode collate "C" as barcode, sum(coalesce(b.qty, 0)) as q
    from rk_ship_box_items b
    group by 1, 2
  ),
  line as (
    select l.*, coalesce(s.q, 0) as cq, (l.status = 'DONE') as done
    from ln l
    left join sc s on s.order_number = l.order_number and s.barcode = l.barcode
  ),
  cur  as (select * from line where d between p_from and p_to),
  -- 발주서 단위 (한 발주서는 날짜·센터·상태가 하나) — 발주서 수를 count(distinct) 대신 count(*) 로 센다
  ord  as (
    select order_id, min(d) as d, min(center) as center, bool_and(done) as done,
           sum(oq) as oq, sum(cq) as cq, sum(oq * price) as amt, sum(cq * price) as camt
    from line group by order_id
  ),
  ocur  as (select * from ord where d between p_from  and p_to),
  oprev as (select * from ord where d between v_pfrom and v_pto)
  select jsonb_build_object(
    'range',  jsonb_build_object('from', p_from, 'to', p_to, 'prevFrom', v_pfrom, 'prevTo', v_pto, 'days', v_len),
    'totals', (select jsonb_build_object(
                 'orders', count(*), 'ordersOpen', count(*) filter (where not done),
                 'skus', (select count(distinct barcode) from cur),
                 'oq', coalesce(sum(oq), 0), 'cq', coalesce(sum(cq), 0),
                 'oqDone', coalesce(sum(oq) filter (where done), 0), 'cqDone', coalesce(sum(cq) filter (where done), 0),
                 'oqOpen', coalesce(sum(oq) filter (where not done), 0), 'cqOpen', coalesce(sum(cq) filter (where not done), 0),
                 'amt', coalesce(sum(amt), 0), 'camt', coalesce(sum(camt), 0),
                 'activeDays', count(distinct d))
               from ocur),
    'prev',   (select jsonb_build_object(
                 'orders', count(*),
                 'oq', coalesce(sum(oq), 0), 'cq', coalesce(sum(cq), 0),
                 'oqDone', coalesce(sum(oq) filter (where done), 0), 'cqDone', coalesce(sum(cq) filter (where done), 0),
                 'amt', coalesce(sum(amt), 0), 'camt', coalesce(sum(camt), 0))
               from oprev),
    -- 일·주·월 시계열 (SKU 수는 단위마다 따로 센다 — 일별을 더하면 SKU 가 겹친다)
    'series', (select jsonb_object_agg(g.unit, g.rows) from (
                 select u.unit, coalesce(jsonb_agg(jsonb_build_object(
                          'p', x.p, 'orders', x.orders, 'skus', coalesce(k.skus, 0), 'oq', x.oq, 'cq', x.cq,
                          'oqDone', x.oq_done, 'cqDone', x.cq_done, 'oqOpen', x.oq_open, 'cqOpen', x.cq_open,
                          'amt', x.amt, 'camt', x.camt) order by x.p) filter (where x.p is not null), '[]'::jsonb) as rows
                 from (values ('day'), ('week'), ('month')) u(unit)
                 left join lateral (
                   select case u.unit when 'day' then o.d else date_trunc(u.unit, o.d)::date end as p,
                          count(*) as orders, sum(o.oq) as oq, sum(o.cq) as cq,
                          coalesce(sum(o.oq) filter (where o.done), 0) as oq_done, coalesce(sum(o.cq) filter (where o.done), 0) as cq_done,
                          coalesce(sum(o.oq) filter (where not o.done), 0) as oq_open, coalesce(sum(o.cq) filter (where not o.done), 0) as cq_open,
                          sum(o.amt) as amt, sum(o.camt) as camt
                   from ocur o group by 1
                 ) x on true
                 left join lateral (
                   select k1.p, count(distinct k1.barcode) as skus
                   from (select case u.unit when 'day' then c.d else date_trunc(u.unit, c.d)::date end as p, c.barcode from cur c) k1
                   group by k1.p
                 ) k on k.p = x.p
                 group by u.unit
               ) g),
    -- 요일 (1 = 월 … 7 = 일)
    'weekday', (select coalesce(jsonb_agg(jsonb_build_object('dow', w.dow, 'orders', w.orders, 'oq', w.oq, 'cq', w.cq, 'days', w.days) order by w.dow), '[]'::jsonb)
                from (select extract(isodow from d)::int as dow, count(*) as orders,
                             sum(oq) as oq, sum(cq) as cq, count(distinct d) as days
                      from ocur group by 1) w),
    'centers', (select coalesce(jsonb_agg(jsonb_build_object('name', c.center, 'orders', c.orders, 'oq', c.oq, 'cq', c.cq,
                                'oqDone', c.oq_done, 'cqDone', c.cq_done, 'amt', c.amt) order by c.oq desc), '[]'::jsonb)
                from (select center, count(*) as orders, sum(oq) as oq, sum(cq) as cq,
                             coalesce(sum(oq) filter (where done), 0) as oq_done, coalesce(sum(cq) filter (where done), 0) as cq_done,
                             sum(amt) as amt
                      from ocur group by 1) c),
    -- 브랜드: 한 발주서에 두 브랜드가 섞일 수 있어 품목 단위에서 센다 (브랜드별 발주서 수의 합 ≥ 전체 발주서 수)
    'brands',  (select coalesce(jsonb_agg(jsonb_build_object('name', b.brand, 'orders', b.orders, 'skus', b.skus, 'oq', b.oq, 'cq', b.cq,
                                'oqDone', b.oq_done, 'cqDone', b.cq_done, 'amt', b.amt) order by b.oq desc), '[]'::jsonb)
                from (select brand, count(distinct order_id) as orders, count(distinct barcode) as skus, sum(oq) as oq, sum(cq) as cq,
                             coalesce(sum(oq) filter (where done), 0) as oq_done, coalesce(sum(cq) filter (where done), 0) as cq_done,
                             sum(oq * price) as amt
                      from cur group by 1) b),
    -- 상품 묶음: 발주수량 상위 50 + 미확정(DONE 발주 − DONE 확정) 상위 50 (겹치면 하나)
    'products', (with pb as (      -- 바코드 단위로 먼저 더하고, 상품명 정리(정규식)는 바코드마다 한 번만
                   select barcode, max(product_name) as product_name, sum(oq) as oq, sum(cq) as cq,
                          coalesce(sum(oq) filter (where done), 0) as oq_done, coalesce(sum(cq) filter (where done), 0) as cq_done
                   from cur where product_name is not null group by barcode
                 ), pg as (
                   select regexp_replace(product_name, '(,[^,]*){2}$', '') as pname, count(*) as opts,
                          sum(oq) as oq, sum(cq) as cq, sum(oq_done) as oq_done, sum(cq_done) as cq_done
                   from pb group by 1
                 ), pick as (
                   (select pname from pg order by oq desc, pname limit 50)
                   union
                   (select pname from pg order by (oq_done - cq_done) desc, pname limit 50)
                 )
                 select coalesce(jsonb_agg(jsonb_build_object('name', pg.pname, 'opts', pg.opts, 'oq', pg.oq, 'cq', pg.cq,
                                 'oqDone', pg.oq_done, 'cqDone', pg.cq_done) order by pg.oq desc), '[]'::jsonb)
                 from pg join pick using (pname)),
    -- 연도 × 월 (기간과 무관하게 전체. 브랜드·센터 필터는 적용)
    'years', (select coalesce(jsonb_agg(jsonb_build_object('y', y.y, 'm', y.m, 'orders', y.orders, 'oq', y.oq, 'cq', y.cq,
                              'oqDone', y.oq_done, 'cqDone', y.cq_done, 'amt', y.amt) order by y.y, y.m), '[]'::jsonb)
              from (select extract(year from d)::int as y, extract(month from d)::int as m,
                           count(*) as orders, sum(oq) as oq, sum(cq) as cq,
                           coalesce(sum(oq) filter (where done), 0) as oq_done, coalesce(sum(cq) filter (where done), 0) as cq_done,
                           sum(amt) as amt
                    from ord group by 1, 2) y),
    'meta', (select jsonb_build_object('minDate', min(d), 'maxDate', max(d)) from ord)
  ) into v_out;

  -- 필터 목록용 센터 이름 (필터와 무관하게 전체)
  v_out := v_out || jsonb_build_object('centerList',
    (select coalesce(jsonb_agg(c order by n desc), '[]'::jsonb)
     from (select coalesce(nullif(logistics_center, ''), '(없음)') as c, count(*) as n from rk_orders group by 1) t));

  return v_out;
end;
$$;

-- 매출(매입가) 집계라 브라우저(anon 키)에서 직접 부르지 못하게 한다 — 서버(service_role)만
revoke execute on function public.rk_order_stats(date, date, text, text, text) from public, anon, authenticated;
grant  execute on function public.rk_order_stats(date, date, text, text, text) to service_role;
