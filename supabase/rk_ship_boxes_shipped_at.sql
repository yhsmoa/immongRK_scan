-- 쉽먼트 [출고완료] (2026-11-02, docs/plan-shipment-found-qty.md §3-3)
--   박스가 실제로 나간 시각. 있으면 순서·박스라벨·CJ 엑셀·쉽먼트 저장·모바일 입고 목록에서 빠지고, 쉽먼트 [출고] 탭에 보인다.
--   발주서의 모든 박스에 값이 생기면 rk_orders.status = 'DONE' (서버가 처리).
alter table public.rk_ship_boxes add column if not exists shipped_at timestamptz;
comment on column public.rk_ship_boxes.shipped_at is '쉽먼트 [출고완료] 시각. 있으면 이 박스는 나간 것';
create index if not exists rk_ship_boxes_shipped_at_idx on public.rk_ship_boxes (shipped_at) where shipped_at is not null;
