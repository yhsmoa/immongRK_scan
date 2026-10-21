-- 모바일 입고 메모 (2026-10-21) — immong-rocket 에 적용됨 (migration mobile_memo_columns)
-- 카드(출고리스트 행)마다 한 줄 메모. 입고 행은 rk_cn_shipping(원본) + rk_shipping_list(미러) 둘 다, 재고 행은 rk_shipping_list 만.
alter table public.rk_cn_shipping
  add column if not exists mobile_memo text,
  add column if not exists mobile_memo_at timestamptz,
  add column if not exists mobile_memo_by text;
alter table public.rk_shipping_list
  add column if not exists mobile_memo text,
  add column if not exists mobile_memo_at timestamptz,
  add column if not exists mobile_memo_by text;
