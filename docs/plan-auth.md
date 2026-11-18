# 로그인 · 회원가입 · 등급 (2026-11-17)

로그인 없이 열리던 사이트에 계정과 등급(사원 · 관리자)을 붙인다.

## 1. 요구사항

- 회원가입 항목은 **사원이름(=아이디) · 비밀번호 · 연락처** 3개뿐이다. 등급은 가입 화면에 없다.
- 등급은 `사원` · `관리자` 2개. 이용자는 등급이 있다는 사실을 알 수 없어야 한다
  → 사원에게는 관리자 메뉴 · 카드 · 페이지 · API 를 **응답 자체에서 뺀다** (CSS 로 숨기지 않는다).
- 모든 화면(모바일 입고 포함)은 로그인해야 열린다.
- 브라우저를 닫거나 PC 를 재부팅하면 다시 로그인해야 한다.

| 등급 | 메뉴 |
|---|---|
| 사원 | 홈 · 발주서 · 출고스캔 · 쉽먼트 · CN입고 · 상품관리 · 재고관리 (+ 📱 모바일 입고 · 🌟 전체화면) |
| 관리자 | 전부 (위 + 랭킹 · 요약 · 쿠팡 물류센터 · 상품부족 · 라벨 설정 · 데이터 분석 · DB 정보 · 회원관리) |

## 2. DB — `supabase/rk_auth.sql`

- `rk_users (id, name unique, password_hash, phone, role default '사원', created_at)`
- `rk_sessions (token_hash pk, user_id → rk_users on delete cascade, expires_at)`
- 둘 다 RLS 켬 · 정책 없음 → 서버(service_role)만 읽고 쓴다.

## 3. 서버 — `routes/rkAuth.js` 한 파일

`server.js` 는 `express.static` **바로 앞**에서 `require('./routes/rkAuth')(app, io)` 한 줄로 붙인다.
(`express.static(__dirname)` 이 `/` 와 모든 `*.html` 을 직접 내주기 때문에 그보다 앞이어야 한다.)

붙는 순서:

1. `app.set('trust proxy', 1)` — Railway 프록시 뒤에서 `req.secure` · `req.ip` 가 맞게 나오도록.
2. **공개 라우트** (로그인 없이 열림 — 이것뿐이다)
   - `GET /login` → `login.html` (로그인 · 회원가입을 한 화면에서 전환). 이미 로그인돼 있으면 `next` 로 보낸다.
   - `POST /api/auth/login { name, password }`
   - `POST /api/auth/signup { name, password, phone }` — 가입 즉시 로그인된다.
   - `POST /api/auth/logout`
   - 이 세 POST 는 자기 전용 `express.json({ limit: '10kb' })` 를 쓴다 (전역 50mb 파서는 gate 뒤에 있다).
