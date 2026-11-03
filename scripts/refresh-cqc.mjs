// Weekly refresh of CQC registration status and ratings for every listed clinic.
// Runs in GitHub Actions. Needs a free CQC API subscription key in the CQC_API_KEY secret
// (register at https://api-portal.service.cqc.org.uk). Without a key it does nothing.
//
// What it changes, per clinic with a CQC registration:
//   - status: "Registered" or "Archived" (CQC "Deregistered")
//   - rating and ratingDate from the latest overall rating
//   - checked: today's date
// Deregistered clinics are moved to src/data/removed.json so they leave the site but stay on file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const KEY = process.env.CQC_API_KEY;
const BASE = 'https://api.service.cqc.org.uk/public/v1';
const file = new URL('../src/data/clinics.json', import.meta.url);
const removedFile = new URL('../src/data/removed.json', import.meta.url);

if (!KEY) {
  console.log('CQC_API_KEY is not set: skipping the CQC refresh.');
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const validRatings = new Set(['Outstanding', 'Good', 'Requires improvement', 'Inadequate']);

async function getLocation(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${BASE}/locations/${encodeURIComponent(id)}`, {
      headers: { 'Ocp-Apim-Subscription-Key': KEY, Accept: 'application/json', 'User-Agent': 'clinic-directory-refresh' },
    });
    if (res.status === 429) { await sleep(5000 * attempt); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CQC API ${res.status} for ${id}`);
    return res.json();
  }
  throw new Error(`CQC API kept rate-limiting ${id}`);
}

const clinics = JSON.parse(readFileSync(file, 'utf8'));
const removed = existsSync(removedFile) ? JSON.parse(readFileSync(removedFile, 'utf8')) : [];
const kept = [];
let updated = 0, failed = 0;

for (const c of clinics) {
  const reg = (c.registrations || []).find((r) => r.regulator === 'CQC' && r.id);
  if (!reg) { kept.push(c); continue; }
  try {
    const loc = await getLocation(reg.id);
    await sleep(300);
    if (!loc) { console.warn(`Not found on CQC: ${c.name} (${reg.id}); left unchanged`); kept.push(c); continue; }
    const status = String(loc.registrationStatus || '').toLowerCase();
    if (status === 'deregistered') {
      reg.status = 'Archived';
      c.checked = today;
      removed.push({ ...c, removedOn: today, reason: 'CQC registration deregistered' });
      console.log(`Removed (deregistered): ${c.name}`);
      continue;
    }
    const overall = loc.currentRatings?.overall;
    if (overall?.rating && validRatings.has(overall.rating)) {
      reg.rating = overall.rating;
      if (overall.reportDate) reg.ratingDate = String(overall.reportDate).slice(0, 10);
    }
    reg.status = 'Registered';
    reg.url = `https://www.cqc.org.uk/location/${reg.id}`;
    if (!c.phone && loc.mainPhoneNumber) c.phone = String(loc.mainPhoneNumber);
    if (!c.website && loc.website) {
      const w = /^https?:\/\//i.test(loc.website) ? loc.website : `https://${loc.website}`;
      try { new URL(w); c.website = w; } catch {}
    }
    c.checked = today;
    updated++;
    kept.push(c);
  } catch (e) {
    failed++;
    console.warn(`Could not refresh ${c.name}: ${e.message}`);
    kept.push(c);
  }
}

writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
writeFileSync(removedFile, JSON.stringify(removed, null, 2) + '\n');
console.log(`CQC refresh: ${updated} updated, ${clinics.length - kept.length} removed, ${failed} failed.`);
if (failed && !updated) process.exit(1);
