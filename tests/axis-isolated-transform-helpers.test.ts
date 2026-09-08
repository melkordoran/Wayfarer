import { describe, expect, it } from 'vitest';
import type { WorldObject } from '../src/shared/types';
import { exactOwnedTransformDelete, sameTestCanonicalObject, testAxisQuaternion, testCanonicalObject, testLocalWorldDelta,
  testPropertyQuaternion, testQuaternionMultiply, testRotateVector, testSelectionCentre, testTransformedPosition } from '../scripts/axis-isolated-transform-helpers';

const object: WorldObject = { id: 401, owner: 7, model: 'column.rwx', description: 'Original test', action: 'create rotate 0 12 0',
  x: 8.23456, y: .125, z: -20.34567, yaw: .45678, pitch: -.23456, roll: .34567, type: 0, data: 'AQID' };
const close = (actual: readonly number[], expected: readonly number[]) => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));

describe('independent isolated transform oracle', () => {
  it('fixes handedness with original quarter-turn and noncommuting witnesses', () => {
    close(testRotateVector([0, 1, 0], testAxisQuaternion('X', Math.PI / 2)), [0, 0, 1]);
    close(testRotateVector([0, 0, 1], testAxisQuaternion('Y', Math.PI / 2)), [1, 0, 0]);
    const x = testAxisQuaternion('X', Math.PI / 2), y = testAxisQuaternion('Y', Math.PI / 2);
    close(testQuaternionMultiply(y, x), [.5, .5, -.5, .5]);
    close(testQuaternionMultiply(x, y), [.5, .5, .5, .5]);
  });
  it('uses YXZ authored properties and local-to-world conjugation, not a rendered action rotation', () => {
    const primary = { ...object, pitch: Math.PI / 2, yaw: Math.PI / 2, roll: 0 };
    close(testPropertyQuaternion(primary), [.5, .5, -.5, .5]);
    close(testRotateVector([1, 0, 0], testPropertyQuaternion(primary)), [0, 0, -1]);
    const delta = testLocalWorldDelta(primary, 'X', Math.PI / 2);
    close(testRotateVector([1, 0, 0], delta), [0, -1, 0]);
    close(testRotateVector([0, 1, 0], delta), [1, 0, 0]);
  });
  it('rotates two origins about a nonzero shared centroid without changing their distance', () => {
    const a = { ...object, x: 3, y: 4, z: 5 }, b = { ...object, id: 402, x: 5, y: 4, z: 5 };
    const centre = testSelectionCentre([a, b]); close(centre, [4, 4, 5]);
    close(testTransformedPosition(a, centre, [7, 8, 9], testAxisQuaternion('Z', Math.PI / 2)), [7, 7, 9]);
    close(testTransformedPosition(b, centre, [7, 8, 9], testAxisQuaternion('Z', Math.PI / 2)), [7, 9, 9]);
  });
  it('predicts centimetres, signed cell floors, tenth-degree rotations and defaults', () => {
    const canonical = testCanonicalObject(object, 501, 8);
    expect(canonical).toMatchObject({ id: 501, owner: 8, x: 8.23, y: .13, z: -20.35, cellX: 0, cellZ: -3, action: object.action, data: 'AQID' });
    close([canonical.yaw, canonical.pitch, canonical.roll].map(value => value * 1800 / Math.PI), [262, -134, 198]);
  });
  it('rejects a nonunit quaternion, nonfinite position and duplicate selection', () => {
    expect(() => testRotateVector([1, 0, 0], [0, 0, 0, 0])).toThrow();
    expect(() => testRotateVector([NaN, 0, 0], [0, 0, 0, 1])).toThrow();
    expect(() => testSelectionCentre([object, object])).toThrow();
  });
});

describe('exact disposable transform cleanup', () => {
  const known = testCanonicalObject(object);
  const base = { initialIds: new Set([1, 2]), known, current: { ...known }, observer: { ...known }, uncertain: false };
  it('returns a copy only for a fresh exact canonical result witnessed by both clients', () => {
    const result = exactOwnedTransformDelete(base); expect(result).toEqual(known); expect(result).not.toBe(known);
    expect(sameTestCanonicalObject({ ...known }, known)).toBe(true);
  });
  it.each(['x', 'owner', 'action', 'description', 'data', 'cellX'] as const)('refuses changed %s even when the object ID matches', key => {
    const changed = { ...known, [key]: typeof known[key] === 'number' ? Number(known[key]) + 1 : `${known[key]}x` } as WorldObject;
    expect(exactOwnedTransformDelete({ ...base, current: changed })).toBeNull();
    expect(exactOwnedTransformDelete({ ...base, observer: changed })).toBeNull();
  });
  it('refuses seeded identities, uncertain outcomes, missing snapshots and invalid IDs', () => {
    expect(exactOwnedTransformDelete({ ...base, initialIds: new Set([known.id]) })).toBeNull();
    expect(exactOwnedTransformDelete({ ...base, uncertain: true })).toBeNull();
    expect(exactOwnedTransformDelete({ ...base, current: undefined })).toBeNull();
    expect(exactOwnedTransformDelete({ ...base, observer: undefined })).toBeNull();
    expect(exactOwnedTransformDelete({ ...base, known: { ...known, id: 0 } })).toBeNull();
  });
  it('does not ignore an extra or missing canonical field', () => {
    const { data: _data, ...missing } = known;
    expect(sameTestCanonicalObject(known, missing)).toBe(false);
    expect(sameTestCanonicalObject({ ...known, extra: 'unexpected' } as WorldObject, known)).toBe(false);
  });
});
