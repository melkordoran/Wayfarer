import { dirname, join, resolve } from 'node:path';

/** Do not grant the development server the workspace root: it contains private
 * primary and isolated configurations. Only this cache descendant is permitted. */
export function isolatedPreviewFileAllowlist(projectRoot: string, fixtureDirectory: string): string[] {
  const root = resolve(projectRoot), fixture = resolve(fixtureDirectory);
  if (dirname(fixture) !== join(root, '.runtime') || !/^axis-isolated-[A-Za-z0-9]{6,}$/.test(fixture.slice(dirname(fixture).length + 1))) throw new Error('Preview filesystem scope requires an isolated fixture directory.');
  return ['src', 'public', 'node_modules', 'index.html', 'package.json'].map(path => join(root, path)).concat(join(fixture, 'vite-cache'));
}
