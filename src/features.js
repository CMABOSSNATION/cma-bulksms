const BASE = 'https://developer.aliesms.com';
const MAX_RECIPIENTS = 2000;
const CHUNK = 200;
const CANCEL_PER_PRESS = 30;
const GSM = /^[A-Za-z0-9 @£$¥èéùìòÇ\r\nØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;
const EXT = /[{}\[\]~^|\\€]/g;

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

export function segments(text) {
  if (!text) return 0;
  const ext = (text.match(EXT) || []).length;
  if (GSM.test(text.replace(EXT, ''))) {
    const len = text.length + ext;
    return len <= 160 ? 1 : Math.ceil(len / 153);
  }
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

export function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (d.startsWith('256') && d.length === 12) d = '0' + d.slice(3);
  else if (d.length === 9 && d.startsWith('7')) d = '0' + d;
  return /^07\d{8}$/.test(d) ? d : null;
}

async function getSetting(env, k) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(k).first();
  return r ? r.value : null;
}
async function setSetting(env, k, v) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(k, String(v)).run();
}
const ledger = (env, bid, amount, kind, note) =>
  env.DB.prepare('INSERT INTO wallet_ledger (business_id, amount, kind, note) VALUES (?, ?, ?, ?)')
    .bind(bid, amount, kind, note || '');

async function refund(env, bid, amount, note) {
  if (amount <= 0) return;
  await env.DB.batch([
    env.DB.prepare('UPDATE businesses SET balance = balance + ? WHERE id = ?').bind(amount, bid),
    ledger(env, bid, amount, 'refund', note),
  ]);
}

// ---------- AlieSMS ----------
async function getToken(env, force) {
  if (!force) {
    const cached = await getSetting(env, 'aliesms_token');
    if (cached) return cached;
    if (env.ALIESMS_TOKEN) return env.ALIESMS_TOKEN;
  }
  if (env.ALIESMS_EMAIL && env.ALIESMS_PASSWORD) {
    const r = await fetch(BASE + '/api/token/generate.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.ALIESMS_EMAIL, password: env.ALIESMS_PASSWORD }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.token) { await setSetting(env, 'aliesms_token', d.token); return d.token; }
  }
  throw new Error('AlieSMS token is missing or was rejected');
}

async function provider(env, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, attempt === 1);
    const res = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    return await res.json();
  }
  throw new Error('AlieSMS rejected the token');
}

// ---------- Sending ----------
async function dispatch(env, id) {
  const c = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
  const phones = JSON.parse(c.phones);
  const per = c.cost / c.recipients;
  let ok = 0, failed = 0;
  for (let i = 0; i < phones.length; i += CHUNK) {
    const chunk = phones.slice(i, i + CHUNK);
    try {
      const r = await provider(env, '/api/message/batch/create.php', {
        batch_name: `${c.name} #${c.id}`,
        message_text: c.message_text,
        recipients: chunk.join(','),
      });
      if (r.status === 'OK') {
        const accepted = Math.min(Number(r.total_recipients ?? chunk.length), chunk.length);
        ok += accepted; failed += chunk.length - accepted;
      } else failed += chunk.length;
    } catch (e) {
      console.error('send chunk failed', e);
      failed += chunk.length;
    }
  }
  await env.DB.prepare('UPDATE campaigns SET status = ?, pending = ?, failed = ? WHERE id = ?')
    .bind(ok > 0 ? 'queued' : 'failed', ok, failed, id).run();
  await refund(env, c.business_id, failed * per, `Refund: ${failed} not accepted (${c.name})`);
  return { ok, failed };
}

