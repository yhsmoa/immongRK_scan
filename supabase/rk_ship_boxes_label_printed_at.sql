-- 박스 라벨 출력 기록 (2026-11-02) — 라벨이 두 번 나가던 문제
--   라벨 서비스가 "전송됨" 을 돌려주면 그 박스에 시각을 적는다. [박스라벨출력] 의 "이미 뽑힌 라벨 제외" 가 이 시각을 가장 먼저 본다.
--   박스 크기를 바꾸거나(모바일 입고) 박스를 나누면 그 박스는 다시 뽑아야 하므로 NULL 로 되돌린다.
alter table public.rk_ship_boxes add column if not exists label_printed_at timestamptz;
comment on column public.rk_ship_boxes.label_printed_at is '박스 라벨을 마지막으로 뽑은 시각. 있으면 [이미 뽑힌 라벨 제외] 대상';
