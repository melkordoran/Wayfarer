/** Original, independently authored CC0 mathematical fixtures. No geometry,
 * animation values, or source code are copied from Microsoft or ActiveWorlds.
 * They exercise the explicitly selected Microsoft-X quaternion encoding profile,
 * not a claim about the unavailable historical AW Blender exporter/runtime.
 */
export interface OriginalAnimationKey {
  tick: number;
  values: readonly number[];
}

const s = Math.SQRT1_2;

/** Physical rotations are Rx(+90 degrees) then Ry(+90 degrees). X quaternion
 * records are WXYZ with vector signs opposite Three's matching matrix rotation.
 * Matrices below are handwritten source-row-vector transforms, not derived by
 * the application parser/adapter or by its quaternion conversion routine.
 */
export const directXReferenceOracle = {
  target: 'aw_elbow_l',
  canonicalJoint: 'lfelbow',
  ticksPerSecond: 30,
  rotationKeys: [
    { tick: 0, values: [s, -s, 0, 0] },
    { tick: 30, values: [s, 0, -s, 0] },
  ] satisfies OriginalAnimationKey[],
  translationKeys: [
    { tick: 0, values: [3, 5, 7] },
    { tick: 30, values: [5, 8, 11] },
  ] satisfies OriginalAnimationKey[],
  matrixKeys: [
    { tick: 0, values: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 3, 5, 7, 1] },
    { tick: 30, values: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 8, 11, 1] },
  ] satisfies OriginalAnimationKey[],
  durationMs: 1000,
  // XYZW, Hamilton multiplication as used by Three.js.
  firstThreeQuaternion: [s, 0, 0, s],
  lastThreeQuaternion: [0, s, 0, s],
  relativeThreeQuaternion: [-0.5, 0.5, -0.5, 0.5],
  reversedOrderThreeQuaternion: [-0.5, 0.5, 0.5, 0.5],
  translationDelta: [2, 3, 4],
  testPoint: [1, 2, 3],
  expectedLastRotatedPoint: [3, 2, -1],
  wrongOrderRotatedPoint: [-2, 1, 3],
  // Separately chosen geometry bind position; reference conversion must not
  // overwrite it with the first translation found in the animation file.
  geometryBindPosition: [1, 2, 3],
  expectedLastRetargetedPoint: [6, 7, 6],
} as const;

function keyBlock(type: number, keys: readonly OriginalAnimationKey[]): string {
  return `    AnimationKey {\r\n      ${type};\r\n      ${keys.length};\r\n${keys.map((key, index) =>
    `      ${key.tick};${key.values.length};${key.values.join(',')};;${index === keys.length - 1 ? ';' : ','}`,
  ).join('\r\n')}\r\n    }`;
}

function animationFile(blocks: readonly string[]): string {
  return `xof 0303txt 0032\r\nAnimationSet OriginalReferenceOracle {\r\n  AnimTicksPerSecond { 30; }\r\n  Animation {\r\n    { aw_elbow_l }\r\n    AnimationOptions { 1; 1; }\r\n${blocks.join('\r\n')}\r\n  }\r\n}\r\n`;
}

export const directXQuaternionReferenceText = animationFile([
  keyBlock(0, directXReferenceOracle.rotationKeys),
  keyBlock(2, directXReferenceOracle.translationKeys),
]);

/** Type 3 is the published AW/Microsoft template documentation value; type 4
 * occurs in Microsoft's own DirectX SDK animation exports. Their equivalence
 * here is explicit Wayfarer interoperability policy, not retail AW evidence.
 */
export function directXMatrixReferenceText(type: 3 | 4): string {
  return animationFile([keyBlock(type, directXReferenceOracle.matrixKeys)]);
}
