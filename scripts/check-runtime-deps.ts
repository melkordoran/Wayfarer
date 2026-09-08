/** Build-time guard for an entirely bundled desktop app. Not shipped at runtime.
 * A new external dependency must be bundled or explicitly packaged; do not remove
 * this check merely to make a require() failure disappear from the build.
 */
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

type AstNode = { type: string; start: number; [key: string]: unknown };
const asNode = (value: unknown): AstNode | undefined => value && typeof value === 'object' && 'type' in value && typeof value.type === 'string' ? value as AstNode : undefined;

export function auditRuntimeDependencies(source: string, file = 'bundle.cjs'): string[] {
  const parsed = parseAst(source, undefined, file);
  const dependencies = new Set<string>(), errors: string[] = [];
  const fail = (node: AstNode, message: string) => {
    const before = source.slice(0, node.start).split('\n');
    errors.push(`${file}:${before.length}:${before.at(-1)!.length + 1}: ${message}`);
  };
  const inspect = (node: AstNode, argument: AstNode | undefined) => {
    if (!argument || argument.type !== 'Literal' || typeof argument.value !== 'string') {
      fail(node, 'Dynamic module loading cannot be verified; node_modules is excluded from the desktop package.'); return;
    }
    const specifier = argument.value;
    if (specifier !== 'electron' && !isBuiltin(specifier)) {
      fail(node, `External runtime dependency ${JSON.stringify(specifier)} is not bundled. Bundle it or explicitly revise packaging and this guard.`);
    } else dependencies.add(specifier);
  };
  const visit = (node: AstNode, parent?: AstNode) => {
    if (node.type === 'MemberExpression') {
      const property = asNode(node.property);
      if (['require', 'createRequire'].includes(String(property?.name ?? property?.value))) {
        fail(node, 'Indirect module loader is unsupported by the bundled-runtime guard.');
      }
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = asNode(node.callee), property = asNode(callee?.property);
      if (callee?.type === 'Identifier' && ['require', '__require'].includes(String(callee.name))) {
        inspect(node, asNode(Array.isArray(node.arguments) ? node.arguments[0] : undefined));
      } else if (callee?.type === 'MemberExpression' && (property?.name === 'require' || property?.value === 'require')) {
        // module.require can be aliased or monkey-patched. Keep the supported
        // esbuild output contract narrow instead of silently trusting an alias.
        fail(node, 'Indirect module.require is unsupported by the bundled-runtime guard.');
      } else if (callee?.type === 'Identifier' && ['createRequire', 'eval', 'Function'].includes(String(callee.name))) {
        fail(node, 'Dynamic loader/code construction is unsupported by the bundled-runtime guard.');
      }
    } else if (['ImportExpression', 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      inspect(node, asNode(node.source));
    }
    // A require alias could hide a dependency from direct-call checks.
    if (node.type === 'Identifier' && ['require', '__require', 'createRequire'].includes(String(node.name))) {
      const directCall = parent?.type === 'CallExpression' && parent.callee === node;
      const propertyName = parent?.type === 'MemberExpression' && parent.property === node;
      if (!directCall && !propertyName) fail(node, 'Aliased module loader is unsupported by the bundled-runtime guard.');
    }
    for (const value of Object.values(node)) {
      const child = asNode(value); if (child) visit(child, node);
      else if (Array.isArray(value)) for (const item of value) { const child = asNode(item); if (child) visit(child, node); }
    }
  };
  visit(parsed as unknown as AstNode);
  if (errors.length) throw new Error(errors.join('\n'));
  return [...dependencies].sort();
}

export function verifyRuntimeBundles(root: string) {
  const reports = ['main.cjs', 'preload.cjs'].map(name => {
    const path = join(root, 'dist-electron', name);
    let source: string;
    try { source = readFileSync(path, 'utf8'); }
    catch { throw new Error(`Missing desktop bundle ${path}; run npm run build:desktop first.`); }
    return { file: name, dependencies: auditRuntimeDependencies(source, path) };
  });
  return { passed: true, policy: 'Electron and Node builtins only; no external runtime node_modules', bundles: reports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(verifyRuntimeBundles(resolve(import.meta.dirname, '..')), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
