// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages project-site config: served at seesaltlab.github.io/potent-energy/,
  // not the domain root, so every root-relative URL needs this prefix.
  site: 'https://seesaltlab.github.io',
  // Trailing slash matters: import.meta.env.BASE_URL is this string verbatim, and
  // carrier.js concatenates it directly with 'models/...' with no separator of its own.
  base: '/potent-energy/'
});
