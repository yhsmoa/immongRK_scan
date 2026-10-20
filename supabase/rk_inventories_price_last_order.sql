-- ══════════════════════════════════════════════════════════════════
-- 재고관리(rk_inventories) 매입가·공급가·부가세·최근발주등록일 (2026-10-20)
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
-- 왜
--   재고관리 표에 매입가와 최근 발주일을 보여 달라는 요청. 값의 출처는 쿠팡 발주서(신규발주서 등록).
--
-- 규칙
--   · 신규발주서 [등록](routes/rkNewOrders.js POST /api/neworders/register) 때 그 발주서들의 상품을
--     바코드 기준으로 rk_inventories 에 반영한다 — 이 4개 열만 덮어쓴다 (비어 있으면 채우고, 다르면 최신 값으로).
--   · 같은 바코드가 여러 발주서에 있으면 발주등록일시(registered_at)가 가장 최근인 값을 쓴다.
--   · 재고관리에 없는 바코드는 건너뛴다 (행을 새로 만들지 않는다).
--   · last_ordered_at = 그 상품의 발주등록일시 (쿠팡 파일의 '발주등록일시').
-- ══════════════════════════════════════════════════════════════════

alter table public.rk_inventories
  add column if not exists purchase_price integer,
  add column if not exists supply_price integer,
  add column if not exists vat integer,
  add column if not exists last_ordered_at timestamptz;

comment on column public.rk_inventories.purchase_price is '매입가 — 신규발주서 등록 시 최신 발주 상품의 값으로 갱신';
comment on column public.rk_inventories.supply_price is '공급가 — 신규발주서 등록 시 갱신';
comment on column public.rk_inventories.vat is '부가세 — 신규발주서 등록 시 갱신';
comment on column public.rk_inventories.last_ordered_at is '최근발주등록일 — 신규발주서 등록 시 그 상품의 발주등록일시(최신)';
