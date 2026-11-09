// Build the unpacked extension into dist/ (load this folder in edge://extensions).
// - content.js is bundled as a classic script (IIFE): MV3 content scripts are not modules.
// - background.js and sidepanel.js are ES modules; the side panel bundle includes the Anthropic SDK.

import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { sanitizeLocalDefaults } from './src/lib/settings.js';

// Optional personal, non-secret defaults (e.g. "O mnie"); git-ignored, see README.
const LOCAL_DEFAULTS_FILE = 'local-config/defaults.json';

const outdir = 'dist';
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  logLevel: 'info',
  legalComments: 'none',
};

// Edge shows the manifest version; package.json is the source of truth
// (bump with `npm version patch|minor`, which also updates the manifest).
const pkgVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const manifestVersion = JSON.parse(await readFile('src/manifest.json', 'utf8')).version;
if (pkgVersion !== manifestVersion) {
  throw new Error(
    `Version mismatch: package.json ${pkgVersion} vs src/manifest.json ${manifestVersion}. Run: node scripts/sync-version.mjs`,
  );
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const builds = [
  { ...common, entryPoints: { content: 'src/content/content.js' }, outdir, format: 'iife' },
  {
    ...common,
    entryPoints: { background: 'src/background.js', sidepanel: 'src/sidepanel/sidepanel.js' },
    outdir,
    format: 'esm',
  },
];

for (const options of builds) {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

await cp('src/manifest.json', `${outdir}/manifest.json`);
await cp('src/sidepanel/sidepanel.html', `${outdir}/sidepanel.html`);
await cp('src/sidepanel/sidepanel.css', `${outdir}/sidepanel.css`);
await cp('src/icons', `${outdir}/icons`, { recursive: true });

let localDefaults = {};
if (existsSync(LOCAL_DEFAULTS_FILE)) {
  let raw;
  try {
    raw = JSON.parse(await readFile(LOCAL_DEFAULTS_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`${LOCAL_DEFAULTS_FILE} is not valid JSON: ${error.message}`);
  }
  if (raw && typeof raw === 'object' && 'apiKeys' in raw) {
    console.warn(`${LOCAL_DEFAULTS_FILE}: "apiKeys" ignored, secrets never go into ${outdir}/.`);
  }
  localDefaults = sanitizeLocalDefaults(raw);
  console.log(`Local defaults applied from ${LOCAL_DEFAULTS_FILE}: ${Object.keys(localDefaults).join(', ') || '(none)'}`);
}
await writeFile(`${outdir}/defaults.json`, `${JSON.stringify(localDefaults, null, 2)}\n`);

console.log(`Extension built in ${outdir}/${watch ? ' (watching for changes)' : ''}`);
