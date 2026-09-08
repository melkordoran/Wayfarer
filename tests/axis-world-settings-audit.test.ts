import { describe, expect, it } from 'vitest';
import { decodeWorldAttributeFile, persistedWorldSetting } from '../scripts/axis-world-settings-audit';
const entry = (name: string, type: number, bytes: number[]) => [name.length, ...Buffer.from(name), type, bytes.length, ...bytes];
describe('independent attributes.dat read-only oracle', () => {
  it('reads named typed values without mutating source', () => {
    const input = Uint8Array.from([1, ...entry('Title', 4, [65]), ...entry('WaterLevel', 3, [0, 0, 192, 63])]), before = input.slice();
    const result = decodeWorldAttributeFile(input); expect([...result.keys()]).toEqual(['Title', 'WaterLevel']);
    expect(persistedWorldSetting(result.get('Title')!, 'text')).toBe('A'); expect(persistedWorldSetting(result.get('WaterLevel')!, 'float')).toBe('1.5');
    result.get('Title')!.value[0] = 66; expect(input).toEqual(before);
  });
  it('decodes Boolean, signed integer, and binary32 storage independently', () => {
    expect(persistedWorldSetting({ type: 1, value: Uint8Array.of(48) }, 'boolean')).toBe('N');
    expect(persistedWorldSetting({ type: 1, value: Uint8Array.of(49) }, 'boolean')).toBe('Y');
    expect(persistedWorldSetting({ type: 2, value: Uint8Array.of(255, 255, 255, 255) }, 'integer')).toBe('-1');
    const bytes = Buffer.alloc(4); bytes.writeFloatLE(0.1); expect(persistedWorldSetting({ type: 3, value: bytes }, 'float')).toBe(String(Math.fround(0.1)));
  });
  it('also copies Buffer input values, whose slice method would otherwise alias', () => {
    const input = Buffer.from([1, ...entry('Title', 4, [65])]), saved = Buffer.from(input);
    decodeWorldAttributeFile(input).get('Title')!.value[0] = 66; expect(input).toEqual(saved);
  });
  it.each([[], [0], [2], [128, 0], [255, 255, 255, 255, 127], [1, 10, 65], [1, ...entry('Title', 0, [])], [1, ...entry('Title', 4, [65]), ...entry('Title', 4, [66])], [1, ...entry('../x', 4, [])], [1, ...entry('A', 4, []), 1, 66, 4, 3, 65]].map(bytes => ({ bytes })))('refuses malformed/truncated/duplicate file %#', ({ bytes }) => expect(() => decodeWorldAttributeFile(Uint8Array.from(bytes))).toThrow());
  it('bounds input and rejects malformed UTF-8 names', () => {
    expect(() => decodeWorldAttributeFile(new Uint8Array(1_000_001))).toThrow();
    expect(() => decodeWorldAttributeFile(Uint8Array.from([1, 1, 255, 4, 0]))).toThrow();
  });
  it.each([
    ['boolean', 1, [89]], ['boolean', 4, [49]], ['float', 2, [0, 0, 0, 0]], ['integer', 3, [0, 0, 0, 0]], ['float', 3, [0, 0, 128, 127]],
    ['integer', 2, [0]], ['text', 4, [255]], ['asset', 5, [0]],
  ] as const)('rejects mismatched persistence type/shape %#', (kind, type, bytes) => expect(() => persistedWorldSetting({ type, value: Uint8Array.from(bytes) }, kind)).toThrow());
});
