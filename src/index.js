import { handleFeature, runScheduled } from './features.js';

const enc = new TextEncoder();
const SESSION_SECONDS = 7 * 24 * 3600;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key,
    256
  );
  return { hash: b64(bits), salt: b64(salt) };
}

const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

function getCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}

async function currentUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.business_id, b.name AS business_name, b.balance
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN businesses b ON b.id = u.business_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(await sha256(token), Math.floor(Date.now() / 1000))
    .first();
  return row || null;
}

async function login(req, env) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json({ error: 'Enter your email and password' }, 400);

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

  // First admin login: create the admin from the ADMIN_EMAIL / ADMIN_PASSWORD secrets.
  if (
    !user &&
    env.ADMIN_EMAIL &&
    env.ADMIN_PASSWORD &&
    email === env.ADMIN_EMAIL.trim().toLowerCase() &&
    password === env.ADMIN_PASSWORD
  ) {
    const { hash, salt } = await hashPassword(password);
    await env.DB.prepare("INSERT INTO users (email, password_hash, salt, role) VALUES (?, ?, ?, 'admin')")
      .bind(email, hash, salt)
      .run();
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  }

  if (!user) return json({ error: 'Wrong email or password' }, 401);
  const { hash } = await hashPassword(password, user.salt);
  if (!safeEq(hash, user.password_hash)) return json({ error: 'Wrong email or password' }, 401);

  if (user.business_id) {
    const biz = await env.DB.prepare('SELECT active FROM businesses WHERE id = ?').bind(user.business_id).first();
    if (biz && !biz.active) return json({ error: 'This account is switched off. Contact support.' }, 403);
  }

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), user.id, Math.floor(Date.now() / 1000) + SESSION_SECONDS)
    .run();

  return json(
    { ok: true, role: user.role },
    200,
    { 'Set-Cookie': `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` }
  );
}

async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': 'sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
}

async function createBusiness(req, env) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!name || !email || password.length < 8)
    return json({ error: 'Enter a business name, an email, and a password of at least 8 characters' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return json({ error: 'That email already has an account' }, 409);

  const { hash, salt } = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO businesses (name) VALUES (?)').bind(name),
    env.DB.prepare(
      "INSERT INTO users (business_id, email, password_hash, salt, role) VALUES (last_insert_rowid(), ?, ?, ?, 'business')"
    ).bind(email, hash, salt),
  ]);
  return json({ ok: true }, 201);
}

async function listBusinesses(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.name, b.balance, b.active, b.created_at, u.email
     FROM businesses b LEFT JOIN users u ON u.business_id = b.id
     ORDER BY b.id DESC`
  ).all();
  return json({ businesses: results });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/api/login' && req.method === 'POST') return await login(req, env);
      if (pathname === '/api/logout' && req.method === 'POST') return await logout(req, env);

      const user = await currentUser(req, env);
      if (!user) return json({ error: 'Please log in' }, 401);

      if (pathname === '/api/me') {
        return json({
          email: user.email,
          role: user.role,
          business: user.business_id ? { name: user.business_name, balance: user.balance } : null,
          price: Number((await env.DB.prepare("SELECT value FROM settings WHERE key = 'price_per_sms'").first())?.value || 0),
        });
      }

      if (pathname.startsWith('/api/admin/')) {
        if (user.role !== 'admin') return json({ error: 'Admin only' }, 403);
        if (pathname === '/api/admin/businesses' && req.method === 'GET') return await listBusinesses(env);
        if (pathname === '/api/admin/businesses' && req.method === 'POST') return await createBusiness(req, env);
      }

      const feature = await handleFeature(req, env, user, pathname);
      if (feature) return feature;

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error. Try again.' }, 500);
    }
  },
};
