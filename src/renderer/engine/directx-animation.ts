import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseDirectX, type DirectXAnimation, type DirectXModel } from './directx';
import type { AvatarSequence, JointSequence } from './avatar-assets';
import { decompressDirectX } from './directx-compression';

const MAX_DURATION_MS = 86_400_000;
const fail = (message: string): never => { throw new Error(`DirectX animation: ${message}`); };
const closeScale = (a: number, b: number) => Math.abs(a - b) <= 1e-5 * Math.max(1e-12, Math.abs(a), Math.abs(b));

/** Microsoft X quaternion records are WXYZ, with conjugated vector components
 * relative to the equivalent source-row-vector matrix. This is an encoding
 * convention, not a guessed change of world handedness. See the original
 * independent paired oracles and docs/directx-animation-research.md. */
function quaternion(values: number[]): Quaternion {
  const [w, x, y, z] = values;
  const result = new Quaternion(-x, -y, -z, w);
  if (result.lengthSq() < 1e-20) fail('rotation key has a zero quaternion');
  return result.normalize();
}

function transform(values: number[]): { rotation: Quaternion; position: Vector3; scale: Vector3 } {
  if (Math.abs(values[3]) > 1e-7 || Math.abs(values[7]) > 1e-7 || Math.abs(values[11]) > 1e-7 || Math.abs(values[15] - 1) > 1e-7) fail('matrix key must be affine');
  // Source row-major row-vector entries are already the corresponding Three
  // column-major column-vector entries. A second transpose would be wrong.
  const matrix = new Matrix4().fromArray(values), position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  const basis = [0, 4, 8].map(offset => new Vector3(values[offset], values[offset + 1], values[offset + 2]));
  if (basis.some(axis => axis.length() <= 1e-8)) fail('singular matrix animation is unsupported');
  const directions = basis.map(axis => axis.clone().normalize());
  if (Math.abs(directions[0].dot(directions[1])) > 1e-5 || Math.abs(directions[0].dot(directions[2])) > 1e-5 || Math.abs(directions[1].dot(directions[2])) > 1e-5) fail('sheared matrix animation is unsupported');
  matrix.decompose(position, rotation, scale);
  if (![...position.toArray(), ...rotation.toArray(), ...scale.toArray()].every(Number.isFinite) || scale.x <= 1e-8 || scale.y <= 1e-8 || scale.z <= 1e-8) fail('singular or reflected matrix animation is unsupported');
  const reconstructed = new Matrix4().compose(position, rotation, scale);
  if (values.slice(0, 12).some((value, index) => Math.abs(value - reconstructed.elements[index]) > 1e-5 * Math.max(1e-12, basis[Math.floor(index / 4)].length()))) fail('sheared matrix animation is unsupported');
  return { position, rotation: rotation.normalize(), scale };
}

function sameScale(first: Vector3, next: Vector3): boolean {
  return first.toArray().every((value, index) => closeScale(value, next.getComponent(index)));
}

function targetName(model: DirectXModel, target: DirectXAnimation['target']): string {
  const named = target.name ? model.frames.filter(frame => frame.name === target.name) : [];
  if (named.length > 1) fail('animation target name is ambiguous');
  if (target.uuid) {
    const frames = model.frames.filter(frame => frame.uuid === target.uuid);
    if (frames.length !== 1 || !frames[0].name) fail('animation target UUID is unresolved or ambiguous');
    if (target.name && frames[0].name !== target.name) fail('animation target name/UUID mismatch');
    return frames[0].name;
  }
  // A standalone catalog sequence may refer to joints supplied by its avatar
  // geometry, without declaring duplicate Frames in the sequence itself.
  return target.name ?? fail('animation target has no name');
}

/** The explicit AW-reference profile uses one AnimationSet, first-key-relative
 * local rotation/translation, 30 default ticks/s (2–200), and linear translation.
 * Geometry loading itself NEVER starts an embedded animation. Catalog-referenced
 * X files may contain geometry, but only their explicitly loaded set is sampled.
 * Scale changes, spline translation and generic retargeting are not approximated.
 */
