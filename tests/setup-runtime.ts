import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Unit tests retain tiny private safety fixtures. A clean clone must not need
// the optional Axis bootstrap (which downloads software and provisions data).
const root = realpathSync(resolve(import.meta.dirname, '..'));
const runtime = resolve(root, '.runtime');
mkdirSync(runtime, { recursive: true, mode: 0o700 });
if (!lstatSync(runtime).isDirectory() || realpathSync(runtime) !== runtime) {
  throw new Error('Tests require a real local .runtime directory, not a symlink.');
}
