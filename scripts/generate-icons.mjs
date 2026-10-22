/**
 * Generate TrailCompass web + Android launcher/splash assets from the brand mark.
 * Run: node scripts/generate-icons.mjs
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#06100c';
const ACCENT = '#f0a020';
const ACCENT_DIM = '#c47d10';
const FACE = '#0a1511';
const RING = '#1a2e24';
const MUTED = '#8aa194';
const SOUTH = '#3d5a4a';
const PIVOT = '#eef3ec';

function n(v) {
  return Number(v.toFixed(2));
}

function markSvg({ size, pad = 0, transparent = false, rounded = false }) {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const r = (s / 2 - pad) * 0.78;
  const tick = r * 0.08;
  const needleW = r * 0.28;
  const northTip = cy - r * 0.78;
  const southTip = cy + r * 0.78;
  const hub = r * 0.14;
  const rx = rounded ? s * 0.22 : 0;
  const strokeOuter = Math.max(1.5, r * 0.08);
  const strokeAccent = Math.max(1, r * 0.035);
  const strokeTick = Math.max(1.5, r * 0.045);

  const bg = transparent
    ? ''
    : `<rect width="${s}" height="${s}" rx="${n(rx)}" fill="${BG}"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" fill="none">
  ${bg}
  <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" stroke="${RING}" stroke-width="${n(strokeOuter)}" fill="${FACE}"/>
  <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.86)}" stroke="${ACCENT}" stroke-width="${n(strokeAccent)}" opacity="0.55"/>
  <g stroke="${MUTED}" stroke-width="${n(strokeTick)}" stroke-linecap="round" opacity="0.85">
    <path d="M${n(cx)} ${n(cy - r + tick * 0.2)}v${n(tick)}"/>
    <path d="M${n(cx)} ${n(cy + r - tick * 1.2)}v${n(tick)}"/>
    <path d="M${n(cx - r + tick * 0.2)} ${n(cy)}h${n(tick)}"/>
    <path d="M${n(cx + r - tick * 1.2)} ${n(cy)}h${n(tick)}"/>
  </g>
  <path d="M${n(cx)} ${n(cy + hub * 0.4)} L${n(cx - needleW)} ${n(southTip)} L${n(cx)} ${n(southTip - r * 0.14)} L${n(cx + needleW)} ${n(southTip)} Z" fill="${SOUTH}"/>
  <path d="M${n(cx)} ${n(cy - hub * 0.4)} L${n(cx - needleW)} ${n(northTip)} L${n(cx)} ${n(northTip + r * 0.14)} L${n(cx + needleW)} ${n(northTip)} Z" fill="${ACCENT}"/>
  <path d="M${n(cx)} ${n(cy - hub * 0.4)} L${n(cx)} ${n(northTip + r * 0.14)} L${n(cx + needleW)} ${n(northTip)} Z" fill="${ACCENT_DIM}"/>
  <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(hub)}" fill="${PIVOT}"/>
  <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(hub * 0.5)}" fill="${BG}"/>
</svg>`;
}

async function rasterize(svg, outPath, { size, background } = {}) {
  await mkdir(dirname(outPath), { recursive: true });
  let pipeline = sharp(Buffer.from(svg));
  if (size) pipeline = pipeline.resize(size, size, { fit: 'fill' });
  if (background) {
    pipeline = pipeline.flatten({ background });
  }
  await pipeline.png().toFile(outPath);
  console.log('wrote', outPath.replace(root + '/', ''));
}

async function splash(outPath, width, height) {
  const markSize = Math.round(Math.min(width, height) * 0.28);
  const mark = markSvg({ size: markSize, rounded: true });
  const markPng = await sharp(Buffer.from(mark)).png().toBuffer();
  const left = Math.round((width - markSize) / 2);
  const top = Math.round((height - markSize) / 2) - Math.round(height * 0.02);

  await mkdir(dirname(outPath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: BG,
    },
  })
    .composite([{ input: markPng, left, top }])
    .png()
    .toFile(outPath);
  console.log('wrote', outPath.replace(root + '/', ''));
}

const androidRes = join(root, 'android/app/src/main/res');

const launcherSizes = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

const foregroundSizes = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

const splashSizes = [
  ['drawable/splash.png', 480, 320],
  ['drawable-land-mdpi/splash.png', 480, 320],
  ['drawable-land-hdpi/splash.png', 800, 480],
  ['drawable-land-xhdpi/splash.png', 1280, 720],
  ['drawable-land-xxhdpi/splash.png', 1600, 960],
  ['drawable-land-xxxhdpi/splash.png', 1920, 1280],
  ['drawable-port-mdpi/splash.png', 320, 480],
  ['drawable-port-hdpi/splash.png', 480, 800],
  ['drawable-port-xhdpi/splash.png', 720, 1280],
  ['drawable-port-xxhdpi/splash.png', 960, 1600],
  ['drawable-port-xxxhdpi/splash.png', 1280, 1920],
];

async function main() {
  // Web
  const favicon64 = markSvg({ size: 64, rounded: true });
  await writeFile(join(root, 'public/favicon.svg'), favicon64);

  await rasterize(markSvg({ size: 180, rounded: true }), join(root, 'public/apple-touch-icon.png'), {
    size: 180,
  });
  await rasterize(markSvg({ size: 32, rounded: true }), join(root, 'public/favicon-32.png'), {
    size: 32,
  });
  await rasterize(markSvg({ size: 192, rounded: true }), join(root, 'public/icon-192.png'), {
    size: 192,
  });
  await rasterize(markSvg({ size: 512, rounded: true }), join(root, 'public/icon-512.png'), {
    size: 512,
  });

  // Master square for tooling
  await rasterize(markSvg({ size: 1024, rounded: false }), join(root, 'resources/icon.png'), {
    size: 1024,
  });
  await writeFile(join(root, 'resources/icon.svg'), markSvg({ size: 1024, rounded: true }));

  // Android adaptive foreground (transparent, mark in safe ~66% zone)
  for (const [density, size] of Object.entries(foregroundSizes)) {
    const pad = size * 0.18; // keep glyph inside adaptive safe zone
    const svg = markSvg({ size, pad, transparent: true });
    await rasterize(svg, join(androidRes, `mipmap-${density}/ic_launcher_foreground.png`), {
      size,
    });
  }

  // Legacy launcher + round (full bleed brand tile)
  for (const [density, size] of Object.entries(launcherSizes)) {
    const svg = markSvg({ size, rounded: false });
    const roundSvg = markSvg({ size, rounded: true });
    await rasterize(svg, join(androidRes, `mipmap-${density}/ic_launcher.png`), { size });
    await rasterize(roundSvg, join(androidRes, `mipmap-${density}/ic_launcher_round.png`), {
      size,
    });
  }

  for (const [rel, w, h] of splashSizes) {
    await splash(join(androidRes, rel), w, h);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
