// One-off generator for the toolbar/store icons (src/icons/*.png).
// Renders an SVG with Playwright's Chromium, because no image library is assumed.
// Run: node scripts/make-icons.mjs

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { chromiumLaunchOptions } from './chromium.mjs';

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#17604f"/>
  <path d="M30 34h68a10 10 0 0 1 10 10v36a10 10 0 0 1-10 10H60l-20 16v-16H30a10 10 0 0 1-10-10V44a10 10 0 0 1 10-10z" fill="#fff"/>
  <path d="M64 46l4.5 11.5L80 62l-11.5 4.5L64 78l-4.5-11.5L48 62l11.5-4.5z" fill="#17604f"/>
</svg>`;

await mkdir('src/icons', { recursive: true });
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.locator('svg').screenshot({ path: `src/icons/icon${size}.png`, omitBackground: true });
}
await browser.close();
console.log('Icons written to src/icons/');
