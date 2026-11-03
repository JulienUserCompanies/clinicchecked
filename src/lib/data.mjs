import clinicsRaw from '../data/clinics.json';
import { site } from '../site.config.mjs';

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const ratingOrder = { Outstanding: 0, Good: 1, 'Requires improvement': 2, Inadequate: 3 };

export const ratingClass = (r) => 'r-' + (r ? slugify(r) : 'unrated');

/** The registration we show first: the statutory regulator if there is one. */
export const primaryRegistration = (c) => c.registrations?.[0] ?? null;

export const clinics = clinicsRaw
  .filter((c) => c && c.name && c.slug)
  .map((c) => ({ ...c, areaSlug: slugify(c.area || c.city), citySlug: slugify(c.city) }))
  .sort((a, b) => {
    const ra = ratingOrder[primaryRegistration(a)?.rating] ?? 9;
    const rb = ratingOrder[primaryRegistration(b)?.rating] ?? 9;
    return (b.featured === true) - (a.featured === true) || ra - rb || a.name.localeCompare(b.name);
  });

export const areas = Object.values(
  clinics.reduce((acc, c) => {
    const key = c.areaSlug;
    acc[key] ??= { slug: key, name: c.area || c.city, country: c.country, clinics: [] };
    acc[key].clinics.push(c);
    return acc;
  }, {}),
).sort((a, b) => b.clinics.length - a.clinics.length || a.name.localeCompare(b.name));

export const treatments = site.treatments.map((t) => ({ ...t, clinics: clinics.filter((c) => c.treatments?.includes(t.slug)) }));

export const treatmentName = (slug) => site.treatments.find((t) => t.slug === slug)?.name ?? slug;

export const regulatorInfo = (key) => site.regulators[key] ?? { name: key, short: key };

const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : fmt.format(d);
};

/** Years since a rating, to flag old inspections. */
export const ratingAgeYears = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
};

export const lastChecked = clinics.reduce((m, c) => (c.checked > m ? c.checked : m), '');
