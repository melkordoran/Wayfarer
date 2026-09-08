import type { WorldObject } from '../src/shared/types';

/** Independent, import-pure smoke-test oracle. No Three or production transform
 * implementation is used here. Tuples are XYZ vectors and XYZW quaternions. */
export type TestVector = readonly [number, number, number];
export type TestQuaternion = readonly [number, number, number, number];
export function testQuaternionMultiply(a: TestQuaternion, b: TestQuaternion): TestQuaternion {
  const [x, y, z, w] = a, [u, v, t, s] = b;
  return [w * u + x * s + y * t - z * v, w * v - x * t + y * s + z * u,
    w * t + x * v - y * u + z * s, w * s - x * u - y * v - z * t];
}
export const testQuaternionConjugate = ([x, y, z, w]: TestQuaternion): TestQuaternion => [-x, -y, -z, w];
export function testAxisQuaternion(axis: 'X' | 'Y' | 'Z', angle: number): TestQuaternion {
  if (!Number.isFinite(angle)) throw new Error('Invalid oracle angle');
  const s = Math.sin(angle / 2), c = Math.cos(angle / 2);
  return [axis === 'X' ? s : 0, axis === 'Y' ? s : 0, axis === 'Z' ? s : 0, c];
}
export function testPropertyQuaternion(object: Pick<WorldObject, 'pitch' | 'yaw' | 'roll'>): TestQuaternion {
  return testQuaternionMultiply(testQuaternionMultiply(testAxisQuaternion('Y', object.yaw), testAxisQuaternion('X', object.pitch)), testAxisQuaternion('Z', object.roll));
}
export function testRotateVector(vector: TestVector, quaternion: TestQuaternion): TestVector {
  const length = Math.hypot(...quaternion);
  if (!vector.every(Number.isFinite) || !Number.isFinite(length) || Math.abs(length - 1) > 1e-10) throw new Error('Oracle requires a finite vector and unit quaternion');
  const rotated = testQuaternionMultiply(testQuaternionMultiply(quaternion, [...vector, 0]), testQuaternionConjugate(quaternion));
  return [rotated[0], rotated[1], rotated[2]];
}
export function testLocalWorldDelta(primary: WorldObject, axis: 'X' | 'Y' | 'Z', angle: number): TestQuaternion {
  const q = testPropertyQuaternion(primary);
  return testQuaternionMultiply(testQuaternionMultiply(q, testAxisQuaternion(axis, angle)), testQuaternionConjugate(q));
}
export function testSelectionCentre(objects: readonly WorldObject[]): TestVector {
  if (!objects.length || objects.length > 256 || new Set(objects.map(object => object.id)).size !== objects.length) throw new Error('Invalid oracle selection');
  const centre: [number, number, number] = [0, 0, 0];
  for (const object of objects) {
    if (![object.x, object.y, object.z].every(Number.isFinite)) throw new Error('Invalid oracle position');
    centre[0] += object.x / objects.length; centre[1] += object.y / objects.length; centre[2] += object.z / objects.length;
  }
  return centre;
}
export function testTransformedPosition(object: WorldObject, centre: TestVector, destination: TestVector, delta: TestQuaternion): TestVector {
  const rotated = testRotateVector([object.x - centre[0], object.y - centre[1], object.z - centre[2]], delta);
  return [rotated[0] + destination[0], rotated[1] + destination[1], rotated[2] + destination[2]];
}
/** Axis i32 fields use nearest integer centimetres and nearest tenth-degree
 * angles. This predicts the wire result, independently of the codec decoder. */
export function testCanonicalObject(requested: WorldObject, id = requested.id, owner = requested.owner): WorldObject {
  const centimetres = (value: number) => Math.round(value * 100) / 100;
  const angle = (value: number) => Math.round(value * 1800 / Math.PI) * Math.PI / 1800;
  const x = centimetres(requested.x), z = centimetres(requested.z);
  return { ...requested, id, owner, x, y: centimetres(requested.y), z,
    yaw: angle(requested.yaw), pitch: angle(requested.pitch), roll: angle(requested.roll),
    type: requested.type ?? 0, data: requested.data ?? '', cellX: Math.floor(x / 10), cellZ: Math.floor(z / 10) };
}
/** Canonical property records are flat. Include all metadata and cell fields;
 * do not treat two editable transforms alone as equivalent ownership. */
export function sameTestCanonicalObject(a: WorldObject | undefined, b: WorldObject | undefined): boolean {
  if (!a || !b) return false;
  const keys = Object.keys(a) as Array<keyof WorldObject>;
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}
export function exactOwnedTransformDelete(input: {
  initialIds: ReadonlySet<number>; known: WorldObject; current: WorldObject | undefined;
  observer: WorldObject | undefined; uncertain: boolean;
}): WorldObject | null {
  const { initialIds, known, current, observer, uncertain } = input;
  if (uncertain || !Number.isSafeInteger(known.id) || known.id <= 0 || initialIds.has(known.id)
    || !sameTestCanonicalObject(current, known) || !sameTestCanonicalObject(observer, known)) return null;
  return { ...known };
}
