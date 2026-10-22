-- ══════════════════════════════════════════════════════════════════
-- 쉽먼트 서류 등록 (2026-10-22) — 쿠팡 부착문서·동봉문서 PDF 를 박스별로 보관
--   routes/rkShipDocs.js 의 POST /api/shipment/docs/register · /api/shipment/docs/print 가 쓴다.
--   이 파일은 DB 에 적용된 정의의 사본이다 — 고칠 때는 여기와 DB 를 같이 고친다.
--
-- 왜
--   발주서 하나의 박스가 한 번에 다 나가지 않는다 (오늘 3박스, 이틀 뒤 2박스).
--   그동안 [순서정리] 는 PDF 를 올릴 때마다 분석만 하고 파일을 버려서, 나갈 때마다 쿠팡 PDF 를 다시 올려야 했고
--   순서 없는 박스까지 "(순서X)" 로 뒤에 붙어 나왔다.
--   이제 [쉽먼트 등록] 때 장을 박스별로 쪼개 Storage 에 두고, [순서대로] 탭에서 순서 지정된 박스만 골라 합쳐 뽑는다.
--
-- 규칙
--   · 박스 하나 = (order_number, box_no). kind 별로 한 파일 — label(부착문서, 1장) · manifest(동봉문서, 1장 이상).
--   · 같은 박스를 다시 등록하면 덮어쓴다 (unique + upsert, storage 도 upsert).
--   · 순서(rk_ship_seq)와 무관하다 — 순서를 지우거나 다시 찍어도 서류는 남는다. 나중에 순서가 잡히면 그때 출력된다.
--   · 서버는 service role 로만 접근한다 (RLS 정책 없음, 버킷 비공개).
-- ══════════════════════════════════════════════════════════════════

create table if not exists rk_ship_docs (
  id           bigserial primary key,
  order_number text not null,
  box_no       integer not null,
  kind         text not null check (kind in ('label','manifest')),
  path         text not null,                 -- storage 경로: {발주번호}/{박스번호}/{kind}.pdf
  pages        integer not null default 1,    -- 동봉문서는 한 박스가 여러 장일 수 있다
  pbl          text,                          -- 쿠팡 쉽먼트 바코드 (부착↔동봉 짝 열쇠)
  invoice_no   text,                          -- 그 장에 찍힌 CJ 운송장번호
  uploaded_at  timestamptz not null default now(),
  unique (order_number, box_no, kind)
);
create index if not exists rk_ship_docs_order_idx on rk_ship_docs (order_number);

-- Storage 버킷 (비공개, PDF 만, 50MB). 서버도 첫 사용 때 createBucket 으로 한 번 더 보장한다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rk-ship-docs', 'rk-ship-docs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;
