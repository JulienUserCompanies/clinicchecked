// Lead inbox for the directory sites (ClinicChecked, CopackIndex, Yachtvane).
// The same file runs on all three Workers, which share one D1 database named "leads".
//
//   POST /api/lead   → saves a form submission, then redirects to /thanks/
//   GET  /admin      → password-protected list of leads (all three sites, filterable)
//   GET  /admin/export.csv, POST /admin/status, POST /admin/delete
//   everything else  → the static site (env.ASSETS)
//
// Settings (Cloudflare → Worker → Settings → Variables and secrets):
//   ADMIN_PASSWORD  secret, required for /admin (user name: anything)
//   RESEND_API_KEY  secret, optional: email an alert for every new lead
//   NOTIFY_TO       variable, optional: alert address (default hello@usercompanies.com)
//   NOTIFY_FROM     variable, optional: sender for alerts (default onboarding@resend.dev)
//   SITE            variable, set in wrangler.jsonc: which site this Worker serves

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    site TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT,
    page TEXT,
    name TEXT,
    email TEXT,
    phone TEXT,
    details TEXT,
    consent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new',
    note TEXT,
    ip_hash TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at)`,
  `CREATE INDEX IF NOT EXISTS leads_ip ON leads (ip_hash, created_at)`,
];

const KINDS = new Set(['consultation', 'compare', 'enquiry', 'brief', 'charter', 'listing', 'newsletter']);
const STATUSES = ['new', 'sent', 'won', 'lost', 'spam'];
const CORE = new Set(['kind', 'target', 'name', 'email', 'phone', 'consent', 'website', 'page']);
const MAX_PER_HOUR = 15;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady = true;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function back(url, path, params) {
  const to = new URL(path, url.origin);
  for (const [k, v] of Object.entries(params || {})) to.searchParams.set(k, v);
  return Response.redirect(to.href, 303);
}

async function handleLead(req, env, url, ctx) {
  if (!env.DB) return new Response('The lead inbox is not connected yet.', { status: 503 });
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) {
    return new Response('Unsupported form', { status: 415 });
  }
  const form = await req.formData();
  const kind = clip(form.get('kind'), 20);

  // Spam checks: a hidden field people never fill, and a per-visitor hourly limit.
  if (clip(form.get('website'), 200)) return back(url, '/thanks/', { k: kind });
  if (!KINDS.has(kind)) return new Response('Unknown form', { status: 400 });

  const email = clip(form.get('email'), 254).toLowerCase();
  if (!isEmail(email)) return back(url, '/thanks/', { k: kind, e: 'email' });
  if (form.get('consent') !== 'on') return back(url, '/thanks/', { k: kind, e: 'consent' });

  await ensureSchema(env.DB);
  const ip = req.headers.get('cf-connecting-ip') || '';
  const ipHash = await sha256(`${ip}|${env.SITE || ''}|leads`);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ? AND created_at > ?').bind(ipHash, since).first();
  if ((recent?.n ?? 0) >= MAX_PER_HOUR) return back(url, '/thanks/', { k: kind });

  // Everything else on the form is kept as details (bounded).
  const details = {};
  let count = 0;
  for (const [k, v] of form.entries()) {
    if (CORE.has(k) || typeof v !== 'string' || count >= 30) continue;
    const value = clip(v, 2000);
    if (value) { details[clip(k, 40)] = value; count++; }
  }

  const row = {
    created_at: new Date().toISOString(),
    site: env.SITE || url.hostname,
    kind,
    target: clip(form.get('target'), 200),
    page: clip(form.get('page') || req.headers.get('referer'), 500),
    name: clip(form.get('name'), 200),
    email,
    phone: clip(form.get('phone'), 40),
    details: JSON.stringify(details),
  };
  const res = await env.DB.prepare(
    'INSERT INTO leads (created_at, site, kind, target, page, name, email, phone, details, consent, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
  ).bind(row.created_at, row.site, row.kind, row.target, row.page, row.name, row.email, row.phone, row.details, ipHash).run();

  if (env.RESEND_API_KEY) {
    // Fire and forget: a failed alert never loses the lead, which is already saved.
    const id = res?.meta?.last_row_id;
    const lines = [
      `New ${row.kind} lead on ${row.site}${row.target ? ` for ${row.target}` : ''}`,
      `Name: ${row.name || '-'}`, `Email: ${row.email}`, `Phone: ${row.phone || '-'}`,
      ...Object.entries(details).map(([k, v]) => `${k}: ${v}`),
      `Page: ${row.page || '-'}`, '', `Open the inbox: ${url.origin}/admin${id ? `#lead-${id}` : ''}`,
    ];
    const send = fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'Lead inbox <onboarding@resend.dev>',
        to: [env.NOTIFY_TO || 'hello@usercompanies.com'],
        subject: `New ${row.kind} lead: ${row.site}`,
        text: lines.join('\n'),
      }),
    }).catch(() => {});
    ctx.waitUntil(send);
  }

  return back(url, '/thanks/', { k: kind });
}

// ---------- Admin ----------

function unauthorized() {
  return new Response('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Lead inbox", charset="UTF-8"' } });
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(req, env) {
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return sameText(password, env.ADMIN_PASSWORD);
}

async function readFilters(url) {
  const site = clip(url.searchParams.get('site'), 60);
  const status = clip(url.searchParams.get('status'), 20);
  const kind = clip(url.searchParams.get('kind'), 20);
  const where = [];
  const args = [];
  if (site) { where.push('site = ?'); args.push(site); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  return { site, status, kind, sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const PAGE_CSS = `
