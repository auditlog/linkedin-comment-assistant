// Copy the version from package.json into src/manifest.json.
// Runs automatically from the npm "version" lifecycle script, so
// `npm version patch|minor|major` bumps both files in one step.
// See also: build.mjs (fails the build when the two versions differ).

import { readFile, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifestPath = 'src/manifest.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`src/manifest.json version -> ${pkg.version}`);
} else {
  console.log(`src/manifest.json already at ${pkg.version}`);
}
