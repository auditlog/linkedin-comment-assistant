import { fileURLToPath } from 'node:url';
import { packageRelease } from './release.mjs';

await packageRelease(fileURLToPath(new URL('../', import.meta.url)));
