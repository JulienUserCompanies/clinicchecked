# ClinicChecked

A static directory of UK hair transplant, cosmetic surgery and aesthetics clinics, showing each clinic's regulator registration and latest inspection rating. Built with Astro; every page is plain HTML.

## How it runs on its own

| What | When | Who |
| --- | --- | --- |
| Refresh CQC status and ratings for listed clinics | Mondays 05:17 UTC | GitHub Actions (`.github/workflows/refresh.yml`) |
| Add new clinics, write 2 guides, log demand and lead buyers | Mondays | Claude scheduled task "ClinicChecked weekly run" |
| Build and publish the site | Every push to `main` | Cloudflare Pages |

## One-time setup

1. **Cloudflare Pages:** create a project from this repository. Build command `npm run check-data && npm run build`, output folder `dist`, Node 22 (`NODE_VERSION=22`).
2. **Environment variables** in Cloudflare Pages (all optional until launch):
   - `SITE_URL`: the live domain, e.g. `https://clinicchecked.com`
   - `CONTACT_EMAIL`: shown on the For clinics and Privacy pages
   - `SITE_OPERATOR`: your legal or trading name, for the privacy notice
   - `FORM_ENDPOINT`: a form service URL (e.g. Formspree). Turns on consultation requests on clinic pages. Set `CONTACT_EMAIL` and `SITE_OPERATOR` first.
3. **GitHub secret** `CQC_API_KEY`: a free key from the CQC API portal (https://api-portal.service.cqc.org.uk). Without it the weekly refresh is skipped and listings only change when Claude updates them.

## Adding content

- **A clinic:** add an object to `src/data/clinics.json`. `npm run check-data` lists anything missing. Only list a clinic whose registration you have opened on the regulator's site, and put that page in `sources`.
- **A guide:** add a Markdown file to `src/content/guides/` with `title`, `description`, `date` (and optional `treatment` or `area` to show related clinics). Every factual claim links to its source.

## Commands

- `npm run dev`: local preview
- `npm run check-data`: validate the clinic data
- `npm run build`: build to `dist/`
