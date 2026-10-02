-- ══════════════════════════════════════════════════════════════════
-- 발주 랭킹 (/ranking) — 상품 단위 발주수량 순위
--   routes/rkRanking.js 가 supabase.rpc('rk_order_ranking') 로 부른다.
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
-- 왜 DB 함수인가
--   발주 품목(rk_order_items)은 계속 쌓인다. 행을 서버로 다 받아 와 더하면 1000행 페이지를 수십 번
--   돌아야 하고 갈수록 느려진다. 합계·순위는 DB 가 한 번에 계산하고 결과(최대 p_limit 행)만 돌려준다.
--
-- 집계 규칙
--   · 원본 행만 (box_info is null) — 박스 행은 출고 스캔이 만든 분할이라 발주수량이 중복된다.
--     발주서 헤더 집계(recalcHeaderAggregates)와 같은 기준.
--   · 처리완료(DONE) 발주서도 포함 — 얼마나 발주가 들어왔는지를 보는 화면이다.
--   · 날짜 기준은 발주등록일시(registered_at), 한국 시간 달력 날짜.
--       d1 = 오늘 · d7 = 오늘 포함 최근 7일 · d30 = 30일 · d90 = 90일
--   · 상품 묶음: 발주서에는 상품 ID 가 없고 상품명이 "상품명, 색상, 사이즈" 꼴이다.
--     끝의 두 마디(색상·사이즈)를 뗀 이름이 같으면 한 상품으로 본다.
--     쉼표가 두 개 미만인 이름은 그대로 한 상품이다.
--   · 한 바코드의 이름이 발주서마다 다르면 가장 최근 발주서의 이름을 쓴다.
--   · 기준 값이 0 인 상품은 순위에서 뺀다. 동점은 상품명 순.
--   · 재고는 rk_stocks, 이미지는 rk_inventories, 별점·리뷰 수는 rk_coupang_info 에서 바코드로 붙인다
--     (순위에 든 상품의 옵션만 조회).
-- ══════════════════════════════════════════════════════════════════

-- 기간 조건(registered_at >= …)용 — 90일보다 오래된 행이 쌓일수록 효과가 난다
create index if not exists idx_rk_order_items_registered_at
  on public.rk_order_items (registered_at);

-- 반환 열을 바꿀 때는 create or replace 로 안 되므로 먼저 지운다
drop function if exists public.rk_order_ranking(text, integer);

