#!/usr/bin/env node
/**
 * Assemble the GitHub Pages landing page from site/ into _site/, with the
 * app icons from public/ and a sitemap. Leaves _site/poi/ alone: the Pages
 * workflow (.github/workflows/pages.yml) puts the fuel and food data there.
 *
 * Usage:
 *   node scripts/build-site.mjs [--out _site]
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://praneth2580.github.io/TrailCompass/';
/** App icons the page reuses. */
const ICONS = ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

const outFlag = process.argv.indexOf('--out');
const out = resolve(root, outFlag >= 0 ? process.argv[outFlag + 1] : '_site');

mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) {
  if (entry !== 'poi') rmSync(join(out, entry), { recursive: true, force: true });
}

cpSync(join(root, 'site'), out, { recursive: true });
for (const icon of ICONS) {
  cpSync(join(root, 'public', icon), join(out, icon));
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <lastmod>${today}</lastmod>
  </url>
</urlset>
`,
);

console.log(`Landing page written to ${relative(root, out) || '.'}`);
