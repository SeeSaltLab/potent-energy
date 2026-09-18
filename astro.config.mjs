// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages project-site config: served at seesaltlab.github.io/potent-energy/,
  // not the domain root, so every root-relative URL needs this prefix.
  site: 'https://seesaltlab.github.io',
  base: '/potent-energy'
});
