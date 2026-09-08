import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRwx, RWX_PARSE_LIMITS } from '../src/renderer/engine/rwx';
import { ModelPreviewSession } from '../src/renderer/engine/model-preview';

const triangle = 'Vertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\nTriangle 1 2 3';
const assets = new URL('../public/assets/', import.meta.url);
const fixtures = ['models', 'avatars'].flatMap(folder => readdirSync(new URL(`${folder}/`, assets)).filter(name => name.endsWith('.rwx')).map(name => `${folder}/${name}`));

describe('RWX source and execution budgets', () => {
  it('rejects a flat no-geometry model before allocating or executing beyond its source budget', () => {
    expect(() => parseRwx('Identity\n'.repeat(51), 10, { maxCommands: 50 })).toThrow('source command budget (50)');
    expect(parseRwx('Identity\n'.repeat(50), 10, { maxCommands: 50 }).parts).toEqual([]);
  });
  it('charges executed commands across repeated instances, not only source lines or emitted faces', () => {
    const source = `ProtoBegin part\n${triangle}\nProtoEnd\n${'ProtoInstance part\n'.repeat(10)}`;
    expect(source.trim().split('\n').length).toBeLessThan(40);
    expect(() => parseRwx(source, 10, { maxCommands: 40 })).toThrow('execution command budget (40)');
    expect(parseRwx(source, 10, { maxCommands: 50 }).parts[0].positions).toHaveLength(90);
  });
  it('bounds compact exponentially branching empty prototypes before geometry checks', () => {
    // Only 2^10 leaves if the guard regresses: adversarial shape without running
    // an actual unbounded expansion in the test process.
    let source = 'ProtoBegin p0\nProtoEnd\n';
    for (let depth = 1; depth <= 10; depth++) source += `ProtoBegin p${depth}\nProtoInstance p${depth - 1}\nProtoInstance p${depth - 1}\nProtoEnd\n`;
    source += 'ProtoInstance p10';
    expect(source.length).toBeLessThan(1024);
    expect(() => parseRwx(source, 10, { maxCommands: 4096, maxPrototypeExpansions: 32 })).toThrow('prototype expansion budget (32)');
  });
  it('counts empty and unknown prototype invocations globally, including siblings', () => {
    const source = `ProtoBegin empty\nProtoEnd\n${'ProtoInstance empty\n'.repeat(3)}`;
    expect(() => parseRwx(source, 10, { maxPrototypeExpansions: 2 })).toThrow('prototype expansion budget (2)');
    expect(parseRwx(source, 10, { maxPrototypeExpansions: 3 }).parts).toEqual([]);
    expect(() => parseRwx('ProtoInstance missing\nProtoInstance missing', 10, { maxPrototypeExpansions: 1 })).toThrow('prototype expansion budget (1)');
  });
  it('counts never-instantiated prototype source while ignoring comments and blank lines', () => {
    expect(() => parseRwx(`ProtoBegin unused\n${'Identity\n'.repeat(50)}ProtoEnd`, 10, { maxCommands: 50 })).toThrow('source command budget (50)');
    expect(parseRwx(`# Comment\r\n\r\n${triangle}\n# Comment`, 1, { maxCommands: 4 }).parts[0].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
  it('bounds scope-stack allocations independently of the command budget', () => {
    expect(() => parseRwx('TransformBegin\n'.repeat(RWX_PARSE_LIMITS.maxScopeDepth + 1))).toThrow('scope depth budget (1024)');
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid or bypassing budget overrides: %s', value => {
    expect(() => parseRwx('', 10, { maxCommands: value })).toThrow('Invalid RWX command budget');
    expect(() => parseRwx('', 10, { maxPrototypeExpansions: value })).toThrow('Invalid RWX prototype expansion budget');
  });
  it('preserves hard ceilings and the existing generic unitScale argument', () => {
    expect(RWX_PARSE_LIMITS.maxCommands).toBe(2_000_000);
    expect(RWX_PARSE_LIMITS.maxPrototypeExpansions).toBe(100_000);
    expect(() => parseRwx('', 10, { maxCommands: RWX_PARSE_LIMITS.maxCommands + 1 })).toThrow();
    expect(() => parseRwx('', 10, { maxPrototypeExpansions: RWX_PARSE_LIMITS.maxPrototypeExpansions + 1 })).toThrow();
    expect(parseRwx(triangle, 1).parts[0].positions[3]).toBe(1);
    expect(parseRwx(triangle).parts[0].positions[3]).toBe(10);
  });
  it.each(fixtures)('leaves original fixture %s unchanged under the stricter preview limits', name => {
    const source = readFileSync(new URL(name, assets), 'utf8');
    const expected = parseRwx(source);
    expect(expected.parts.length).toBeGreaterThan(0);
    expect(parseRwx(source, 10, { maxCommands: 250_000, maxPrototypeExpansions: 10_000 })).toEqual(expected);
  });
  it('enforces the lower preview budget during parsing, before post-parse geometry limits', async () => {
    const source = 'Identity\n'.repeat(250_001);
    const session = new ModelPreviewSession(async () => ({ bytes: new TextEncoder().encode(source), contentType: 'text/plain' }), 'https://example.test/objects/');
    try { await expect(session.load('adversarial.rwx')).rejects.toThrow('source command budget (250000)'); }
    finally { session.dispose(); }
  });
});
