// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages serves this as a project site (seesaltlab.github.io/potent-energy/), not at the
// domain root, so it needs a base path -- Vercel and local dev both serve at root, so they don't.
// GITHUB_PAGES is set as a build-time env var only in .github/workflows/deploy.yml.
const isGhPages = !!process.env.GITHUB_PAGES;

// https://astro.build/config
export default defineConfig({
  site: isGhPages ? 'https://seesaltlab.github.io' : undefined,
  // Trailing slash matters: import.meta.env.BASE_URL is this string verbatim, and
  // carrier.js concatenates it directly with 'models/...' with no separator of its own.
  base: isGhPages ? '/potent-energy/' : '/'
});
