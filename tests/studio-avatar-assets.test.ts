import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Box3, Quaternion, SkinnedMesh, Vector3 } from 'three';
import bundled from '../src/renderer/engine/studio-avatar-data.json';
import directXBundle from '../src/renderer/engine/studio-directx-data.json';
import directXAnimationBundle from '../src/renderer/engine/studio-directx-animation-data.json';
import {
  applyAvatarPose, directXJointName, loadAvatarCatalog, loadAvatarModel, loadAvatarRwx, loadAvatarSequence, sampleAvatarSequence,
} from '../src/renderer/engine/avatar-assets';
import { createDirectXInstance } from '../src/renderer/engine/directx-mesh';
import { directXFixtureAssets, studioDirectXFixtureExpectations } from '../scripts/directx-fixture-assets.mjs';
import { parseDirectX } from '../src/renderer/engine/directx';
import { createRwxGroup, disposeModelTree } from '../src/renderer/engine/rwx-mesh';
import { fetchStudioAvatarAsset, STUDIO_AVATAR_PATH } from '../src/renderer/engine/studio-avatar-assets';

const project = resolve(import.meta.dirname, '..');
const generator = resolve(project, 'scripts/axis-avatar-assets.mjs');
const studioFile = resolve(project, 'src/renderer/engine/studio-avatar-data.json');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = new Quaternion();

