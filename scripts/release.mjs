// Distribution files only. Never package the maintainer's personal dist/.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, zipSync } from 'fflate';

const run = promisify(execFile);
export const RELEASE_FILES = Object.freeze([
  'background.js', 'content.js', 'defaults.json', 'icons/icon128.png',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png',
  'manifest.json', 'sidepanel.css', 'sidepanel.html', 'sidepanel.js',
]);

export function releasePaths(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const filename = `linkedin-comment-assistant-v${version}.zip`;
  const directory = path.join(root, '.cache', 'releases', `v${version}`);
  return { directory, filename, zipPath: path.join(directory, filename), checksumPath: path.join(directory, 'SHA256SUMS.txt') };
}

function validateNames(names) {
  const sorted = [...names].sort();
  if (sorted.length !== RELEASE_FILES.length || sorted.some((name, i) => name !== RELEASE_FILES[i])) {
    throw new Error('Release must contain exactly the allowed extension files.');
  }
}

function jsonFile(files, filename) {
  try { return JSON.parse(Buffer.from(files[filename]).toString('utf8')); }
  catch { throw new Error(`Invalid release ${filename}; refusing to package.`); }
}

export function validateReleaseFiles(files, version) {
  validateNames(Object.keys(files));
  if (Object.values(files).some((bytes) => !(bytes instanceof Uint8Array) || !bytes.length)) {
    throw new Error('Release files must be non-empty byte arrays.');
  }
  const defaults = jsonFile(files, 'defaults.json');
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || Object.keys(defaults).length) {
    throw new Error('Release defaults.json must be an empty object.');
  }
  const manifest = jsonFile(files, 'manifest.json');
  if (manifest.version !== version || manifest.manifest_version !== 3) {
    throw new Error('Release manifest version does not match package.json.');
  }
  const icons = (value) => typeof value === 'string' ? [value] : Object.values(value || {});
  const references = [manifest.background?.service_worker, manifest.side_panel?.default_path,
    ...icons(manifest.icons), ...icons(manifest.action?.default_icon),
    ...(manifest.content_scripts || []).flatMap((script) => [...(script.js || []), ...(script.css || [])])];
  if (references.some((name) => typeof name !== 'string' || !Object.hasOwn(files, name))) {
    throw new Error('Release manifest references a missing file.');
  }
  return manifest;
}

export async function readReleaseDirectory(directory, version) {
  const names = [];
  async function walk(relative = '') {
    const current = path.join(directory, relative);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Release symlinks are not allowed.');
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Release symlinks are not allowed.');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error('Unsupported release file type.');
    }
  }
  await walk();
  validateNames(names); // Reject unexpected paths before reading their contents.
  const files = Object.fromEntries(await Promise.all(names.sort().map(async (name) =>
    [name, await readFile(path.join(directory, name))])));
  validateReleaseFiles(files, version);
  return files;
}

export function createReleaseZip(files, version) {
  validateReleaseFiles(files, version);
  const ordered = Object.fromEntries(RELEASE_FILES.map((name) => [name, files[name]]));
  return zipSync(ordered, { level: 9, mtime: new Date(2020, 0, 1) });
}

export function checksumLine(bytes, filename) {
  return `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`;
}

export async function packageRelease(root) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const result = releasePaths(root, version);
  const { stdout, stderr } = await run(process.execPath, [path.join(root, 'build.mjs'), '--release'], { cwd: root });
  process.stdout.write(stdout); process.stderr.write(stderr);
  const files = await readReleaseDirectory(path.join(root, '.cache', 'release-build'), version);
  const bytes = createReleaseZip(files, version);
  await mkdir(result.directory, { recursive: true });
  await writeFile(result.zipPath, bytes);
  await writeFile(result.checksumPath, checksumLine(bytes, result.filename));
  console.log(`Package: ${result.zipPath} (${bytes.length} bytes, ${RELEASE_FILES.length} files)`);
  return { ...result, version };
}

export async function unpackRelease(artifact, directory) {
  const bytes = await readFile(artifact.zipPath);
  const checksum = await readFile(artifact.checksumPath, 'utf8');
  if (checksum !== checksumLine(bytes, artifact.filename)) throw new Error('Release SHA256 checksum mismatch.');
  const files = unzipSync(bytes);
  validateReleaseFiles(files, artifact.version);
  for (const name of RELEASE_FILES) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, files[name]);
  }
  return files;
}