export function parseDirectXSequence(bytes: Uint8Array, resolveJoint: (frameName: string) => string | undefined): AvatarSequence {
  if (bytes.length > 16_000_000) fail('sequence exceeds 16 MB');
  const model = parseDirectX(decompressDirectX(bytes, 16_000_000), { animations: true });
  const sets = model.animationSets ?? [];
  if (sets.length !== 1) fail('the AW-reference profile requires exactly one AnimationSet');
  const set = sets[0];
  if (!set.animations.length) fail('AnimationSet has no tracks');
  if (set.unsupported.length) fail(`unsupported animation-set template ${set.unsupported[0]}`);
  if (set.ticksPerSecond !== undefined && model.animationTicksPerSecond !== undefined) fail('ambiguous document and animation-set tick rates');
  const ticks = set.ticksPerSecond ?? model.animationTicksPerSecond ?? 30;
  if (ticks < 2 || ticks > 200) fail('ticks per second must be in the AW-profile range 2–200');
  const warnings = new Set(model.warnings);
  warnings.add('Experimental DirectX AW-reference playback: first-key-relative poses and one source unit per metre; historical AW exporter parity is not yet verified.');
  const sequence: AvatarSequence = { format: 'directx', rootJoint: 'pelvis', durationMs: 0, modelName: set.name, joints: [], warnings: [] };
  const targets = new Set<string>();
  const time = (tick: number) => {
    const value = tick * 1000 / ticks;
    if (value > MAX_DURATION_MS) fail('animation duration exceeds 24 hours');
    sequence.durationMs = Math.max(sequence.durationMs, value);
    return value;
  };
  for (const animation of set.animations) {
    if (animation.unsupported.length) fail(`unsupported animation-track template ${animation.unsupported[0]}`);
    const sourceName = targetName(model, animation.target), name = resolveJoint(sourceName);
    const blocks = new Map(animation.keys.map(block => [block.type, block]));
    const matrix = blocks.get(3) ?? blocks.get(4);
    if (matrix && blocks.size !== 1) fail('matrix keys cannot be mixed with rotation, scale or translation keys');
    if (animation.options?.positionQuality === 0 && (matrix || blocks.has(2))) fail('spline translation is unsupported; use linear AnimationOptions');
    if (animation.options) warnings.add('AnimationOptions open/closed timing is controlled by the selected one-shot or implicit-loop playback mode.');
    const joint: JointSequence = { name: name ?? sourceName, rotations: [] };
    let referenceScale: Vector3 | undefined;
    if (matrix) {
      const keys = matrix.keys.map(key => ({ timeMs: time(key.time), ...transform(key.values) }));
      const reference = keys[0], inverse = reference.rotation.clone().invert();
      referenceScale = reference.scale;
      if (keys.some(key => !sameScale(reference.scale, key.scale))) fail('changing matrix scale is unsupported');
      joint.rotations = keys.map(key => ({ timeMs: key.timeMs, rotation: inverse.clone().multiply(key.rotation).normalize() }));
      joint.translations = keys.map(key => ({ timeMs: key.timeMs, value: key.position.clone().sub(reference.position) }));
    } else {
      const rotations = blocks.get(0);
      if (rotations) {
        const referenceInverse = quaternion(rotations.keys[0].values).invert();
        joint.rotations = rotations.keys.map(key => ({ timeMs: time(key.time), rotation: referenceInverse.clone().multiply(quaternion(key.values)).normalize() }));
      }
      const positions = blocks.get(2);
      if (positions) {
        const reference = new Vector3().fromArray(positions.keys[0].values);
        joint.translations = positions.keys.map(key => ({ timeMs: time(key.time), value: new Vector3().fromArray(key.values).sub(reference) }));
      }
      const scales = blocks.get(1);
      if (scales) {
        referenceScale = new Vector3().fromArray(scales.keys[0].values);
        if (referenceScale.toArray().some(value => value <= 1e-8)) fail('zero or negative reference scale is unsupported');
        for (const key of scales.keys) {
          time(key.time);
          if (!sameScale(referenceScale, new Vector3().fromArray(key.values))) fail('changing scale keys are unsupported');
        }
      }
    }
    if (referenceScale && !sameScale(referenceScale, new Vector3(1, 1, 1))) warnings.add('Constant source reference scale is not reapplied; the selected avatar retains its own bind scale.');
    if (animation.keys.some(block => block.keys[0].time > 0)) warnings.add('A track starts after tick zero; its first reference pose is held until that time.');
    if (!name) {
      if (warnings.size < 64) warnings.add(`Unrecognized DirectX animation joint omitted: ${sourceName.slice(0, 80)}`);
      continue;
    }
    if (targets.has(name)) fail(`multiple tracks resolve to the same AW joint ${name}`);
    targets.add(name);
    // A scale-only block does not animate an AW joint; do not report a working
    // gesture merely because a recognized frame name occurs in the file.
    if (joint.rotations.length || joint.translations?.length) sequence.joints.push(joint);
  }
  if (!sequence.joints.length) fail('no supported motion tracks resolve to known AW joints');
  if (sequence.durationMs <= 0) fail('animation has no positive duration');
  sequence.warnings = [...warnings];
  return sequence;
}