create or replace function public.rk_order_ranking(p_basis text default 'd7', p_limit integer default 20)
returns table (
  rank          integer,
  product_name  text,     -- 색상·사이즈를 뗀 상품명 (상품 묶음 키)
  option_count  integer,  -- 90일 안에 발주된 옵션(바코드) 수
  d1            bigint,   -- 발주수량: 오늘
  d7            bigint,   --          최근 7일
  d30           bigint,   --          최근 30일
  d90           bigint,   --          최근 90일
  confirmed     bigint,   -- 기준 기간의 확정수량
  order_count   bigint,   -- 기준 기간에 이 상품이 들어 있던 발주서 수
  stock         bigint,   -- 현재 창고 재고 합 (rk_stocks.qty — 로케이션별 행을 모두 더한다)
  img           text,     -- 기준 기간 발주수량이 가장 많은 옵션의 이미지 (rk_inventories.img)
  rating_avg    numeric,  -- 쿠팡 별점 (rk_coupang_info — 상품부족 화면의 수집 결과). 없으면 null
  review_count  integer   -- 쿠팡 리뷰 수. 없으면 null
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_today  timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  v_days   integer;
  v_from   timestamptz;
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  v_days := case p_basis when 'd1' then 1 when 'd7' then 7 when 'd30' then 30 when 'd90' then 90 end;
  if v_days is null then
    raise exception 'rk_order_ranking: p_basis 는 d1, d7, d30, d90 중 하나여야 합니다 (받은 값: %)', p_basis;
  end if;
  v_from := v_today - make_interval(days => v_days - 1);

  return query
  with item as (   -- 최근 90일 원본 행
    select i.barcode, i.order_id, i.product_name as item_name, i.registered_at,
           coalesce(i.order_qty, 0) as oq, coalesce(i.confirmed_qty, 0) as cq
    from rk_order_items i
    where i.box_info is null
      and i.product_name is not null
      and i.registered_at >= v_today - interval '89 days'
  ),
  sku as (         -- 바코드 단위 합계 (상품명 정리는 여기서 한 번만 — 행마다 하면 느리다)
    select t.barcode,
           regexp_replace((array_agg(t.item_name order by t.registered_at desc))[1], '(,[^,]*){2}$', '') as pname,
           sum(t.oq) filter (where t.registered_at >= v_today)                         as s1,
           sum(t.oq) filter (where t.registered_at >= v_today - interval '6 days')    as s7,
           sum(t.oq) filter (where t.registered_at >= v_today - interval '29 days')   as s30,
           sum(t.oq)                                                                   as s90,
           sum(t.oq) filter (where t.registered_at >= v_from)                          as sbasis,
           sum(t.cq) filter (where t.registered_at >= v_from)                          as cbasis
    from item t
    group by t.barcode
  ),
  prod as (        -- 상품 단위 합계
    select s.pname,
           count(*)::integer            as n_opt,
           coalesce(sum(s.s1), 0)::bigint     as p1,
           coalesce(sum(s.s7), 0)::bigint     as p7,
           coalesce(sum(s.s30), 0)::bigint    as p30,
           coalesce(sum(s.s90), 0)::bigint    as p90,
           coalesce(sum(s.sbasis), 0)::bigint as pbasis,
           coalesce(sum(s.cbasis), 0)::bigint as pconfirmed
    from sku s
    group by s.pname
  ),
  ranked as (
    select p.*, row_number() over (order by p.pbasis desc, p.pname)::integer as rn
    from prod p
    where p.pbasis > 0
    order by p.pbasis desc, p.pname
    limit v_limit
  ),
  picked as (      -- 순위에 든 상품의 옵션들 — 아래 부가 값은 이것만 대상으로 한 번씩 계산한다
    select s.pname, s.barcode, s.sbasis
    from sku s join ranked r on r.pname = s.pname
  ),
  oc as (          -- 기준 기간의 발주서 수
    select p.pname, count(distinct t.order_id) as n
    from item t join picked p on p.barcode = t.barcode
    where t.registered_at >= v_from
    group by p.pname
  ),
  st as (          -- 창고 재고
    select p.pname, sum(k.qty) as q
    from picked p join rk_stocks k on k.barcode = p.barcode
    group by p.pname
  ),
  im as (          -- 대표 이미지
    select distinct on (p.pname) p.pname, v.img as url
    from picked p join rk_inventories v on v.barcode = p.barcode
    where coalesce(v.img, '') <> ''
    order by p.pname, p.sbasis desc nulls last, p.barcode
  ),
  rv as (          -- 별점 · 리뷰 수: 쿠팡에서는 상품 단위 값이라 옵션마다 같다. 리뷰 수가 가장 많은(가장 최근에 수집된) 옵션 것을 쓴다
    select distinct on (p.pname) p.pname, c.rating_avg as rating, c.review_count as reviews
    from picked p join rk_coupang_info c on c.barcode = p.barcode
    where c.rating_avg > 0
    order by p.pname, c.review_count desc nulls last, p.barcode
  )
  select r.rn, r.pname, r.n_opt, r.p1, r.p7, r.p30, r.p90, r.pconfirmed,
         coalesce(oc.n, 0)::bigint, coalesce(st.q, 0)::bigint, im.url, rv.rating, rv.reviews
  from ranked r
  left join oc on oc.pname = r.pname
  left join st on st.pname = r.pname
  left join im on im.pname = r.pname
  left join rv on rv.pname = r.pname
  order by r.rn;
end;
$$;
