import { describe, expect, it } from 'vitest';
import { restrictFixtureMovement } from '../scripts/axis-isolated-attributes.mjs';

const field = (name: string, type = 1, bytes = [49]) => [...Buffer.from([name.length]), ...Buffer.from(name), type, bytes.length, ...bytes];
const original = () => Uint8Array.from([1, ...field('Other', 4, [97, 98]), ...field('AllowFlying'), ...field('AllowTeleport'), ...field('Last', 4, [99])]);
describe('isolated original movement-rule profile', () => {
  it('changes only two Boolean value bytes and never mutates the input', () => {
    const before = original(), saved = new Uint8Array(before), after = restrictFixtureMovement(before);
    expect(before).toEqual(saved); expect(after.length).toBe(before.length);
    const changed = [...after].flatMap((byte, index) => byte === before[index] ? [] : [[before[index], byte]]);
    expect(changed).toEqual([[49, 48], [49, 48]]);
  });
  it('refuses repeated application or already-modified rule values', () => {
    expect(() => restrictFixtureMovement(restrictFixtureMovement(original()))).toThrow('enabled Boolean');
  });
  it.each([0, 2, 127])('rejects unknown version %s', version => {
    const bytes = original(); bytes[0] = version; expect(() => restrictFixtureMovement(bytes)).toThrow('version');
  });
  it.each(['AllowFlying', 'AllowTeleport'])('requires exactly one %s field', name => {
    expect(() => restrictFixtureMovement(Uint8Array.from([1, ...field(name)]))).toThrow('missing');
    expect(() => restrictFixtureMovement(Uint8Array.from([...original(), ...field(name)]))).toThrow('one enabled');
  });
  it.each([[2, [49]], [1, []], [1, [1]], [1, [89]], [1, [49, 49]]])('rejects unexpected type/value shape %s/%j', (type, value) => {
    expect(() => restrictFixtureMovement(Uint8Array.from([1, ...field('AllowFlying', type as number, value as number[]), ...field('AllowTeleport')]))).toThrow();
  });
  it('rejects truncated names, values, oversized/noncanonical integers and large buffers', () => {
    for (const bytes of [[1, 255], [1, 10, 65], [1, ...field('AllowFlying'), 2, 65, 65, 4, 10, 1], [1, 128, 0], [1, 255, 255, 255, 255, 127]]) {
      expect(() => restrictFixtureMovement(Uint8Array.from(bytes))).toThrow();
    }
    expect(() => restrictFixtureMovement(new Uint8Array(1_000_001))).toThrow();
  });
});
