-- ══════════════════════════════════════════════════════════════════
-- 상품부족 '위해주문' 열 (/shortage, 2026-10-28)
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
-- rk_inventories.weihai_order
--   true = 이 상품은 항상 위해로 주문한다 (/shortage 에서 🌳 로 처음부터 표시, /inventory '위해주문' 열).
--   /shortage 에서 주문을 넣을 때(이우·위해 복사, 장바구니 담기) 그 행의 표시대로 바뀐다
--     (빈칸 → false · 🌳 → true · 🌱 → false · 이우 → true). 상품 동기화는 이 칼럼을 건드리지 않는다.
--
-- route_mark — 행마다 고른 표시 (임시저장 · 스냅샷에 입력 수량과 함께 보관)
--   none(빈칸·항상 이우) | tree(🌳 항상 위해) | sprout(🌱 이번만 위해) | yiwu(이우 배지·이번만 이우)
--   null = 고른 적 없음 → 상품정보(weihai_order)대로 (true 🌳 / 아니면 빈칸)
-- ══════════════════════════════════════════════════════════════════

alter table public.rk_inventories
  add column if not exists weihai_order boolean not null default false;

alter table public.coupang_order_save_temp
  add column if not exists route_mark text
  check (route_mark in ('none', 'tree', 'sprout', 'yiwu'));

alter table public.rk_shortage_snapshot_items
  add column if not exists route_mark text
  check (route_mark in ('none', 'tree', 'sprout', 'yiwu'));