3. **gate** (그 뒤 모든 요청)
   - 경로 정규화: `decodeURIComponent` → `\` 를 `/` 로 → `path.posix.normalize` → 소문자. 디코드 실패는 400.
     (Express 라우트는 대소문자 · 끝 `/` 를 무시하고, static 은 인코딩된 경로도 풀어서 내주므로 같은 기준으로 맞춘다.)
   - `*.html` 직접 요청은 등급과 무관하게 404 — 화면은 라우트(`/shortage` 등)로만 나간다.
   - 세션 없음 → `/api/` · `/header` · GET 이 아닌 요청은 `401 { error: '로그인이 필요합니다.' }`, 그 외 GET 은 `302 /login?next=<원래 주소>`.
   - 사원이 관리자 전용 경로 → `/api/` 는 `404 { error: '찾을 수 없습니다.' }`, 화면은 `302 /`.
   - 통과하면 `req.user = { id, name, role }`.
4. **로그인 뒤 라우트**
   - `GET /` → `index.html`, `GET /header` → `header.html` 을 등급에 맞게 렌더 (아래 5).
   - `GET /api/auth/me` → `{ name }` (등급은 내려주지 않는다).
   - `GET /users` → `users.html` · `GET /api/users` · `POST /api/users/update { id, name, phone, role, password? }` · `POST /api/users/delete { id }`
     — 관리자 전용. 이름 · 연락처는 가입과 같은 검증(이름 중복 불가), `password` 는 비어 있으면 그대로 두고 값이 있으면 새로 해시한다.
     비밀번호를 바꾸면 그 계정의 세션을 지운다(다시 로그인). 자기 자신의 등급 변경 · 삭제는 거부한다 (관리자가 0명이 되는 것을 막는다).
5. `io.use(...)` — socket.io 연결도 같은 세션 쿠키로 확인한다 (socket.io 는 Express 를 거치지 않는다).

`server.js` 의 `app.get('/')` · `app.get('/header')` 는 지운다 (rkAuth 가 먼저 응답하므로 죽은 코드가 된다).

### 관리자 전용 경로 (한 곳에서 정의 — `ADMIN_ONLY`)

판정: 정규화한 경로가 항목과 같거나 `항목 + '/'` 로 시작.

- 화면: `/ranking` `/summary` `/warehouse` `/shortage` `/labelsettings` `/analytics` `/dbinfo` `/users`
  · 메뉴에 없는 예전 화면 `/importchina` `/scan` `/shipprepare` `/shipinspect`
- API (위 화면만 쓰는 것): `/api/ranking` `/api/analytics` `/api/shortage` `/api/coupang-info` `/api/warehouse`
  `/api/salesdata` `/api/importchina` `/api/users`
  `/api/orders/summary` `/api/orders/fill-prepared-zero` `/api/orders/update-process-type` `/api/orders/update-prepared`
  `/api/orders/updateimport1` `/api/orders/updateimport2` `/api/orders/resetimport12`
  `/api/scan`

사원 화면이 쓰는 API(`/api/orders` · `/api/orders/complete` · `/api/label/*` · `/api/inventory/*` · `/api/stocks/*` ·
`/api/inbound/*` · `/api/mobile/*` · `/api/ship-scan/*` · `/api/shipping-list*` · `/api/shipment/*` · `/api/allocate/*` ·
`/api/neworder*` · `/api/rocket/*` · `/api/export-logs` · `/api/upload` · `/api/products/*`)는 이 목록과 겹치지 않는다 (2026-11-17 전 화면 fetch 대조).

### 계정 · 세션 규칙

- 이름: 앞뒤 공백 제거 · 2~20자 · 중복 불가(`이미 가입된 이름입니다.`). 비밀번호: 4자 이상. 연락처: 숫자만 남겨 9~11자리.
- 비밀번호는 `crypto.scrypt`(솔트 16바이트) → `scrypt$<salt hex>$<hash hex>`, 비교는 `timingSafeEqual`.
- **첫 계정이 관리자**: `rk_users` 가 비어 있을 때 가입한 계정만 `관리자`, 그 뒤는 전부 `사원`. 이후 등급은 회원관리에서 바꾼다.
- 로그인 실패 문구는 하나: `이름 또는 비밀번호가 올바르지 않습니다.` 같은 IP+이름으로 10분 안에 5번 틀리면 마지막 실패부터 10분 잠금 — 그동안은 맞는 비밀번호도 `429` (메모리 Map).
- 세션: 토큰 = `randomBytes(32)` base64url. 쿠키 `rk_sid` — `HttpOnly; SameSite=Lax; Path=/`, https 면 `Secure`,
  **만료(Max-Age) 없음** → 브라우저를 닫으면 사라진다. DB 에는 `sha256(토큰)` 만 저장.
- 서버 쪽 만료 12시간(`SESSION_HOURS`). 브라우저가 "이전 세션 복원"으로 쿠키를 되살려도 다음 날에는 로그인해야 한다.
  로그인할 때 만료된 세션 행을 지운다.
- 세션 조회는 메모리 캐시(Map, 30초) — 요청마다 DB 를 치지 않는다. 등급 변경 · 삭제 · 로그아웃 때 캐시를 비워 즉시 반영.
- `next` 는 `/` 로 시작하고 `//` · `/\` 로 시작하지 않는 것만 받는다 (외부 주소로 튕기지 않게).

## 4. 화면

- `login.html` (새 파일) — 로그인 / 회원가입 전환. 홈과 같은 톤(Pretendard · #F0492F), 폰 폭에서도 그대로 쓸 수 있게.
- `users.html` (새 파일, 관리자) — 이름 · 연락처 · 등급 · 가입일 표. 행마다 이름 · 연락처 · 등급 · 새 비밀번호(선택)를 고쳐 [저장], [삭제].
- `header.html` — 관리자 전용 메뉴를 `<!--adm-->…<!--/adm-->` 로 감싼다. 메뉴 맨 끝(데이터 분석 다음)에 `회원관리`(adm) 링크,
  그 뒤에 `{{name}}` 드롭다운: 로그아웃.
- `index.html` — 관리자 전용 카드(요약 · 쿠팡 물류센터 · 상품부족 · 랭킹 버튼 · REFERENCE 구역 전체)를 같은 표시로 감싸고,
  REFERENCE 에 회원관리 카드 추가. 인사말 `아이엠몽 님` → `{{name}} 님`. 카드 번호(01…)는 CSS counter 로 — 사원도 01 부터 이어진다.
- `mobileInbound.html` — 첫 화면의 `본인 이름` 을 로그인 이름으로 채우고 읽기 전용으로 (`/api/auth/me`). 로그아웃 버튼 추가.

## 5. 렌더

`render(file, user)`: 파일을 읽어 ① 사원이면 `<!--adm-->[\s\S]*?<!--/adm-->` 구간 삭제 ② `{{name}}` 을 HTML 이스케이프한 이름으로 치환.
`/` 와 `/header` 두 곳만 쓴다. 응답에 `Cache-Control: no-store` (등급이 바뀌면 바로 달라져야 한다).

## 6. 범위 밖

- 가입 승인 절차(지금은 가입 즉시 사원) · 본인이 직접 하는 비밀번호 변경(관리자가 회원관리에서 바꿔 준다) · 정적 폴더의 서버 소스 노출 차단.