describe('isolated original studio avatar bundle', () => {
  it.each(['UTC', 'America/Toronto'])('reproduces its 17 assets without writing in %s', TZ => {
    const before = { bytes: readFileSync(studioFile), mtime: statSync(studioFile).mtimeMs };
    const output = execFileSync(process.execPath, [generator, '--studio', '--check'], {
      encoding: 'utf8', env: { ...process.env, TZ },
    });
    expect(output).toContain('Verified: 17 original studio avatar bundled assets');
    expect(readFileSync(studioFile)).toEqual(before.bytes);
    expect(statSync(studioFile).mtimeMs).toBe(before.mtime);
    expect(Object.keys(bundled)).toHaveLength(17);
  });

  it('preserves the live Haven asset bytes and original Wave-only catalog', async () => {
    expect(execFileSync(process.execPath, [generator, '--check'], { encoding: 'utf8' }))
      .toContain('Verified: 15 original avatar fixture assets');
    const expected = {
      'avatars/avatars.dat': '33751a7a753d5ea20446b73df8abb86616a3b35b6cc18123cdfb581484e13539',
      'avatars/avatars.zip': '3e43ede3eeae8be6bae066270517b55a568865bfbb60180074fe131096a9b108',
      'seqs/wf-wave.seq': 'bcb68bfd505cb6050d8918f74b2538a580dfe63b0743fbf5a57088653df7279d',
    };
    for (const [name, digest] of Object.entries(expected))
      expect(hash(readFileSync(resolve(project, 'public/assets', name)))).toBe(digest);
    const live = readFileSync(resolve(project, 'public/assets/avatars/avatars.dat'), 'utf8');
    expect(live.match(/Wave=wf-wave/g)).toHaveLength(2);
    expect(live).not.toContain('wf-bow');
  });

  it('serves every exact bundled URL from memory without a network request', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    try {
      const assets = { ...bundled, ...directXBundle, ...directXAnimationBundle };
      expect(Object.keys(assets)).toHaveLength(33);
      for (const [name, encoded] of Object.entries(assets)) {
        const asset = await fetchStudioAvatarAsset(STUDIO_AVATAR_PATH + name);
        expect(Buffer.from(asset.bytes).toString('base64')).toBe(encoded);
        expect(asset.contentType).toBe(name.endsWith('.zip') ? 'application/zip'
          : name.endsWith('.seq') || name.endsWith('.x') ? 'application/octet-stream' : name.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8');
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('returns independent byte arrays and never exposes its cached buffers', async () => {
    const url = STUDIO_AVATAR_PATH + 'avatars/avatars.zip';
    const first = await fetchStudioAvatarAsset(url), second = await fetchStudioAvatarAsset(url);
    expect(first.bytes.buffer).not.toBe(second.bytes.buffer);
    const original = hash(second.bytes);
    first.bytes.fill(0);
    second.bytes[0] = 0;
    expect(hash((await fetchStudioAvatarAsset(url)).bytes)).toBe(original);
  });

  it.each([
    'https://example.invalid/avatars/avatars.zip',
    'http://studio.wayfarer.invalid/avatars/avatars.zip',
    'https://studio.wayfarer.invalid:443/avatars/avatars.zip',
    'https://user:password@studio.wayfarer.invalid/avatars/avatars.zip',
    'https://studio.wayfarer.invalid/avatars/avatars.zip?fresh=1',
    'https://studio.wayfarer.invalid/avatars/avatars.zip#fragment',
    'https://studio.wayfarer.invalid/avatars/../avatars/avatars.zip',
    'https://studio.wayfarer.invalid/avatars/%61vatars.zip',
    'https://studio.wayfarer.invalid/avatars/unknown.rwx',
    'file:///tmp/avatars/avatars.dat',
    '/avatars/avatars.zip',
    '__proto__',
  ])('refuses non-allowlisted URLs without a bridge fallback: %s', async url => {
    await expect(fetchStudioAvatarAsset(url)).rejects.toThrow('not part of the original studio');
  });

  it('contains a readable original-work license, not third-party avatar assets', async () => {
    const license = await fetchStudioAvatarAsset(STUDIO_AVATAR_PATH + 'avatars/LICENSE.txt');
    const text = new TextDecoder().decode(license.bytes);
    expect(text).toContain('CC0 1.0 Universal');
    expect(text).toContain('No Active Worlds assets are included.');
  });
});

describe('original Wave and Bow animation evidence', () => {
  it('keeps both declaration ordinals and explicit gesture order stable in the local catalog', async () => {
    const catalog = await loadAvatarCatalog(STUDIO_AVATAR_PATH, fetchStudioAvatarAsset);
    expect(catalog.warnings).toEqual([]);
    expect(catalog.entries.map(entry => [entry.index, entry.name])).toEqual([
      [0, 'Wayfarer Voyager'], [1, 'Haven Keeper'], [2, 'Original DirectX Voyager'],
    ]);
    for (const entry of catalog.entries) {
      expect(entry.explicit).toEqual([
        { name: 'Wave', sequence: 'wf-wave' }, { name: 'Bow', sequence: 'wf-bow' },
        ...(entry.index === 2 ? [{ name: 'X Salute', sequence: 'wf-x-salute.x' }] : []),
      ]);
      expect(entry.implicit.idle).toBe('wf-idle');
      expect(entry.implicit.walk).toBe('wf-walk');
    }
  });

  it.each([0, 1])('poses rig %i through real catalog/ZIP/SEQ loaders with visibly distinct joint motion', async index => {
    const catalog = await loadAvatarCatalog(STUDIO_AVATAR_PATH, fetchStudioAvatarAsset);
    const entry = catalog.entries[index];
    const rig = await loadAvatarRwx(STUDIO_AVATAR_PATH, entry.geometry!, fetchStudioAvatarAsset);
    expect(rig.warnings).toEqual([]);
    expect(rig.joints.size).toBe(16);
    for (const { part, parent } of rig.parts) parent.add(createRwxGroup({ parts: [part], warnings: [] }));
    try {
      applyAvatarPose(rig, new Map());
      const at = (name: string) => rig.joints.get(name)!.group.getWorldPosition(new Vector3());
      const restHead = at('head'), restWrist = at('lfwrist');
      const feet = ['lfankle', 'rtankle'].map(at);
      const size = new Box3().setFromObject(rig.root).getSize(new Vector3());
      expect(size.y).toBeGreaterThan(1.7);
      expect(size.y).toBeLessThan(2);

      const wave = await loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset);
      expect(wave.warnings).toEqual([]);
      expect(wave.durationMs).toBe(2200);
      applyAvatarPose(rig, sampleAvatarSequence(wave, 1000, { rootMotion: false }));
      expect(rig.joints.get('lfshoulder')!.group.quaternion.angleTo(identity)).toBeGreaterThan(2);
      expect(at('lfwrist').y - restWrist.y).toBeGreaterThan(.65);
      expect(at('head').distanceTo(restHead)).toBeLessThan(1e-8);

      const bow = await loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-bow', fetchStudioAvatarAsset);
      expect(bow.warnings).toEqual([]);
      expect(bow.durationMs).toBe(2400);
      applyAvatarPose(rig, sampleAvatarSequence(bow, 900, { rootMotion: false }));
      expect(rig.joints.get('back')!.group.quaternion.angleTo(identity)).toBeCloseTo(32 * Math.PI / 180);
      expect(at('head').z - restHead.z).toBeGreaterThan(.25);
      expect(restHead.y - at('head').y).toBeGreaterThan(.07);
      expect(at('lfwrist').y).toBeLessThan(restWrist.y + .2);
      for (let i = 0; i < feet.length; i++) expect(at(['lfankle', 'rtankle'][i]).distanceTo(feet[i])).toBeLessThan(1e-8);

      for (const sequence of [wave, bow]) {
        for (const time of [0, sequence.durationMs, sequence.durationMs + 500]) {
          applyAvatarPose(rig, sampleAvatarSequence(sequence, time, { rootMotion: false }));
          expect(at('head').distanceTo(restHead)).toBeLessThan(1e-8);
          expect(at('lfwrist').distanceTo(restWrist)).toBeLessThan(1e-8);
          for (const joint of rig.joints.values()) {
            expect(joint.group.quaternion.angleTo(joint.bindRotation)).toBeLessThan(1e-8);
            expect(joint.group.position.distanceTo(joint.bindPosition)).toBeLessThan(1e-8);
          }
        }
      }
      for (const name of [entry.implicit.idle, entry.implicit.walk]) {
        const sequence = await loadAvatarSequence(STUDIO_AVATAR_PATH, name, fetchStudioAvatarAsset);
        expect(sequence.warnings).toEqual([]);
        applyAvatarPose(rig, sampleAvatarSequence(sequence, 250, { rootMotion: false }));
        expect([...rig.joints.values()].every(joint => joint.group.matrixWorld.elements.every(Number.isFinite))).toBe(true);
      }
    } finally { disposeModelTree(rig.root, true); }
  });
});

describe('separate original DirectX studio overlay', () => {
  it('plays the catalog-referenced X salute through the exact bundled adapter with no network', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
    const catalog = await loadAvatarCatalog(STUDIO_AVATAR_PATH, fetchStudioAvatarAsset);
    const model = await loadAvatarModel(STUDIO_AVATAR_PATH, catalog.entries[2].geometry!, fetchStudioAvatarAsset);
    if (model.format !== 'x') throw new Error('Expected X');
    const a = createDirectXInstance(model, { jointName: directXJointName });
    const b = createDirectXInstance(model, { jointName: directXJointName });
    try {
      const sequence = await loadAvatarSequence(STUDIO_AVATAR_PATH, catalog.entries[2].explicit[2].sequence, fetchStudioAvatarAsset);
      expect(sequence.format).toBe('directx'); expect(sequence.durationMs).toBe(4000);
      expect(sequence.warnings.join(' ')).toContain('historical AW exporter parity is not yet verified');
      const wrist = () => a.joints.get('lfwrist')!.group.getWorldPosition(new Vector3());
      const rest = wrist();
      a.applyPose(sampleAvatarSequence(sequence, 1900, { rootMotion: false }));
      expect(wrist().y - rest.y).toBeGreaterThan(.75);
      expect(a.joints.get('lfelbow')!.group.quaternion.angleTo(identity)).toBeCloseTo(135 * Math.PI / 180);
      expect(a.joints.get('head')!.group.quaternion.angleTo(identity)).toBeCloseTo(8 * Math.PI / 180);
      expect(b.joints.get('lfelbow')!.group.quaternion.angleTo(identity)).toBeLessThan(1e-8);
      a.applyPose(sampleAvatarSequence(sequence, 4000, { rootMotion: false }));
      expect(wrist().distanceTo(rest)).toBeLessThan(1e-8);
      expect(network).not.toHaveBeenCalled();
    } finally { a.dispose(); b.dispose(); network.mockRestore(); }
  });
  it.each(['UTC', 'America/Toronto'])('reproduces only its six overlay entries without changing either bundle in %s', TZ => {
    const path = resolve(project, 'src/renderer/engine/studio-directx-data.json');
    const before = [studioFile, path].map(file => ({ file, bytes: readFileSync(file), mtime: statSync(file).mtimeMs }));
    const output = execFileSync(process.execPath, [resolve(project, 'scripts/directx-fixture-assets.mjs'), '--studio', '--check'], { encoding: 'utf8', env: { ...process.env, TZ } });
    expect(output).toContain('Verified 6 original studio DirectX fixture files');
    for (const value of before) { expect(readFileSync(value.file)).toEqual(value.bytes); expect(statSync(value.file).mtimeMs).toBe(value.mtime); }
    expect(Object.keys(directXBundle)).toHaveLength(6);
    expect(Object.keys({ ...bundled, ...directXBundle })).toHaveLength(21);
    expect(Object.keys(directXBundle).filter(name => name in bundled).sort()).toEqual(['avatars/avatars.dat', 'avatars/avatars.zip']);
    expect(Object.keys(directXBundle).some(name => name.startsWith('models/') || name.startsWith('seqs/'))).toBe(false);
  });

  it('adds weighted geometry and a local texture without network, default catalog replacement or static-model access', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
    try {
      const catalog = await loadAvatarCatalog(STUDIO_AVATAR_PATH, fetchStudioAvatarAsset);
      expect(catalog.entries[2].geometry).toBe('wf-x-voyager.x');
      const model = await loadAvatarModel(STUDIO_AVATAR_PATH, catalog.entries[2].geometry!, fetchStudioAvatarAsset);
      expect(model.format).toBe('x');
      if (model.format !== 'x') throw new Error('Expected original DirectX geometry');
      expect(model.frames).toHaveLength(17); expect(model.meshes[0].skinWeights).toHaveLength(16);
      expect(model.warnings).toEqual([]);
      const texture = await fetchStudioAvatarAsset(STUDIO_AVATAR_PATH + 'textures/wf-x-corners.png');
      expect(texture.contentType).toBe('image/png'); expect([...texture.bytes.slice(0, 4)]).toEqual([137, 80, 78, 71]);
      await expect(fetchStudioAvatarAsset(STUDIO_AVATAR_PATH + 'models/wf-x-marker.x')).rejects.toThrow();
      await expect(fetchStudioAvatarAsset(STUDIO_AVATAR_PATH + 'avatars/wf-x-voyager.x?token=test')).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('keeps bind geometry exact, independently skins two instances and restores neutral after Wave/Bow', async () => {
    const model = await loadAvatarModel(STUDIO_AVATAR_PATH, 'wf-x-voyager.x', fetchStudioAvatarAsset);
    if (model.format !== 'x') throw new Error('Expected original DirectX geometry');
    const a = createDirectXInstance(model, { jointName: directXJointName }), b = createDirectXInstance(model, { jointName: directXJointName });
    const skinned = (instance: typeof a) => { let found: SkinnedMesh | undefined; instance.root.traverse(node => { if (node instanceof SkinnedMesh) found = node; }); return found!; };
    const meshA = skinned(a), meshB = skinned(b), oracle = studioDirectXFixtureExpectations(), source = oracle.vertices[oracle.elbowWitness.index];
    const positions = meshA.geometry.getAttribute('position');
    let vertex = -1;
    for (let index = 0; index < positions.count; index++) if (new Vector3().fromBufferAttribute(positions, index).distanceTo(new Vector3(...source)) < 1e-6) { vertex = index; break; }
    expect(vertex).toBeGreaterThanOrEqual(0);
    const witness = (mesh: SkinnedMesh) => mesh.localToWorld(mesh.getVertexPosition(vertex, new Vector3()));
    try {
      expect(a.joints.size).toBe(16); expect(b.joints.size).toBe(16);
      expect(meshA.skeleton).not.toBe(meshB.skeleton); expect(meshA.skeleton.bones[0]).not.toBe(meshB.skeleton.bones[0]); expect(meshA.geometry).not.toBe(meshB.geometry);
      const rest = new Vector3(...oracle.elbowWitness.bind); expect(witness(meshA).distanceTo(rest)).toBeLessThan(1e-6); expect(witness(meshB).distanceTo(rest)).toBeLessThan(1e-6);
      a.applyPose(new Map([['lfelbow', { rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), translation: new Vector3() }]]));
      expect(witness(meshA).distanceTo(new Vector3(...oracle.elbowWitness.rotated90Z))).toBeLessThan(1e-6); expect(witness(meshB).distanceTo(rest)).toBeLessThan(1e-6);
      const wave = await loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset), bow = await loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-bow', fetchStudioAvatarAsset);
      a.applyPose(sampleAvatarSequence(wave, 1000, { rootMotion: false })); b.applyPose(sampleAvatarSequence(bow, 900, { rootMotion: false }));
      expect(a.joints.get('lfshoulder')!.group.quaternion.angleTo(identity)).toBeGreaterThan(2);
      expect(b.joints.get('back')!.group.quaternion.angleTo(identity)).toBeCloseTo(32 * Math.PI / 180);
      expect(a.joints.get('back')!.group.quaternion.angleTo(identity)).toBeLessThan(1e-8);
      for (const instance of [a, b]) instance.applyPose(new Map());
      expect(witness(meshA).distanceTo(rest)).toBeLessThan(1e-6); expect(witness(meshB).distanceTo(rest)).toBeLessThan(1e-6);
      const geometryDispose = vi.spyOn(meshB.geometry, 'dispose'), skeletonDispose = vi.spyOn(meshB.skeleton, 'dispose');
      a.dispose(); expect(geometryDispose).not.toHaveBeenCalled(); expect(skeletonDispose).not.toHaveBeenCalled();
      b.applyPose(sampleAvatarSequence(wave, 1000, { rootMotion: false })); expect(b.joints.get('lfshoulder')!.group.quaternion.angleTo(identity)).toBeGreaterThan(2);
    } finally { a.dispose(); b.dispose(); }
  });

  it('uses an identity presentation root only, preserving all diagnostic geometry, joint rests and offsets', async () => {
    const studio = await loadAvatarModel(STUDIO_AVATAR_PATH, 'wf-x-voyager.x', fetchStudioAvatarAsset);
    if (studio.format !== 'x') throw new Error('Expected original DirectX studio avatar');
    const diagnostic = parseDirectX(directXFixtureAssets().get('avatars/wf-x-voyager.x')!);
    expect(studio.frames[0].name).toBe('OriginalAvatarRoot');
    expect(studio.frames[0].matrix).toEqual([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    expect(diagnostic.frames[0].matrix).toEqual([0,0,-1,0,0,1,0,0,1,0,0,0,.25,0,.5,1]);
    expect(studio.frames.slice(1)).toEqual(diagnostic.frames.slice(1));
    expect(studio.meshes).toEqual(diagnostic.meshes);
    expect(studioDirectXFixtureExpectations().bindVertices).toEqual(studioDirectXFixtureExpectations().vertices);
  });
});
