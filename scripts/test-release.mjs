// Check the actual ZIP, launch it with empty settings, then run the full mocked E2E suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './chromium.mjs';
import { packageRelease, unpackRelease } from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = await packageRelease(root);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lca-release-test-'));
const extension = path.join(temporary, 'extension');
let context;
try {
  await unpackRelease(artifact, extension);
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    ...chromiumLaunchOptions(root), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let apiRequests = 0;
  for (const host of ['api.anthropic.com', 'openrouter.ai', 'api.harmonic.ai']) {
    await context.route(`https://${host}/**`, (route) => { apiRequests++; return route.abort(); });
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await page.locator('#settingsView').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#apiKey').inputValue(), '');
  assert.equal(await page.locator('#aboutMe').inputValue(), '');
  assert.equal(await page.locator('#settingsIntro').isVisible(), true);
  assert.equal(apiRequests, 0);
  await context.close(); context = null;
  console.log('ZIP checksum, empty first-run profile and browser loading: OK.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/e2e/extension.test.js'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, LCA_EXTENSION_DIR: extension },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve()
      : reject(new Error(`Release E2E failed (${signal || code}).`)));
  });
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