async function createCampaign(env, user, b) {
  const text = String(b.message_text || '').trim();
  if (!text) return json({ error: 'Write a message first' }, 400);
  const price = Number((await getSetting(env, 'price_per_sms')) || 0);
  if (!(price > 0)) return json({ error: 'Sending is not open yet. The admin has not set a price.' }, 403);

  const set = new Set();
  const typed = String(b.numbers || '').split(/[\s,;]+/).filter(Boolean);
  for (const n of typed) { const p = normPhone(n); if (p) set.add(p); }
  if (b.group) {
    const q = b.group === '__all__'
      ? env.DB.prepare('SELECT phone FROM contacts WHERE business_id = ?').bind(user.business_id)
      : env.DB.prepare('SELECT phone FROM contacts WHERE business_id = ? AND grp = ?').bind(user.business_id, b.group);
    const { results } = await q.all();
    for (const r of results) set.add(r.phone);
  }
  const phones = [...set];
  if (!phones.length) return json({ error: 'Pick a contact group or type at least one valid number' }, 400);
  if (phones.length > MAX_RECIPIENTS) return json({ error: `Send to at most ${MAX_RECIPIENTS} numbers at a time` }, 400);

  const segs = segments(text);
  const cost = phones.length * segs * price;
  const when = b.scheduled_at ? new Date(b.scheduled_at) : null;
  const scheduled = when && !isNaN(when) && when.getTime() > Date.now() + 60000;

  if (!scheduled) {
    const pc = Number((await getSetting(env, 'provider_cost_per_sms')) || 0);
    if (pc > 0) {
      try {
        const bal = await provider(env, '/api/user/balance.php');
        if (Number(bal.balance) < phones.length * segs * pc)
          return json({ error: 'We cannot send right now. Please contact support.' }, 503);
      } catch (e) { return json({ error: 'The SMS provider is not reachable. Try again soon.' }, 503); }
    }
  }

  const res = await env.DB.prepare('UPDATE businesses SET balance = balance - ? WHERE id = ? AND balance >= ?')
    .bind(cost, user.business_id, cost).run();
  if (!res.meta.changes)
    return json({ error: `Not enough credit. This send costs UGX ${cost.toLocaleString('en-US')}. Top up your wallet first.` }, 402);

  const name = String(b.name || '').trim() || 'Campaign ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
  const ins = await env.DB.prepare(
    `INSERT INTO campaigns (business_id, name, message_text, recipients, sms_count, cost, status, scheduled_at, phones, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(user.business_id, name, text, phones.length, segs, cost, scheduled ? 'scheduled' : 'queued',
         scheduled ? when.toISOString() : null, JSON.stringify(phones)).run();
  const id = ins.meta.last_row_id;
  await ledger(env, user.business_id, -cost, 'send', name).run();

  if (scheduled) return json({ ok: true, id, status: 'scheduled', cost, recipients: phones.length });
  const r = await dispatch(env, id);
  return json({ ok: true, id, status: r.ok > 0 ? 'queued' : 'failed', cost, recipients: phones.length, failed: r.failed });
}

async function cancelCampaign(env, user, id) {
  const c = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ? AND business_id = ?').bind(id, user.business_id).first();
  if (!c) return json({ error: 'Campaign not found' }, 404);
  const per = c.cost / c.recipients;
  if (c.status === 'scheduled') {
    await env.DB.prepare("UPDATE campaigns SET status = 'cancelled', cancelled = recipients WHERE id = ?").bind(id).run();
    await refund(env, c.business_id, c.cost, `Cancelled: ${c.name}`);
    return json({ ok: true, deleted: c.recipients, remaining: 0 });
  }
  if (c.status !== 'queued') return json({ error: 'This campaign can no longer be cancelled' }, 400);

  const q = await provider(env, '/api/message/request.php');
  const phones = new Set(JSON.parse(c.phones));
  const mine = (q.details || [])
    .filter((m) => phones.has(normPhone(m.phoneNumber) || m.phoneNumber) && m.messageText === c.message_text)
    .slice(0, CANCEL_PER_PRESS);
  let deleted = 0;
  for (const m of mine) {
    try {
      const r = await provider(env, '/api/message/delivery/report.php', { message_id: String(m.messageID), status: 'Delete' });
      if (r.status === 'Success') deleted++;
    } catch (e) { console.error(e); }
  }
  const remaining = Math.max(c.pending - deleted, 0);
  const status = remaining === 0 ? (c.cancelled + deleted > 0 ? 'cancelled' : 'sent') : 'queued';
  await env.DB.prepare('UPDATE campaigns SET cancelled = cancelled + ?, pending = ?, status = ? WHERE id = ?')
    .bind(deleted, remaining, status, id).run();
  await refund(env, c.business_id, deleted * per, `Cancelled ${deleted} message(s): ${c.name}`);
  return json({ ok: true, deleted, remaining });
}

// ---------- Cron: scheduled sends + queue status ----------
export async function runScheduled(env) {
  const now = new Date().toISOString();
  const { results: due } = await env.DB.prepare(
    "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 3"
  ).bind(now).all();
  for (const d of due) {
    const claim = await env.DB.prepare("UPDATE campaigns SET status = 'queued' WHERE id = ? AND status = 'scheduled'").bind(d.id).run();
    if (claim.meta.changes) await dispatch(env, d.id).catch((e) => console.error(e));
  }

  const { results: open } = await env.DB.prepare(
    "SELECT id, phones, message_text FROM campaigns WHERE status = 'queued' AND created_at <= datetime('now', '-1 minute') LIMIT 50"
  ).all();
  if (!open.length) return;
  try {
    const q = await provider(env, '/api/message/request.php');
    if (q.status !== 'OK') return;
    const pending = new Set((q.details || []).map((m) => `${normPhone(m.phoneNumber) || m.phoneNumber}|${m.messageText}`));
    for (const c of open) {
      const n = JSON.parse(c.phones).filter((p) => pending.has(`${p}|${c.message_text}`)).length;
      await env.DB.prepare('UPDATE campaigns SET pending = ?, status = ? WHERE id = ?')
        .bind(n, n === 0 ? 'sent' : 'queued', c.id).run();
    }
  } catch (e) { console.error('status sync failed', e); }
}

// ---------- Routes ----------
export async function handleFeature(req, env, user, path) {
  const m = req.method;
  const body = () => req.json().catch(() => ({}));
  let x;

  if (user.role === 'admin') {
    if (path === '/api/admin/topup' && m === 'POST') {
      const b = await body();
      const amount = Math.trunc(Number(b.amount));
      if (!b.business_id || !amount) return json({ error: 'Enter a business and an amount' }, 400);
      const r = await env.DB.prepare('UPDATE businesses SET balance = balance + ? WHERE id = ? AND balance + ? >= 0')
        .bind(amount, b.business_id, amount).run();
      if (!r.meta.changes) return json({ error: 'Business not found, or the balance would go below zero' }, 400);
      await ledger(env, b.business_id, amount, 'topup', String(b.note || '')).run();
      return json({ ok: true });
    }
    if (path === '/api/admin/settings' && m === 'GET') {
      let providerBalance = null;
      try { providerBalance = (await provider(env, '/api/user/balance.php')).balance ?? null; } catch (e) {}
      return json({
        price_per_sms: Number((await getSetting(env, 'price_per_sms')) || 0),
        provider_cost_per_sms: Number((await getSetting(env, 'provider_cost_per_sms')) || 0),
        provider_balance: providerBalance,
      });
    }
    if (path === '/api/admin/settings' && m === 'POST') {
      const b = await body();
      for (const k of ['price_per_sms', 'provider_cost_per_sms']) {
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < 0) return json({ error: 'Enter numbers of zero or more' }, 400);
        await setSetting(env, k, Math.trunc(v));
      }
      return json({ ok: true });
    }
    if ((x = path.match(/^\/api\/admin\/businesses\/(\d+)\/active$/)) && m === 'POST') {
      const b = await body();
      await env.DB.prepare('UPDATE businesses SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, x[1]).run();
      if (!b.active) await env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE business_id = ?)').bind(x[1]).run();
      return json({ ok: true });
    }
    return null;
  }

  const bid = user.business_id;
  if (!bid) return null;

  if (path === '/api/stats') {
    const one = async (sql) => (await env.DB.prepare(sql).bind(bid).first()).v;
    return json({
      sent24: await one("SELECT COALESCE(SUM(recipients - pending - cancelled - failed), 0) AS v FROM campaigns WHERE business_id = ? AND status IN ('queued','sent','cancelled') AND created_at >= datetime('now','-1 day')"),
      queue: await one("SELECT COALESCE(SUM(pending), 0) AS v FROM campaigns WHERE business_id = ? AND status = 'queued'"),
      spent: await one("SELECT COALESCE(-SUM(amount), 0) AS v FROM wallet_ledger WHERE business_id = ? AND kind IN ('send','refund') AND created_at >= date('now')"),
    });
  }

  if (path === '/api/contacts' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, name, phone, grp FROM contacts WHERE business_id = ? ORDER BY id DESC LIMIT 300').bind(bid).all();
    const g = await env.DB.prepare("SELECT grp, COUNT(*) AS n FROM contacts WHERE business_id = ? GROUP BY grp").bind(bid).all();
    const total = g.results.reduce((s, r) => s + r.n, 0);
    return json({ contacts: results, groups: g.results.filter((r) => r.grp), total });
  }
  if (path === '/api/contacts' && m === 'POST') {
    const b = await body();
    const rows = Array.isArray(b.contacts) ? b.contacts.slice(0, 500) : [];
    const stmts = [];
    let invalid = 0;
    for (const r of rows) {
      const p = normPhone(r.phone);
      if (!p) { invalid++; continue; }
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO contacts (business_id, name, phone, grp) VALUES (?, ?, ?, ?)')
        .bind(bid, String(r.name || '').slice(0, 80), p, String(r.grp || '').trim().slice(0, 40)));
    }
    let added = 0;
    if (stmts.length) for (const res of await env.DB.batch(stmts)) added += res.meta.changes;
    return json({ ok: true, added, invalid, duplicates: stmts.length - added });
  }
  if ((x = path.match(/^\/api\/contacts\/(\d+)\/delete$/)) && m === 'POST') {
    await env.DB.prepare('DELETE FROM contacts WHERE id = ? AND business_id = ?').bind(x[1], bid).run();
    return json({ ok: true });
  }

  if (path === '/api/templates' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, title, body FROM templates WHERE business_id = ? ORDER BY id DESC').bind(bid).all();
    return json({ templates: results });
  }
  if (path === '/api/templates' && m === 'POST') {
    const b = await body();
    const title = String(b.title || '').trim().slice(0, 60), text = String(b.body || '').trim();
    if (!title || !text) return json({ error: 'Enter a title and a message' }, 400);
    await env.DB.prepare('INSERT INTO templates (business_id, title, body) VALUES (?, ?, ?)').bind(bid, title, text).run();
    return json({ ok: true }, 201);
  }
  if ((x = path.match(/^\/api\/templates\/(\d+)\/delete$/)) && m === 'POST') {
    await env.DB.prepare('DELETE FROM templates WHERE id = ? AND business_id = ?').bind(x[1], bid).run();
    return json({ ok: true });
  }

  if (path === '/api/campaigns' && m === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, recipients, cost, status, pending, cancelled, failed, scheduled_at, created_at FROM campaigns WHERE business_id = ? ORDER BY id DESC LIMIT 30'
    ).bind(bid).all();
    return json({ campaigns: results });
  }
  if (path === '/api/campaigns' && m === 'POST') return await createCampaign(env, user, await body());
  if ((x = path.match(/^\/api\/campaigns\/(\d+)\/cancel$/)) && m === 'POST') return await cancelCampaign(env, user, x[1]);

  if (path === '/api/wallet' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT amount, kind, note, created_at FROM wallet_ledger WHERE business_id = ? ORDER BY id DESC LIMIT 50').bind(bid).all();
    return json({ ledger: results });
  }
  return null;
}
