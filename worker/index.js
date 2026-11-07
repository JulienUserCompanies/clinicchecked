// Lead inbox for the directory sites (ClinicChecked, CopackIndex, Yachtvane).
// The same file runs on all three Workers, which share one D1 database named "leads".
//
//   POST /api/lead   → saves a form submission, then redirects to /thanks/
//   GET  /admin      → password-protected list of leads (all three sites, filterable)
//   GET  /admin/export.csv, POST /admin/status, POST /admin/delete
//   GET  /admin/contacts → private enquiry emails for listed businesses (never published)
//   POST /admin/contacts/import, /admin/contacts/save, /admin/contacts/delete
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
  // Private contact book: the published enquiry email of each listed business, so a lead
  // can be forwarded to it. Kept out of the public site data on purpose.
  `CREATE TABLE IF NOT EXISTS contacts (
    site TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT,
    email TEXT,
    source TEXT,
    checked TEXT,
    status TEXT NOT NULL DEFAULT 'not asked',
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (site, slug)
  )`,
];

const CONTACT_STATUSES = ['not asked', 'asked', 'opted in', 'declined'];

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
.row-actions{display:grid;gap:6px;min-width:170px}a.btn{display:inline-block;margin-top:4px;padding:6px 10px;border-radius:6px;background:var(--brand);color:#fff;text-decoration:none;font-size:13px}.muted{color:var(--muted)}a{color:var(--brand)}
.empty{padding:40px;text-align:center;color:var(--muted)}
`;

async function adminPage(env, url) {
  await ensureSchema(env.DB);
  const f = await readFilters(url);
  const rows = (await env.DB.prepare(`SELECT * FROM leads ${f.sql} ORDER BY created_at DESC LIMIT 500`).bind(...f.args).all()).results || [];
  const sites = ((await env.DB.prepare('SELECT site, COUNT(*) AS n FROM leads GROUP BY site ORDER BY n DESC').all()).results || []);
  const counts = ((await env.DB.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all()).results || []);
  const contactRows = ((await env.DB.prepare('SELECT * FROM contacts').all()).results || []);
  const contactOf = new Map(contactRows.map((c) => [`${c.site}|${c.slug}`, c]));
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
          <td>${esc(r.target || '-')}${r.page ? `<div class="muted"><a href="${esc(r.page)}" rel="noopener noreferrer" target="_blank">page</a></div>` : ''}${forwardCell(r, d, contactOf.get(`${r.site}|${r.target}`))}</td>
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
  <header><h1>Lead inbox</h1><nav style="display:flex;gap:16px"><a href="/admin/contacts">Contacts</a><a href="/admin/export.csv${esc(qs)}">Download CSV</a></nav></header>
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

// ---------- Contacts (forwarding leads) ----------

const SITE_NAMES = { 'copackindex.com': 'CopackIndex', 'clinicchecked.com': 'ClinicChecked', 'yachtvane.com': 'Yachtvane' };
const siteName = (site) => SITE_NAMES[site] || site;
const mailto = (to, subject, body) => `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

function forwardBody(r, d) {
  const what = { brief: 'a brief', enquiry: 'an enquiry', consultation: 'a consultation request', compare: 'a request', charter: 'a charter request' }[r.kind] || 'a request';
  return [
    'Hello,',
    '',
    `We received ${what} for you through ${siteName(r.site)} (${r.site}). The sender agreed to us passing their details to you so you can reply directly.`,
    '',
    `Name: ${r.name || '-'}`,
    `Email: ${r.email}`,
    ...(r.phone ? [`Phone: ${r.phone}`] : []),
    ...Object.entries(d).map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ')}: ${v}`),
    '',
    'Please reply to them directly. If you would rather not receive requests from us, just reply to this email and we will stop.',
    '',
    `${siteName(r.site)}`,
    'User Companies Ltd',
  ].join('\n');
}

function forwardCell(r, d, c) {
  if (!r.target || r.kind === 'newsletter' || r.kind === 'listing') return '';
  if (!c || !c.email) return `<div class="muted" style="margin-top:6px">No contact email. <a href="/admin/contacts?site=${encodeURIComponent(r.site)}&slug=${encodeURIComponent(r.target)}#edit">Add one</a></div>`;
  if (c.status === 'declined') return `<div class="muted" style="margin-top:6px">${esc(c.email)}<br>Declined requests: don’t forward</div>`;
  const href = mailto(c.email, `New ${r.kind} from ${siteName(r.site)}${r.name ? `: ${r.name}` : ''}`, forwardBody(r, d));
  return `<div style="margin-top:6px"><div class="muted">${esc(c.email)} <span class="tag">${esc(c.status)}</span></div><a class="btn" href="${esc(href)}">Forward by email</a></div>`;
}

function askBody(site, c) {
  const link = `https://${site}/`;
  return [
    'Hello,',
    '',
    `${c.name || 'Your business'} is listed on ${siteName(site)} (${link}), an independent directory that helps brands and customers find suppliers like you.`,
    '',
    'When someone sends a request for you through the site, we can pass it straight to you. There is no charge for this. Would you like to receive these requests, and is this the right email address for them?',
    '',
    'If anything in your listing is out of date, reply and we will correct it. If you would rather not hear from us, just say so and we will not contact you again.',
    '',
    'Best regards,',
    siteName(site),
    'User Companies Ltd',
  ].join('\n');
}

// CSV with a header row: site,slug,name,email,source,checked (other columns ignored).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

async function contactsPage(env, url, msg = '') {
  await ensureSchema(env.DB);
  const site = clip(url.searchParams.get('site'), 60);
  const slug = clip(url.searchParams.get('slug'), 200);
  const rows = ((await env.DB.prepare(`SELECT * FROM contacts ${site ? 'WHERE site = ?' : ''} ORDER BY site, name`).bind(...(site ? [site] : [])).all()).results || []);
  const editing = (site && slug && rows.find((c) => c.slug === slug)) || { site: site || env.SITE || '', slug: slug || '', name: '', email: '', source: '', status: 'not asked', note: '' };
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  const counts = CONTACT_STATUSES.map((st) => `<span>${esc(st)}: <strong>${rows.filter((c) => c.status === st).length}</strong></span>`).join('');
  const table = rows.length === 0 ? '<div class="empty">No contacts yet. Paste the CSV from the weekly run below.</div>'
    : `<div class="wrap"><table><thead><tr><th>Business</th><th>Site</th><th>Email</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((c) => `
      <tr><td>${esc(c.name || c.slug)}<div class="muted">${esc(c.slug)}</div></td><td>${esc(c.site)}</td>
      <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="muted">-</span>'}</td>
      <td>${c.source ? `<a href="${esc(c.source)}" rel="noopener noreferrer" target="_blank">page</a>` : '-'}<div class="muted">${esc(c.checked || '')}</div></td>
      <td><span class="tag">${esc(c.status)}</span>${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}</td>
      <td><div class="row-actions">
        ${c.email && c.status === 'not asked' ? `<a class="btn" href="${esc(mailto(c.email, `Your listing on ${siteName(c.site)}`, askBody(c.site, c)))}">Ask to receive requests</a>` : ''}
        <a href="/admin/contacts?site=${encodeURIComponent(c.site)}&slug=${encodeURIComponent(c.slug)}#edit">Edit</a>
      </div></td></tr>`).join('')}</tbody></table></div>`;

  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Contacts</title><style>${PAGE_CSS}</style></head><body>
  <header><h1>Contacts</h1><nav style="display:flex;gap:16px"><a href="/admin">Lead inbox</a></nav></header>
  <main>
    ${msg ? `<p class="summary"><span>${esc(msg)}</span></p>` : ''}
    <p class="muted" style="font-size:13px;max-width:760px">Enquiry emails for listed businesses, taken from their own websites. Private: never shown on the sites. After you email a business asking whether it wants requests, set its status. Don’t forward to anyone marked “declined”.</p>
    <div class="summary">${counts}</div>
    <form class="filters" method="get" action="/admin/contacts"><label>Site<select name="site"><option value="">All sites</option>${Object.keys(SITE_NAMES).map((x) => opt(x, site)).join('')}</select></label><button type="submit">Filter</button></form>
    ${table}
    <h2 id="edit" style="font-size:17px;margin-top:28px">Add or edit a contact</h2>
    <form method="post" action="/admin/contacts/save" class="filters">
      <label>Site<select name="site">${Object.keys(SITE_NAMES).map((x) => opt(x, editing.site)).join('')}</select></label>
      <label>Listing slug<input name="slug" required value="${esc(editing.slug)}" size="30"></label>
      <label>Business name<input name="name" value="${esc(editing.name || '')}" size="24"></label>
      <label>Email<input name="email" type="email" value="${esc(editing.email || '')}" size="28"></label>
      <label>Source page<input name="source" type="url" value="${esc(editing.source || '')}" size="30"></label>
      <label>Status<select name="status">${CONTACT_STATUSES.map((x) => opt(x, editing.status)).join('')}</select></label>
      <label>Note<input name="note" value="${esc(editing.note || '')}" size="24"></label>
      <button type="submit">Save</button>
    </form>
    ${editing.slug && rows.find((c) => c.slug === editing.slug) ? `<form method="post" action="/admin/contacts/delete" onsubmit="return confirm('Remove this contact?')"><input type="hidden" name="site" value="${esc(editing.site)}"><input type="hidden" name="slug" value="${esc(editing.slug)}"><button class="danger" type="submit">Remove contact</button></form>` : ''}
    <h2 style="font-size:17px;margin-top:28px">Import from the weekly run</h2>
    <form method="post" action="/admin/contacts/import" style="display:grid;gap:8px;max-width:900px">
      <label>Paste CSV (header: site,slug,name,email,source,checked). New rows are added; existing ones get the new email and source but keep their status and note.
        <textarea name="csv" rows="8" required placeholder="site,slug,name,email,source,checked"></textarea></label>
      <div><button type="submit">Import</button></div>
    </form>
  </main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}

async function contactsWrite(req, env, url, action) {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) return new Response('Bad request', { status: 400 });
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
  await ensureSchema(env.DB);
  const form = await req.formData();
  const now = new Date().toISOString();
  const validSite = (x) => Object.hasOwn(SITE_NAMES, x);
  const validSlug = (x) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x);
  const validUrl = (x) => !x || /^https?:\/\/\S+$/.test(x);

  if (action === 'import') {
    const rows = parseCsv(String(form.get('csv') || '').slice(0, 500000));
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const col = (r, name) => clip(r[head.indexOf(name)] ?? '', 500);
    let added = 0, skipped = 0;
    for (const r of rows.slice(0, 2000)) {
      const site = col(r, 'site'), slug = col(r, 'slug'), email = col(r, 'email').toLowerCase(), source = col(r, 'source');
      if (!validSite(site) || !validSlug(slug) || (email && !isEmail(email)) || !validUrl(source)) { skipped++; continue; }
      await env.DB.prepare(`INSERT INTO contacts (site, slug, name, email, source, checked, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site, slug) DO UPDATE SET name = excluded.name, email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE contacts.email END,
        source = excluded.source, checked = excluded.checked, updated_at = excluded.updated_at`)
        .bind(site, slug, col(r, 'name'), email, source, col(r, 'checked'), now).run();
      added++;
    }
    return contactsPage(env, new URL('/admin/contacts', url.origin), `Imported ${added} contact${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} invalid row${skipped === 1 ? '' : 's'}` : ''}.`);
  }

  const site = clip(form.get('site'), 60), slug = clip(form.get('slug'), 200);
  if (!validSite(site) || !validSlug(slug)) return new Response('Bad site or slug', { status: 400 });
  if (action === 'delete') {
    await env.DB.prepare('DELETE FROM contacts WHERE site = ? AND slug = ?').bind(site, slug).run();
  } else {
    const email = clip(form.get('email'), 254).toLowerCase(), source = clip(form.get('source'), 500), status = String(form.get('status') || 'not asked');
    if ((email && !isEmail(email)) || !validUrl(source) || !CONTACT_STATUSES.includes(status)) return new Response('Bad email, source or status', { status: 400 });
    await env.DB.prepare(`INSERT INTO contacts (site, slug, name, email, source, checked, status, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, slug) DO UPDATE SET name = excluded.name, email = excluded.email, source = excluded.source, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(site, slug, clip(form.get('name'), 200), email, source, now.slice(0, 10), status, clip(form.get('note'), 1000), now).run();
  }
  return Response.redirect(`${url.origin}/admin/contacts?site=${encodeURIComponent(site)}`, 303);
}

async function handleAdmin(req, env, url) {
  if (!env.ADMIN_PASSWORD) return new Response('Set the ADMIN_PASSWORD secret on this Worker to open the inbox.', { status: 503 });
  if (!authorised(req, env)) return unauthorized();
  if (!env.DB) return new Response('The lead inbox database is not connected yet.', { status: 503 });
  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) return adminPage(env, url);
  if (req.method === 'GET' && url.pathname === '/admin/export.csv') return adminExport(env, url);
  if (req.method === 'POST' && url.pathname === '/admin/status') return adminWrite(req, env, url, 'status');
  if (req.method === 'POST' && url.pathname === '/admin/delete') return adminWrite(req, env, url, 'delete');
  if (req.method === 'GET' && url.pathname === '/admin/contacts') return contactsPage(env, url);
  if (req.method === 'POST' && url.pathname === '/admin/contacts/import') return contactsWrite(req, env, url, 'import');
  if (req.method === 'POST' && url.pathname === '/admin/contacts/save') return contactsWrite(req, env, url, 'save');
  if (req.method === 'POST' && url.pathname === '/admin/contacts/delete') return contactsWrite(req, env, url, 'delete');
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
