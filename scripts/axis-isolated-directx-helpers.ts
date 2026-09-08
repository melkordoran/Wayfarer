import assert from "node:assert/strict";
import { Box3, Mesh, Quaternion, SkinnedMesh, Vector3 } from "three";
import { createDirectXInstance } from "../src/renderer/engine/directx-mesh";
import type { DirectXModel } from "../src/renderer/engine/directx";
import {
  directXJointName,
  sampleAvatarSequence,
  type AvatarSequence,
} from "../src/renderer/engine/avatar-assets";
import { directXFixtureExpectations } from "./directx-fixture-assets.mjs";
import type { WorldObject } from "../src/shared/types";

/** Numeric fixture check, not a screenshot or GPU/shader assertion. */
export function verifyOriginalDirectXModel(
  model: DirectXModel,
  kind: "static" | "avatar",
) {
  const expected = directXFixtureExpectations();
  const instance = createDirectXInstance(
    model,
    kind === "avatar" ? { jointName: directXJointName } : {},
  );
  try {
    const meshes: Mesh[] = [];
    instance.root.traverse((node) => {
      if (node instanceof Mesh) meshes.push(node);
    });
    assert.equal(meshes.length, 1);
    if (kind === "static") {
      const box = new Box3().setFromObject(instance.root);
      assert(
        box.min.distanceTo(new Vector3(...expected.static.bounds.min)) < 1e-5,
      );
      assert(
        box.max.distanceTo(new Vector3(...expected.static.bounds.max)) < 1e-5,
      );
      assert.equal(
        meshes[0].geometry.getAttribute("position").count,
        15,
        "Concave six-corner face plus one triangle must produce five triangles",
      );
    } else {
      assert.equal(instance.joints.size, 16);
      const mesh = meshes[0];
      assert(mesh instanceof SkinnedMesh);
      const positions = mesh.geometry.getAttribute("position");
      const inspect = (
        witness: typeof expected.skinned.elbowWitness,
        rotated: boolean,
      ) => {
        const source = new Vector3(...expected.skinned.vertices[witness.index]);
        let index = -1;
        for (let i = 0; i < positions.count; i++)
          if (
            new Vector3().fromBufferAttribute(positions, i).distanceTo(source) <
            1e-5
          ) {
            index = i;
            break;
          }
        assert(
          index >= 0,
          "Authored weighted witness missing from constructed mesh",
        );
        const actual = mesh.localToWorld(
          mesh.getVertexPosition(index, new Vector3()),
        );
        assert(
          actual.distanceTo(
            new Vector3(...(rotated ? witness.rotated90Z : witness.bind)),
          ) < 1e-5,
          "Authored bind or weighted pose witness changed",
        );
      };
      for (const witness of [
        expected.skinned.elbowWitness,
        expected.skinned.blendedWitness,
      ])
        inspect(witness, false);
      instance.applyPose(
        new Map([
          [
            "lfelbow",
            {
              rotation: new Quaternion().setFromAxisAngle(
                new Vector3(0, 0, 1),
                Math.PI / 2,
              ),
              translation: new Vector3(),
            },
          ],
        ]),
      );
      for (const witness of [
        expected.skinned.elbowWitness,
        expected.skinned.blendedWitness,
      ])
        inspect(witness, true);
      instance.applyPose(new Map());
      for (const witness of [
        expected.skinned.elbowWitness,
        expected.skinned.blendedWitness,
      ])
        inspect(witness, false);
    }
    return {
      frames: model.frames.length,
      meshes: meshes.length,
      joints: instance.joints.size,
      outputVertices: meshes[0].geometry.getAttribute("position").count,
      warnings: [...instance.warnings],
    };
  } finally {
    instance.dispose();
  }
}
export function verifyOriginalDirectXWave(
  model: DirectXModel,
  wave: AvatarSequence,
) {
  const instance = createDirectXInstance(model, {
    jointName: directXJointName,
  });
  try {
    const shoulder = instance.joints.get("lfshoulder");
    assert(shoulder);
    instance.applyPose(sampleAvatarSequence(wave, 1000, { rootMotion: false }));
    assert(shoulder.group.quaternion.angleTo(shoulder.bindRotation) > 2);
    instance.applyPose(new Map());
    assert(shoulder.group.quaternion.angleTo(shoulder.bindRotation) < 1e-8);
  } finally {
    instance.dispose();
  }
}

/** Actual decoded external X clip -> independent instance skin/pose checks.
 * The diagnostic geometry has a translated Y90 root; these world-space values
 * are authored oracles, not values recomputed by the production X loader. */
export function verifyOriginalDirectXSalute(model: DirectXModel, sequence: AvatarSequence) {
  assert.equal(sequence.format, 'directx');
  assert.equal(sequence.durationMs, 4000);
  const a = createDirectXInstance(model, { jointName: directXJointName });
  const b = createDirectXInstance(model, { jointName: directXJointName });
  try {
    let mesh: SkinnedMesh | undefined;
    a.root.traverse(node => { if (node instanceof SkinnedMesh) mesh = node; });
    assert(mesh);
    const source = new Vector3(.32, .9, .07), positions = mesh.geometry.getAttribute('position');
    let vertex = -1;
    for (let index = 0; index < positions.count; index++)
      if (new Vector3().fromBufferAttribute(positions, index).distanceTo(source) < 1e-6) { vertex = index; break; }
    assert(vertex >= 0, 'Original skin witness missing');
    const point = () => mesh!.localToWorld(mesh!.getVertexPosition(vertex, new Vector3()));
    const rest = point();
    assert(rest.distanceTo(new Vector3(.32, .9, .18)) < 1e-6);
    a.applyPose(sampleAvatarSequence(sequence, 1000, { rootMotion: false }));
    const weighted = point();
    assert(weighted.distanceTo(new Vector3(.32, 1.12, .1)) < 1e-6, 'External X weighted-skin witness differs');
    a.applyPose(sampleAvatarSequence(sequence, 1900, { rootMotion: false }));
    for (const [joint, degrees] of [['lfshoulder', 90], ['lfelbow', 135], ['head', 8]] as const) {
      const actual = a.joints.get(joint)!, neutral = b.joints.get(joint)!;
      assert(Math.abs(actual.group.quaternion.angleTo(actual.bindRotation) - degrees * Math.PI / 180) < 1e-6);
      assert(neutral.group.quaternion.angleTo(neutral.bindRotation) < 1e-8, 'Separate avatar pose leaked');
    }
    a.applyPose(sampleAvatarSequence(sequence, 4000, { rootMotion: false }));
    assert(point().distanceTo(rest) < 1e-6);
    for (const joint of a.joints.values()) {
      assert(joint.group.quaternion.angleTo(joint.bindRotation) < 1e-8);
      assert(joint.group.position.distanceTo(joint.bindPosition) < 1e-8);
    }
    return { format: sequence.format, durationMs: sequence.durationMs, weightedPointAt1000ms: weighted.toArray(), independentNeutral: true, finalNeutral: true, warnings: sequence.warnings };
  } finally { a.dispose(); b.dispose(); }
}
/** Only a known canonical ID with the exact last owned state may be deleted. */
export function exactOwnedDirectXObject(
  current: WorldObject | undefined,
  owned: WorldObject,
): boolean {
  return !!current && JSON.stringify(current) === JSON.stringify(owned);
}
