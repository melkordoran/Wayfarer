import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditRuntimeDependencies } from '../scripts/check-runtime-deps';

describe('bundled desktop runtime policy', () => {
  it('permits only Electron and real Node builtins, deduplicated', () => {
    expect(auditRuntimeDependencies('require("electron"); require("node:crypto"); require("fs"); require("node:crypto");'))
      .toEqual(['electron', 'fs', 'node:crypto']);
  });
  it.each(['ws', 'three', 'electron/not-a-submodule', 'node:not-a-builtin', './helper.cjs'])('rejects unbundled runtime dependency %s', specifier => {
    expect(() => auditRuntimeDependencies(`require(${JSON.stringify(specifier)})`, 'main.cjs')).toThrow('External runtime dependency');
  });
  it.each(['require(name)', 'require()', 'import(name)', 'const r = require; r("ws")', 'module.require("ws")', 'const r = module["require"]; r("ws")', 'loader.createRequire(import.meta.url)', 'eval("require(name)")', 'new Function("return require(name)")', 'createRequire(import.meta.url)'])('rejects unverifiable loader: %s', source => {
    expect(() => auditRuntimeDependencies(source)).toThrow(/Dynamic|Indirect|Aliased/);
  });
  it('checks static and dynamic imports without matching strings or comments', () => {
    expect(() => auditRuntimeDependencies('import("ws")')).toThrow('External runtime dependency');
    expect(auditRuntimeDependencies('// require("ws")\nconst documentation = "require(\\"ws\\")"; import("node:path");'))
      .toEqual(['node:path']);
  });
  it('applies the package exclusion to electron-builder dependency copying', () => {
    const root = resolve(import.meta.dirname, '..');
    const config = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).build;
    expect(config.files).toContain('!node_modules/**/*');
    // Use the installed builder implementation: its dependency collector has a
    // separate matcher from ordinary app files, so a glob-only test is insufficient.
    const require = createRequire(import.meta.url);
    const { getNodeModuleFileMatcher, FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
    const matcher = getNodeModuleFileMatcher(root, '/unused-package', (value: string) => value, {}, { config, debugLogger: { isEnabled: false } });
    const source = resolve(root, 'node_modules/three');
    const filter = new FileMatcher(source, '/unused-package/node_modules/three', (value: string) => value, matcher.patterns).createFilter();
    const path = resolve(source, 'package.json');
    const stat = Object.assign(lstatSync(path), { moduleName: 'three', moduleRootPath: 'node_modules/three', moduleFullFilePath: 'node_modules/three/package.json' });
    expect(filter(path, stat)).toBe(false);
  });
});
