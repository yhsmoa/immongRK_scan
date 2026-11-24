-- ══════════════════════════════════════════════════════════════════
-- 사입관리 '이우주문' 열 (/shortage, 2026-11-24) — rk_weihai_route.sql 의 뜻을 뒤집는다
--   이 파일은 DB 에 적용한 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
--   예전(2026-10-28)  🌳·🌱 → 위해 주문 / 빈칸 → 이우 주문   (rk_inventories.weihai_order)
--   지금(2026-11-24)  🌳·🌱 → 이우 주문 / 빈칸 → 위해 주문   (rk_inventories.yiwu_order)
--
-- rk_inventories.yiwu_order
--   true = 이 상품은 항상 이우로 주문한다 (/shortage 에서 🌳 로 처음부터 표시, /inventory '이우주문' 열).
--   /shortage 에서 [저장] 하거나 주문을 넣을 때(이우·위해 복사, 장바구니 담기) 그 행의 표시대로 바뀐다
--     (빈칸 → false · 🌳 → true · 🌱 → false · 위해 → true). 상품 동기화는 이 칼럼을 건드리지 않는다.
--   새 칼럼이라 처음엔 전부 false = 예전 🌳 는 초기화된 상태로 시작한다.
--
-- route_mark — 행마다 고른 표시 (임시저장 · 스냅샷에 입력 수량과 함께 보관)
--   none(빈칸·항상 위해) | tree(🌳 항상 이우) | sprout(🌱 이번만 이우) | weihai(위해 배지·이번만 위해)
--   null = 고른 적 없음 → 상품정보(yiwu_order)대로 (true 🌳 / 아니면 빈칸)
--   예전 표시는 뜻이 반대라 코드 배포 뒤 null 로 비운다 (아래 3 — 입력 수량은 그대로)
--
-- rk_inventories.weihai_order — 더 이상 읽지 않는다. 되돌릴 때를 위해 값은 그대로 두고, 배포가 안정되면 지운다 (아래 4)
-- ══════════════════════════════════════════════════════════════════

-- 1) 항상 이우 표시 — 새 칼럼 (예전 코드는 이 칼럼을 모르므로 배포 전에 넣어도 영향 없음)
alter table public.rk_inventories
  add column if not exists yiwu_order boolean not null default false;
comment on column public.rk_inventories.yiwu_order is
  '사입관리(/shortage) 항상 이우로 주문 (🌳). false = 위해. 2026-11-24 weihai_order 를 대신함';

-- 2) route_mark 4번째 표시 yiwu(이번만 이우) → weihai(이번만 위해)
--    배포 전 예전 코드가 저장하는 none·tree·sprout 은 그대로 받는다 (예전 yiwu 표시는 지금 0건)
do $$
declare r record;
begin
  for r in
    select conrelid::regclass as t, conname
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.coupang_order_save_temp'::regclass, 'public.rk_shortage_snapshot_items'::regclass)
       and pg_get_constraintdef(oid) like '%route_mark%'
  loop
    execute format('alter table %s drop constraint %I', r.t, r.conname);
  end loop;
end $$;

alter table public.coupang_order_save_temp
  add constraint coupang_order_save_temp_route_mark_check
  check (route_mark in ('none', 'tree', 'sprout', 'weihai'));
alter table public.rk_shortage_snapshot_items
  add constraint rk_shortage_snapshot_items_route_mark_check
  check (route_mark in ('none', 'tree', 'sprout', 'weihai'));

-- 3) 예전 표시 비우기 — 코드 배포 직후 서버 키로 실행함 (2026-11-24). 입력 수량은 건드리지 않는다
-- update public.coupang_order_save_temp set route_mark = null where route_mark is not null;
-- delete from public.coupang_order_save_temp where qty is null and route_mark is null;   -- 표시만 있던 행
-- update public.rk_shortage_snapshot_items set route_mark = null where route_mark is not null;

-- ── 확인 ──
-- select count(*) filter (where yiwu_order) as yiwu, count(*) filter (where weihai_order) as old_weihai from public.rk_inventories;
-- select route_mark, count(*) from public.coupang_order_save_temp group by 1;

-- 4) 배포가 안정되면 (예전 값이 필요 없을 때)
-- alter table public.rk_inventories drop column weihai_order;

-- ── 롤백 ── (코드를 이 커밋 전으로 되돌린 뒤)
-- alter table public.coupang_order_save_temp drop constraint if exists coupang_order_save_temp_route_mark_check;
-- alter table public.coupang_order_save_temp add constraint coupang_order_save_temp_route_mark_check check (route_mark in ('none', 'tree', 'sprout', 'yiwu'));
-- alter table public.rk_shortage_snapshot_items drop constraint if exists rk_shortage_snapshot_items_route_mark_check;
-- alter table public.rk_shortage_snapshot_items add constraint rk_shortage_snapshot_items_route_mark_check check (route_mark in ('none', 'tree', 'sprout', 'yiwu'));
-- alter table public.rk_inventories drop column if exists yiwu_order;
