#!/usr/bin/env node
// Renders the PWA icons (src/client/public/icons/*.png) from src/client/public/favicon.svg
// with playwright-core's Chromium (a devDependency; `npx playwright-core install chromium` if it has
// none, or CHROME_PATH=<a Chrome>, or it falls back to an installed Google Chrome). The PNGs are checked in, so the build never needs this: run it again only when the favicon
// changes, `node scripts/pwa-icons.mjs`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'src/client/public');
const out = join(pub, 'icons');
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
// The app's paper (style.css --paper-2): the tile behind the desk.
const PAPER = '#fff1de';

// size: the PNG's side; art: the favicon's share of it; radius: the tile's corner, as a share of
// the side (0 = a full square, for the platforms that round or mask it themselves).
const ICONS = [
  { file: 'icon-192.png', size: 192, art: 0.86, radius: 0.22 },
  { file: 'icon-512.png', size: 512, art: 0.86, radius: 0.22 },
  // Maskable: full bleed, the art inside the 80% safe circle (the favicon's 64 box at 62% fits it).
  { file: 'icon-maskable-512.png', size: 512, art: 0.62, radius: 0 },
  // iOS rounds the corners itself and would show a transparent corner as black.
  { file: 'apple-touch-icon.png', size: 180, art: 0.8, radius: 0 },
];

const page = (i) => `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${i.size}px;height:${i.size}px;display:grid;place-items:center;background:${PAPER};border-radius:${i.radius * 100}%">
<div style="width:${i.size * i.art}px;height:${i.size * i.art}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
</div></body></html>`;

mkdirSync(out, { recursive: true });
const launch = async () => {
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH });
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: 'chrome' });
  }
};
const browser = await launch();
try {
  for (const i of ICONS) {
    const p = await browser.newPage({ viewport: { width: i.size, height: i.size }, deviceScaleFactor: 1 });
    await p.setContent(page(i));
    writeFileSync(join(out, i.file), await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: i.size, height: i.size } }));
    await p.close();
    console.log(`  ${i.file} ${i.size}×${i.size}`);
  }
} finally {
  await browser.close();
}
