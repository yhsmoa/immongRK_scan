/**
 * 로그인 · 회원가입 · 등급(사원/관리자) — docs/plan-auth.md
 * server.js 에서 express.static 바로 앞에 붙는다: 공개 라우트 → gate → 로그인 뒤 라우트 → socket.io 확인.
 *
 *   GET  /login · POST /api/auth/login · /api/auth/signup · /api/auth/logout   (공개)
 *   GET  / · /header (등급별 렌더) · /api/auth/me → { name }
 *   GET  /users · /api/users · POST /api/users/update { id, name, phone, role, password? } · /api/users/delete { id }   (관리자)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { supabase: sb } = require('./rkShared');

const scrypt = promisify(crypto.scrypt);
const ROOT = path.join(__dirname, '..');
const COOKIE = 'rk_sid';
const SESSION_HOURS = 12;
const CACHE_MS = 30 * 1000;
const LOCK_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const ADMIN = '관리자';
const ROLES = ['사원', ADMIN];
const DUP_NAME = '이미 가입된 이름입니다.';

// 정규화한 경로(소문자) 기준 — 항목과 같거나 '항목/' 로 시작하면 관리자 전용
const ADMIN_ONLY = [
  '/ranking', '/summary', '/warehouse', '/shortage', '/labelsettings', '/analytics', '/dbinfo', '/users',
  '/importchina', '/scan', '/shipprepare', '/shipinspect',
  '/api/ranking', '/api/analytics', '/api/shortage', '/api/coupang-info', '/api/warehouse',
  '/api/salesdata', '/api/importchina', '/api/users',
  '/api/orders/summary', '/api/orders/fill-prepared-zero', '/api/orders/update-process-type', '/api/orders/update-prepared',
  '/api/orders/updateimport1', '/api/orders/updateimport2', '/api/orders/resetimport12',
  '/api/scan',
];
const isAdminOnly = (p) => ADMIN_ONLY.some((a) => p === a || p.startsWith(a + '/'));

const json = express.json({ limit: '10kb' });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readToken = (cookie) => (/(?:^|;\s*)rk_sid=([^;]+)/.exec(cookie || '') || [])[1];
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !/^\/[/\\]/.test(n) ? n : '/');
const h = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  console.error('[rkAuth]', e);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// 가입 · 회원 수정 공통 검증 — 수정에서는 비밀번호가 비어 있으면 그대로 둔다
function readAccount(body, passwordRequired) {
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').replace(/\D/g, '');
  const password = String(body.password || '');
  if (name.length < 2 || name.length > 20) return { error: '이름은 2~20자로 입력하세요.' };
  if ((passwordRequired || password) && password.length < 4) return { error: '비밀번호는 4자 이상 입력하세요.' };
  if (phone.length < 9 || phone.length > 11) return { error: '연락처를 숫자 9~11자리로 입력하세요.' };
  return { name, phone, password };
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(pw, salt, 64)).toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [, salt = '', hash = ''] = String(stored).split('$');
  const want = Buffer.from(hash, 'hex');
  const got = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

// ── 세션: 쿠키에는 토큰 원문, DB 에는 sha256 만. 조회는 30초 메모리 캐시 ──
const cache = new Map();   // token_hash → { user, at }
async function userOf(token) {
  if (!token) return null;
  const key = sha256(token);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.user;
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  const { data, error } = await sb.from('rk_sessions')
    .select('expires_at, rk_users(id, name, role)').eq('token_hash', key).maybeSingle();
  if (error) throw error;
  const user = data && data.rk_users && new Date(data.expires_at).getTime() > now ? data.rk_users : null;
  if (user) cache.set(key, { user, at: now });
  return user;
}
function dropUser(id) {
  for (const [k, v] of cache) if (v.user.id === id) cache.delete(k);
}
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const del = await sb.from('rk_sessions').delete().lt('expires_at', new Date().toISOString());
  if (del.error) throw del.error;
  const { error } = await sb.from('rk_sessions').insert({
    token_hash: sha256(token), user_id: userId,
    expires_at: new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString(),
  });
  if (error) throw error;
  // Max-Age 없음 → 브라우저를 닫으면 쿠키가 사라진다
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`);
}

// 사원이면 <!--adm-->…<!--/adm--> 구간을 응답에서 뺀다
function render(file, user) {
  let html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (user.role !== ADMIN) html = html.replace(/<!--adm-->[\s\S]*?<!--\/adm-->/g, '');
  return html.replace(/\{\{name\}\}/g, () => esc(user.name));
}
const page = (file) => (req, res) => res.set('Cache-Control', 'no-store').send(render(file, req.user));

// IP+이름별 실패 횟수 — 10분 안에 5번이면 마지막 실패부터 10분 잠금. 지난 기록은 실패할 때 지운다
const fails = new Map();   // key → { n, until }

module.exports = function (app, io) {
  app.set('trust proxy', 1);

  // ── 공개 라우트 ──
  app.get('/login', h(async (req, res) => {
    if (await userOf(readToken(req.headers.cookie))) return res.redirect(safeNext(req.query.next));
    res.sendFile(path.join(ROOT, 'login.html'));
  }));

  app.post('/api/auth/login', json, h(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const key = `${req.ip}|${name}`;
    const now = Date.now();
    const f = fails.get(key);
    const n = f && f.until > now ? f.n : 0;   // 10분이 지난 기록은 0 부터 다시 센다
    if (n >= LOCK_FAILS) return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도하세요.' });
    const { data: u, error } = await sb.from('rk_users').select('id, password_hash').eq('name', name).maybeSingle();
    if (error) throw error;
    if (!u || !(await checkPassword(String(req.body.password || ''), u.password_hash))) {
      for (const [k, v] of fails) if (v.until <= now) fails.delete(k);
      fails.set(key, { n: n + 1, until: now + LOCK_MS });
      return res.status(401).json({ error: '이름 또는 비밀번호가 올바르지 않습니다.' });
    }
    fails.delete(key);
    await startSession(req, res, u.id);
    res.json({ ok: true });
  }));

  app.post('/api/auth/signup', json, h(async (req, res) => {
    const a = readAccount(req.body, true);
    if (a.error) return res.status(400).json(a);
    const cnt = await sb.from('rk_users').select('id', { count: 'exact', head: true });
    if (cnt.error) throw cnt.error;
    const { data: u, error } = await sb.from('rk_users')
      .insert({ name: a.name, phone: a.phone, password_hash: await hashPassword(a.password), role: cnt.count === 0 ? ADMIN : '사원' })
      .select('id').single();
    if (error && error.code === '23505') return res.status(409).json({ error: DUP_NAME });
    if (error) throw error;
    await startSession(req, res, u.id);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', h(async (req, res) => {
    const token = readToken(req.headers.cookie);
    if (token) {
      cache.delete(sha256(token));
      const { error } = await sb.from('rk_sessions').delete().eq('token_hash', sha256(token));
      if (error) throw error;
    }
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ ok: true });
  }));

  // ── gate: 이 뒤의 모든 요청 ──
  // Express 라우트는 대소문자 · 끝 '/' 를 무시하고 static 은 인코딩된 경로를 풀어 내주므로 같은 기준으로 맞춘다
  app.use(h(async (req, res, next) => {
    let p;
    try {
      p = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, '/')).toLowerCase().replace(/(.)\/$/, '$1');
    } catch (_) {
      return res.sendStatus(400);
    }
    if (p.endsWith('.html')) return res.sendStatus(404);
    const user = await userOf(readToken(req.headers.cookie));
    if (!user) {
      if (p.startsWith('/api/') || p === '/header' || req.method !== 'GET') return res.status(401).json({ error: '로그인이 필요합니다.' });
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (user.role !== ADMIN && isAdminOnly(p)) {
      return p.startsWith('/api/') ? res.status(404).json({ error: '찾을 수 없습니다.' }) : res.redirect('/');
    }
    req.user = user;
    next();
  }));

  // ── 로그인 뒤 ──
  app.get('/', page('index.html'));
  app.get('/header', page('header.html'));
  app.get('/api/auth/me', (req, res) => res.json({ name: req.user.name }));

  app.get('/users', (req, res) => res.sendFile(path.join(ROOT, 'users.html')));
  app.get('/api/users', h(async (req, res) => {
    const { data, error } = await sb.from('rk_users').select('id, name, phone, role, created_at').order('created_at');
    if (error) throw error;
    res.json(data);
  }));
  // 자기 자신의 등급 변경 · 삭제는 거부 — 관리자가 0명이 되는 것을 막는다
  app.post('/api/users/update', json, h(async (req, res) => {
    const id = Number(req.body.id);
    const { role } = req.body;
    const a = readAccount(req.body, false);
    if (a.error) return res.status(400).json(a);
    if (!ROLES.includes(role)) return res.status(400).json({ error: '등급이 올바르지 않습니다.' });
    if (id === req.user.id && role !== req.user.role) return res.status(400).json({ error: '자기 자신의 등급은 바꿀 수 없습니다.' });
    const patch = { name: a.name, phone: a.phone, role };
    if (a.password) patch.password_hash = await hashPassword(a.password);
    const { data, error } = await sb.from('rk_users').update(patch).eq('id', id).select('id');
    if (error && error.code === '23505') return res.status(409).json({ error: DUP_NAME });
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: '찾을 수 없습니다.' });
    // 비밀번호를 바꾸면 그 계정은 다시 로그인해야 한다
    if (a.password) {
      const del = await sb.from('rk_sessions').delete().eq('user_id', id);
      if (del.error) throw del.error;
    }
    dropUser(id);
    res.json({ ok: true });
  }));
  app.post('/api/users/delete', json, h(async (req, res) => {
    const id = Number(req.body.id);
    if (id === req.user.id) return res.status(400).json({ error: '자기 자신은 삭제할 수 없습니다.' });
    const { data, error } = await sb.from('rk_users').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: '찾을 수 없습니다.' });
    dropUser(id);
    res.json({ ok: true });
  }));

  // socket.io 는 Express 를 거치지 않으므로 같은 세션 쿠키로 따로 확인한다
  io.use((socket, next) => {
    userOf(readToken(socket.handshake.headers.cookie))
      .then((u) => next(u ? undefined : new Error('로그인이 필요합니다.')), next);
  });
};
