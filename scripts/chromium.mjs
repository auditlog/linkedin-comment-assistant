// Locate a Chromium binary for scripts and e2e tests on this WSL machine.
// - CHROMIUM_PATH env var wins.
// - Otherwise the newest Chromium already downloaded by Playwright (~/.cache/ms-playwright).
// - NSS/NSPR libraries missing on the host can be provided without root in
//   .cache/chromium-libs (see README, "Testy"), passed via LD_LIBRARY_PATH.

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function newestCachedChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!existsSync(base)) return null;
  const builds = readdirSync(base)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    const exe = path.join(base, build, 'chrome-linux64', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * Options for chromium.launch()/launchPersistentContext().
 * @param {string} projectRoot
 */
export function chromiumLaunchOptions(projectRoot = process.cwd()) {
  const executablePath = process.env.CHROMIUM_PATH || newestCachedChromium() || undefined;
  const env = { ...process.env };
  const libDir = path.join(projectRoot, '.cache', 'chromium-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
  if (existsSync(libDir)) {
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  return { executablePath, env };
}
