// One place to rename the site, change the domain or switch the niche.
export const site = {
  name: 'ClinicChecked',
  // Set SITE_URL in Cloudflare Pages to the live domain. Used for canonical URLs and the sitemap.
  url: process.env.SITE_URL || 'https://clinicchecked.com',
  tagline: 'Check a private clinic is registered before you book.',
  description:
    'An independent directory of hair transplant, cosmetic surgery and aesthetics clinics, with each clinic’s regulator registration and inspection rating in one place.',
  locale: 'en-GB',
  // Lead form: set FORM_ENDPOINT (e.g. a Formspree form URL) in the host's environment
  // variables to turn on enquiries. Until then, clinic pages link to the clinic's own site.
  formEndpoint: process.env.FORM_ENDPOINT || '',
  contactEmail: process.env.CONTACT_EMAIL || 'hello@usercompanies.com',
  // Legal name of whoever runs the site (needed for the privacy notice before enquiries go live).
  operator: process.env.SITE_OPERATOR || 'User Companies Ltd',
  legal: 'User Companies Ltd, a private limited company incorporated in England, registered number 10069026, Crawley, UK.',
  // Our own lead inbox (worker/index.js + the shared D1 database). Set LEAD_INBOX=off to hide every lead form.
  inbox: process.env.LEAD_INBOX !== 'off',
  treatments: [
    { slug: 'hair-transplant', name: 'Hair transplant', plural: 'hair transplant clinics' },
    { slug: 'cosmetic-surgery', name: 'Cosmetic surgery', plural: 'cosmetic surgery clinics' },
    { slug: 'aesthetics', name: 'Aesthetics and injectables', plural: 'aesthetics clinics' },
  ],
  regulators: {
    CQC: { name: 'Care Quality Commission', short: 'CQC', country: 'England', url: 'https://www.cqc.org.uk' },
    HIS: { name: 'Healthcare Improvement Scotland', short: 'HIS', country: 'Scotland', url: 'https://www.healthcareimprovementscotland.scot' },
    HIW: { name: 'Healthcare Inspectorate Wales', short: 'HIW', country: 'Wales', url: 'https://www.hiw.org.uk' },
    RQIA: { name: 'Regulation and Quality Improvement Authority', short: 'RQIA', country: 'Northern Ireland', url: 'https://www.rqia.org.uk' },
    JCCP: { name: 'Joint Council for Cosmetic Practitioners', short: 'JCCP', country: 'UK', url: 'https://www.jccp.org.uk' },
    'Save Face': { name: 'Save Face', short: 'Save Face', country: 'UK', url: 'https://www.saveface.co.uk' },
  },
};