:root{--ink:#14232b;--muted:#5b6b72;--line:#dfe5e3;--bg:#f6f7f5;--brand:#0f4c5c;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
body{margin:0;background:var(--bg);color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);padding:14px 24px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:20px;margin:0}main{padding:20px 24px;max-width:1400px;margin:0 auto}
form.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-bottom:16px}
label{display:grid;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
select,input,button,textarea{font:inherit;font-size:14px;padding:7px 9px;border:1px solid #b8c3c0;border-radius:6px;background:#fff;color:var(--ink)}
button{background:var(--brand);color:#fff;border-color:var(--brand);cursor:pointer}
button.ghost{background:#fff;color:var(--ink);border-color:#b8c3c0}
button.danger{background:#fff;color:#9e2338;border-color:#e2b5bd}
.summary{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.summary span{background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px}
.wrap{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:#fafbfa;position:sticky;top:0}
td.details{max-width:360px}td.details dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:0}
td.details dt{color:var(--muted)}td.details dd{margin:0;overflow-wrap:anywhere}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#e3eef0;color:var(--brand)}
.st-new{background:#fff1c2;color:#7a5200}.st-won{background:#dff3e6;color:#1f6e4a}.st-lost,.st-spam{background:#f1e4e6;color:#8a2333}
.row-actions{display:grid;gap:6px;min-width:170px}.muted{color:var(--muted)}a{color:var(--brand)}
.empty{padding:40px;text-align:center;color:var(--muted)}
`;

async function adminPage(env, url) {
  await ensureSchema(env.DB);
  const f = await readFilters(url);
  const rows = (await env.DB.prepare(`SELECT * FROM leads ${f.sql} ORDER BY created_at DESC LIMIT 500`).bind(...f.args).all()).results || [];
  const sites = ((await env.DB.prepare('SELECT site, COUNT(*) AS n FROM leads GROUP BY site ORDER BY n DESC').all()).results || []);
  const counts = ((await env.DB.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all()).results || []);
  const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label ?? v)}</option>`;
  const qs = url.search;

  const body = rows.length === 0
    ? `<div class="empty">No leads${f.sql ? ' match these filters' : ' yet'}.</div>`
    : `<div class="wrap"><table><thead><tr><th>Received</th><th>Site</th><th>Type</th><th>For</th><th>Contact</th><th>Details</th><th>Status</th></tr></thead><tbody>${rows.map((r) => {
        let d = {};
        try { d = JSON.parse(r.details || '{}'); } catch {}
        const dl = Object.entries(d).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
        return `<tr id="lead-${r.id}">
          <td>${esc(r.created_at.slice(0, 16).replace('T', ' '))}<div class="muted">#${r.id}</div></td>
          <td>${esc(r.site)}</td>
          <td><span class="tag">${esc(r.kind)}</span></td>
          <td>${esc(r.target || '-')}${r.page ? `<div class="muted"><a href="${esc(r.page)}" rel="noopener noreferrer" target="_blank">page</a></div>` : ''}</td>
          <td>${esc(r.name || '-')}<div><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>${r.phone ? `<div>${esc(r.phone)}</div>` : ''}</td>
          <td class="details">${dl ? `<dl>${dl}</dl>` : '<span class="muted">-</span>'}</td>
          <td><div class="row-actions">
            <form method="post" action="/admin/status${esc(qs)}"><input type="hidden" name="id" value="${r.id}">
              <span class="tag st-${esc(r.status)}">${esc(r.status)}</span>
              <select name="status" aria-label="Status">${STATUSES.map((s) => opt(s, r.status)).join('')}</select>
              <input name="note" placeholder="Note" value="${esc(r.note || '')}" aria-label="Note">
              <button type="submit">Save</button></form>
            <form method="post" action="/admin/delete${esc(qs)}" onsubmit="return confirm('Delete lead #${r.id} for good?')"><input type="hidden" name="id" value="${r.id}"><button class="danger" type="submit">Delete</button></form>
          </div></td></tr>`;
      }).join('')}</tbody></table></div>`;

  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Lead inbox</title><style>${PAGE_CSS}</style></head><body>
  <header><h1>Lead inbox</h1><a href="/admin/export.csv${esc(qs)}">Download CSV</a></header>
  <main>
    <div class="summary">${counts.map((c) => `<span>${esc(c.status)}: <strong>${c.n}</strong></span>`).join('') || '<span>No leads yet</span>'}</div>
    <form class="filters" method="get" action="/admin">
      <label>Site<select name="site"><option value="">All sites</option>${sites.map((s) => opt(s.site, f.site, `${s.site} (${s.n})`)).join('')}</select></label>
      <label>Type<select name="kind"><option value="">All types</option>${[...KINDS].map((k) => opt(k, f.kind)).join('')}</select></label>
      <label>Status<select name="status"><option value="">All statuses</option>${STATUSES.map((s) => opt(s, f.status)).join('')}</select></label>
      <button type="submit">Filter</button><a class="muted" href="/admin">Clear</a>
    </form>
    ${body}
    <p class="muted" style="font-size:13px">Showing up to 500 leads, newest first. Delete a lead when someone asks you to remove their data.</p>
  </main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}

async function adminExport(env, url) {
  await ensureSchema(env.DB);
  const f = await readFilters(url);
  const rows = (await env.DB.prepare(`SELECT * FROM leads ${f.sql} ORDER BY created_at DESC`).bind(...f.args).all()).results || [];
  const cols = ['id', 'created_at', 'site', 'kind', 'target', 'name', 'email', 'phone', 'details', 'status', 'note', 'page'];
  // Neutralise spreadsheet formulas in user-supplied text.
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leads.csv"', 'cache-control': 'no-store' } });
}

async function adminWrite(req, env, url, action) {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) return new Response('Bad request', { status: 400 });
  // Same-origin check, so another site can't post to the admin with a remembered password.
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
  await ensureSchema(env.DB);
  const form = await req.formData();
  const id = Number(form.get('id'));
  if (!Number.isInteger(id) || id < 1) return new Response('Bad id', { status: 400 });
  if (action === 'status') {
    const status = String(form.get('status') || '');
    if (!STATUSES.includes(status)) return new Response('Bad status', { status: 400 });
    await env.DB.prepare('UPDATE leads SET status = ?, note = ? WHERE id = ?').bind(status, clip(form.get('note'), 1000), id).run();
  } else {
    await env.DB.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
  }
  return Response.redirect(`${url.origin}/admin${url.search}#lead-${id}`, 303);
}

async function handleAdmin(req, env, url) {
  if (!env.ADMIN_PASSWORD) return new Response('Set the ADMIN_PASSWORD secret on this Worker to open the inbox.', { status: 503 });
  if (!authorised(req, env)) return unauthorized();
  if (!env.DB) return new Response('The lead inbox database is not connected yet.', { status: 503 });
  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) return adminPage(env, url);
  if (req.method === 'GET' && url.pathname === '/admin/export.csv') return adminExport(env, url);
  if (req.method === 'POST' && url.pathname === '/admin/status') return adminWrite(req, env, url, 'status');
  if (req.method === 'POST' && url.pathname === '/admin/delete') return adminWrite(req, env, url, 'delete');
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/lead') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
        return await handleLead(req, env, url, ctx);
      }
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdmin(req, env, url);
    } catch (err) {
      console.error('lead inbox error', err && err.stack ? err.stack : err);
      return new Response('Something went wrong. Please try again, or email hello@usercompanies.com.', { status: 500 });
    }
    return env.ASSETS.fetch(req);
  },
};
