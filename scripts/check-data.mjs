// Validates src/data/clinics.json before every build. Exits non-zero on any problem,
// so a bad edit (by a person or a scheduled run) can't publish a broken site.
import { readFileSync } from 'node:fs';

const file = new URL('../src/data/clinics.json', import.meta.url);
const treatments = new Set(['hair-transplant', 'cosmetic-surgery', 'aesthetics']);
const regulators = new Set(['CQC', 'HIS', 'HIW', 'RQIA', 'JCCP', 'Save Face']);
const ratings = new Set(['Outstanding', 'Good', 'Requires improvement', 'Inadequate', '']);
const statuses = new Set(['Registered', 'Archived', 'Deregistered', 'Member']);
const isUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

let data;
try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('clinics.json is not valid JSON:', e.message); process.exit(1); }
if (!Array.isArray(data)) { console.error('clinics.json must be an array'); process.exit(1); }

const errors = [];
const slugs = new Set();
data.forEach((c, i) => {
  const at = `#${i} ${c?.name ?? '(no name)'}`;
  for (const k of ['slug', 'name', 'provider', 'services', 'address', 'city', 'area', 'postcode', 'country', 'checked']) {
    if (typeof c[k] !== 'string' || !c[k].trim()) errors.push(`${at}: missing ${k}`);
  }
  if (c.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) errors.push(`${at}: slug must be lower-case words joined by hyphens`);
  if (slugs.has(c.slug)) errors.push(`${at}: duplicate slug ${c.slug}`);
  slugs.add(c.slug);
  if (!Array.isArray(c.treatments) || !c.treatments.length || c.treatments.some((t) => !treatments.has(t))) errors.push(`${at}: treatments must be some of ${[...treatments].join(', ')}`);
  if (c.checked && !isDate(c.checked)) errors.push(`${at}: checked must be YYYY-MM-DD`);
  if (c.website && !isUrl(c.website)) errors.push(`${at}: website is not a URL`);
  if (!Array.isArray(c.sources) || !c.sources.length || c.sources.some((s) => !isUrl(s))) errors.push(`${at}: needs at least one source URL`);
  if (!Array.isArray(c.registrations) || !c.registrations.length) errors.push(`${at}: needs at least one registration`);
  (c.registrations || []).forEach((r, j) => {
    const rat = `${at} registration ${j}`;
    if (!regulators.has(r.regulator)) errors.push(`${rat}: unknown regulator ${r.regulator}`);
    if (!statuses.has(r.status)) errors.push(`${rat}: status must be one of ${[...statuses].join(', ')}`);
    if (!ratings.has(r.rating ?? '')) errors.push(`${rat}: unknown rating ${r.rating}`);
    if (r.ratingDate && !isDate(r.ratingDate)) errors.push(`${rat}: ratingDate must be YYYY-MM-DD`);
    if (r.url && !isUrl(r.url)) errors.push(`${rat}: url is not a URL`);
  });
  if (c.registrations?.[0] && c.registrations[0].status !== 'Registered' && c.registrations[0].status !== 'Member') {
    errors.push(`${at}: first registration is ${c.registrations[0].status}; remove the clinic from the list instead`);
  }
});

if (errors.length) {
  console.error(`clinics.json has ${errors.length} problem(s):\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log(`clinics.json OK: ${data.length} clinics.`);
