-- 로그인 계정 · 세션 (2026-11-17) — docs/plan-auth.md
create table if not exists public.rk_users (
  id            bigint generated always as identity primary key,
  name          text not null unique,                 -- 아이디 = 사원이름
  password_hash text not null,                        -- scrypt$<salt>$<hash>
  phone         text not null,
  role          text not null default '사원' check (role in ('사원', '관리자')),
  created_at    timestamptz not null default now()
);

create table if not exists public.rk_sessions (
  token_hash text primary key,                        -- sha256(쿠키 토큰) — 원문은 저장하지 않는다
  user_id    bigint not null references public.rk_users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists rk_sessions_user_id_idx on public.rk_sessions (user_id);

-- 비밀번호 해시 · 세션 — 브라우저(anon 키)로는 못 읽게. 서버(service_role)는 RLS 를 건너뛴다
alter table public.rk_users    enable row level security;
alter table public.rk_sessions enable row level security;
grant all on table public.rk_users, public.rk_sessions to service_role;
