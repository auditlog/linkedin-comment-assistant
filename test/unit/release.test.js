import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zipSync } from 'fflate';
import { RELEASE_FILES, checksumLine, createReleaseZip, readReleaseDirectory,
  releasePaths, unpackRelease, validateReleaseFiles } from '../../scripts/release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const version = '1.2.3';
function fixture() {
  const files = Object.fromEntries(RELEASE_FILES.map((name) => [name, Buffer.from('fixture')]));
  files['defaults.json'] = Buffer.from('{}\n');
  files['manifest.json'] = Buffer.from(JSON.stringify({ manifest_version: 3, version,
    background: { service_worker: 'background.js' }, side_panel: { default_path: 'sidepanel.html' },
    icons: { 16: 'icons/icon16.png' }, content_scripts: [{ js: ['content.js'] }] }));
  return files;
}

test('release defaults reject personal profiles, keys, arrays and malformed JSON without echoing contents', () => {
  for (const contents of ['{"aboutMe":"PRIVATE_PROFILE_CANARY"}', '{"apiKeys":{"anthropic":"TEST_ONLY_CANARY"}}', '[]', 'null', 'INVALID_PRIVATE_CANARY']) {
    const files = fixture(); files['defaults.json'] = Buffer.from(contents);
    assert.throws(() => validateReleaseFiles(files, version), (error) =>
      /Release defaults|Invalid release defaults/.test(error.message) && !error.message.includes('CANARY'));
  }
  assert.equal(validateReleaseFiles(fixture(), version).version, version);
});

test('release rejects unexpected files, missing assets and manifest version/reference mismatches', () => {
  const extra = { ...fixture(), '.env': Buffer.from('NOT_A_REAL_SECRET') };
  assert.throws(() => createReleaseZip(extra, version), /allowed extension files/);
  const missing = fixture(); delete missing['sidepanel.js'];
  assert.throws(() => validateReleaseFiles(missing, version), /allowed extension files/);
  assert.throws(() => validateReleaseFiles(fixture(), '9.9.9'), /version/);
  const bad = fixture();
  bad['manifest.json'] = Buffer.from(JSON.stringify({ manifest_version: 3, version,
    background: { service_worker: 'missing.js' }, side_panel: { default_path: 'sidepanel.html' } }));
  assert.throws(() => validateReleaseFiles(bad, version), /missing file/);
  assert.throws(() => releasePaths('/tmp', '../../private'), /Invalid release version/);
});

test('release archive has stable bytes, valid checksum and only root-level extension assets', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lca-zip-unit-'));
  try {
    const files = fixture();
    const bytes = createReleaseZip(files, version);
    assert.deepEqual(bytes, createReleaseZip(files, version));
    const artifact = { ...releasePaths(temporary, version), version };
    await mkdir(artifact.directory, { recursive: true });
    await writeFile(artifact.zipPath, bytes);
    await writeFile(artifact.checksumPath, checksumLine(bytes, artifact.filename));
    const unpacked = await unpackRelease(artifact, path.join(temporary, 'unpacked'));
    assert.deepEqual(Object.keys(unpacked).sort(), RELEASE_FILES);
    assert.deepEqual(await readReleaseDirectory(path.join(temporary, 'unpacked'), version), files);
    await writeFile(artifact.checksumPath, 'incorrect');
    await assert.rejects(unpackRelease(artifact, path.join(temporary, 'rejected')), /checksum mismatch/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('release refuses ZIP path traversal before writing any extracted file', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lca-zip-traversal-'));
  try {
    const artifact = { ...releasePaths(temporary, version), version };
    await mkdir(artifact.directory, { recursive: true });
    const bytes = zipSync({ ...fixture(), '../escape.txt': Buffer.from('not extracted') });
    await writeFile(artifact.zipPath, bytes);
    await writeFile(artifact.checksumPath, checksumLine(bytes, artifact.filename));
    await assert.rejects(unpackRelease(artifact, path.join(temporary, 'unpacked')), /allowed extension files/);
    await assert.rejects(readFile(path.join(temporary, 'escape.txt')), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('release directory refuses symlinks before reading file contents', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lca-zip-symlink-'));
  try {
    await writeFile(path.join(temporary, 'private-canary'), 'TEST_ONLY');
    await mkdir(path.join(temporary, 'staging'));
    try { await symlink(path.join(temporary, 'private-canary'), path.join(temporary, 'staging', 'defaults.json'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows account cannot create symlinks.'); return; }
      throw error;
    }
    await assert.rejects(readReleaseDirectory(path.join(temporary, 'staging'), version), /symlinks/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('distribution build ignores invalid private defaults and preserves the personal dist directory', async () => {
  // An isolated fixture under .cache can resolve the existing npm tools. It never
  // reads or changes the maintainer's real local-config or dist directories.
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const temporary = await mkdtemp(path.join(root, '.cache', 'release-build-test-'));
  try {
    for (const directory of ['src/content', 'src/sidepanel', 'src/lib', 'local-config', 'dist', '.cache/release-build']) {
      await mkdir(path.join(temporary, directory), { recursive: true });
    }
    for (const name of ['build.mjs', 'src/lib/settings.js', 'src/lib/pricing.js']) {
      await cp(path.join(root, name), path.join(temporary, name));
    }
    await cp(path.join(root, 'src/icons'), path.join(temporary, 'src/icons'), { recursive: true });
    await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module', version }));
    await writeFile(path.join(temporary, 'src/manifest.json'), fixture()['manifest.json']);
    for (const name of ['src/content/content.js', 'src/background.js', 'src/sidepanel/sidepanel.js']) {
      await writeFile(path.join(temporary, name), 'export const fixture = true;\n');
    }
    await writeFile(path.join(temporary, 'src/sidepanel/sidepanel.html'), '<html>fixture</html>');
    await writeFile(path.join(temporary, 'src/sidepanel/sidepanel.css'), 'body {}');
    await writeFile(path.join(temporary, 'local-config/defaults.json'), 'INVALID_PRIVATE_PROFILE_CANARY');
    await writeFile(path.join(temporary, 'dist/private-canary'), 'PERSONAL_BUILD_UNCHANGED');
    await writeFile(path.join(temporary, '.cache/release-build/stale-private-file'), 'STALE');
    const { stdout } = await run(process.execPath, ['build.mjs', '--release'], { cwd: temporary });
    const files = await readReleaseDirectory(path.join(temporary, '.cache/release-build'), version);
    assert.deepEqual(JSON.parse(files['defaults.json'].toString()), {});
    assert.doesNotMatch(stdout, /Local defaults applied|CANARY/);
    assert.equal(await readFile(path.join(temporary, 'dist/private-canary'), 'utf8'), 'PERSONAL_BUILD_UNCHANGED');
    assert.equal(await readFile(path.join(temporary, 'local-config/defaults.json'), 'utf8'), 'INVALID_PRIVATE_PROFILE_CANARY');
    await assert.rejects(run(process.execPath, ['build.mjs', '--release', '--watch'], { cwd: temporary }), /cannot use --watch/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
