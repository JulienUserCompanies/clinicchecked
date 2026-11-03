import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { site } from './src/site.config.mjs';

export default defineConfig({
  site: site.url,
  trailingSlash: 'always',
  integrations: [sitemap()],
});
