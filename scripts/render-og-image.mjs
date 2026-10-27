#!/usr/bin/env node
/**
 * Render site/og-image.png (1200×630), the preview shown when the landing
 * page is shared. Reuses the phone illustration from site/index.html.
 *
 * Needs Playwright's Chromium (npx playwright install chromium), or
 * CHROME_PATH set to an installed Chrome, and a connection for the web fonts.
 * Run: node scripts/render-og-image.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'site/index.html'), 'utf8');
const phone = html.match(/<svg\s+id="phone"[\s\S]*?<\/svg>/)?.[0];
if (!phone) throw new Error('No <svg id="phone"> in site/index.html');
const fontsLink = html.match(/<link\s+rel="stylesheet"\s+href="https:\/\/fonts\.googleapis\.com[^>]*>/)?.[0] ?? '';
const styles = readFileSync(join(root, 'site/styles.css'), 'utf8');
const logo = `data:image/svg+xml;base64,${readFileSync(join(root, 'public/favicon.svg')).toString('base64')}`;

const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    ${fontsLink}
    <style>
      ${styles}
      html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
      .og {
        position: relative;
        display: grid;
        grid-template-columns: 1fr 420px;
        align-items: center;
        width: 1200px;
        height: 630px;
        padding: 0 0 0 76px;
        overflow: hidden;
        background:
          radial-gradient(ellipse 55% 75% at 82% 45%, rgba(240, 160, 32, 0.24), transparent 70%),
          radial-gradient(ellipse 45% 60% at 0% 100%, rgba(61, 190, 165, 0.16), transparent 70%),
          #06100c;
      }
      .og::before {
        content: "";
        position: absolute;
        inset: 0;
        background: repeating-radial-gradient(circle at 80% 45%, transparent 0 30px, rgba(255, 255, 255, 0.04) 30px 31px);
        mask-image: radial-gradient(ellipse 60% 80% at 75% 45%, #000 25%, transparent 80%);
      }
      .og-copy { position: relative; }
      .og-brand { display: flex; align-items: center; gap: 16px; font-family: var(--font-display); font-size: 34px; font-weight: 700; }
      .og-brand img { width: 58px; height: 58px; }
      .og h1 { margin-top: 30px; font-size: 64px; line-height: 1.02; letter-spacing: -0.015em; }
      .og-sub { margin-top: 20px; color: var(--text-soft); font-size: 27px; }
      .og-chips { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 34px; }
      .og-chip { padding: 9px 18px; border: 1.5px solid var(--border-strong); border-radius: 999px; color: var(--text-soft); font-size: 20px; font-weight: 600; white-space: nowrap; }
      .og-chip-accent { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
      .og-phone { position: relative; height: 630px; }
      .og .phone { position: absolute; top: 26px; left: 70px; width: 285px; transform: rotate(5deg); }
    </style>
  </head>
  <body>
    <div class="og">
      <div class="og-copy">
        <div class="og-brand"><img src="${logo}" alt="" />TrailCompass</div>
        <h1>Motorcycle navigation <span class="accent">for India</span></h1>
        <p class="og-sub">Fuel and food stops planned around your ride.</p>
        <div class="og-chips">
          <span class="og-chip">Voice turn-by-turn</span>
          <span class="og-chip">Bike-friendly routes</span>
          <span class="og-chip og-chip-accent">Free for Android</span>
        </div>
      </div>
      <div class="og-phone">${phone}</div>
    </div>
  </body>
</html>`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await tab.setContent(page, { waitUntil: 'networkidle' });
  await tab.evaluate(() => document.fonts.ready);
  const png = await tab.screenshot({ type: 'png' });
  const out = join(root, 'site/og-image.png');
  writeFileSync(out, await sharp(png).png({ compressionLevel: 9, palette: true, quality: 92 }).toBuffer());
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
}
