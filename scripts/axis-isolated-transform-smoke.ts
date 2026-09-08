/** Connected transform-boundary evidence, not a native gizmo interaction test.
 * Run only after source freeze. No endpoint, account, path or cleanup arguments:
 * all mutations belong to two fresh citizens in withIsolatedAxis's owned world. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Euler, Quaternion, Vector3 } from 'three';
import { AxisClient } from '../src/main/protocol/axis-client';
import type { ClientCommand, ClientEvent, WorldObject } from '../src/shared/types';
import { BuildHistory, type BuildAdapter, type BuildChange, type BuildOutcome } from '../src/renderer/build-history';
import { selectionCentre, transformObjects } from '../src/renderer/engine/transform-tools';
import { withIsolatedAxis } from './axis-isolated.mjs';
import { exactOwnedTransformDelete, sameTestCanonicalObject, testCanonicalObject, testLocalWorldDelta, testPropertyQuaternion,
  testQuaternionMultiply, testRotateVector, testSelectionCentre, testTransformedPosition, type TestQuaternion, type TestVector } from './axis-isolated-transform-helpers';

if (process.argv.length !== 2) throw new Error('The isolated transform runner accepts no endpoint, account or data-directory arguments.');
type Event<K extends ClientEvent['type']> = Extract<ClientEvent, { type: K }>;
const root = join(import.meta.dirname, '..');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function sourceFingerprint() {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source fingerprints refuse symlinks.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[path.slice(root.length + 1)] = digest(await readFile(path));
    }
  }
  await walk(join(root, 'src')); await walk(join(root, 'scripts'));
  for (const name of ['package.json', 'package-lock.json']) files[name] = digest(await readFile(join(root, name)));
  return files;
}
class TransformProbe {
  readonly events: ClientEvent[] = [];
  readonly objects = new Map<number, WorldObject>();
  readonly client: AxisClient;
  session = 0;
  world = '';
  constructor(worldPort: number) {
    this.client = new AxisClient(event => {
      if (this.events.length >= 10_000) throw new Error('Isolated transform event budget exceeded');
      this.events.push(event);
      if (event.type === 'login') this.session = event.session;
      if (event.type === 'world') this.world = event.settings.name;
      if (event.type === 'objects') {
        if (event.replace) this.objects.clear();
        for (const object of event.objects) this.objects.set(object.id, { ...object });
      } else if (event.type === 'object-delete') this.objects.delete(event.id);
      else if (event.type === 'stream-unload' && event.session === this.session && event.world === this.world)
        for (const id of event.objectIds) this.objects.delete(id);
    }, { authorizeWorldConnection: target => assert.deepEqual(target, { host: '127.0.0.1', port: worldPort, tls: false }, 'Unowned World target refused') });
  }
  command(command: ClientCommand) { return this.client.command(command); }
  latest<K extends ClientEvent['type']>(type: K): Event<K> {
    const event = [...this.events].reverse().find(event => event.type === type);
    assert(event, `Missing ${type} event`); return event as Event<K>;
  }
  result(requestId: string): Event<'object-result'> {
    const events = this.events.filter(event => event.type === 'object-result' && event.requestId === requestId);
    assert.equal(events.length, 1, 'Each write requires exactly one correlated canonical result');
    return events[0] as Event<'object-result'>;
  }
  async wait<K extends ClientEvent['type']>(type: K, predicate: (event: Event<K>) => boolean, from: number) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const found = this.events.slice(from).find(event => event.type === type && predicate(event as Event<K>));
      if (found) return found as Event<K>;
      await pause(20);
    }
    throw new Error(`Timed out waiting for ${type}; recent events: ${this.events.slice(-12).map(event => event.type).join(', ')}`);
  }
  async observed(object: WorldObject, from: number) {
    await this.wait('objects', event => event.objects.some(value => sameTestCanonicalObject(value, object)), from);
    assert.deepEqual(this.objects.get(object.id), object, 'Observer cache must retain the exact canonical broadcast');
  }
}

function closeVector(actual: readonly number[], expected: readonly number[], tolerance: number, label: string) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert(Math.abs(value - expected[index]) < tolerance, `${label} component ${index}: ${value} != ${expected[index]}`));
}
function closeQuaternion(actual: TestQuaternion, expected: TestQuaternion, tolerance: number, label: string) {
  const same = Math.hypot(...actual.map((value, index) => value - expected[index]));
  const opposite = Math.hypot(...actual.map((value, index) => value + expected[index]));
  assert(Math.min(same, opposite) < tolerance, `${label}: independent quaternion mismatch`);
}
function checkTransformOracle(changes: readonly BuildChange[], centre: TestVector, destination: TestVector, delta: TestQuaternion) {
  for (const change of changes) {
    assert(change.before && change.after);
    closeVector([change.after.x, change.after.y, change.after.z], testTransformedPosition(change.before, centre, destination, delta), 1e-9, 'World position');
    const expectedOrientation = testQuaternionMultiply(delta, testPropertyQuaternion(change.before));
    closeQuaternion(testPropertyQuaternion(change.after), expectedOrientation, 1e-10, 'Unquantized authored orientation');
    // The canonical orientation can differ by at most three half-tenth-degree
    // Euler quantizations. A 0.002 quaternion chord is a conservative bound.
    closeQuaternion(testPropertyQuaternion(testCanonicalObject(change.after)), expectedOrientation, .002, 'Quantized authored orientation');
    for (const key of ['id', 'owner', 'model', 'description', 'action', 'type', 'data'] as const)
      assert.equal(change.after[key], change.before[key], `Transform must preserve ${key}`);
  }
}
function acceptedHistory(outcome: BuildOutcome, count = 2) {
  assert.equal(outcome.error, undefined, 'History operation must succeed completely');
  assert.equal(outcome.cancelled, undefined); assert.equal(outcome.applied.length, count);
}

// Covers fixture preparation/startup and teardown. Static imports precede this
// snapshot: launch from a frozen tree; hashes are not loaded-module attestation.
const sourceBefore = await sourceFingerprint();
await withIsolatedAxis(async fixture => {
  const started = Date.now(), a = new TransformProbe(fixture.ports.world), b = new TransformProbe(fixture.ports.world);
  fixture.registerCleanup(() => a.client.disconnect()); fixture.registerCleanup(() => b.client.disconnect());
  const probes = [a, b], expectedErrors = new Set<ClientEvent>(), initial = new Map<number, WorldObject>(), owned = new Map<number, WorldObject>();
  const initialIds = new Set<number>(), checks: Array<{ name: string; elapsedMs: number }> = [];
  const mutations: Array<{ operation: string; requestId: string; before?: WorldObject; requested?: WorldObject; canonical?: WorldObject; id: number }> = [];
  const oracleEvidence: unknown[] = [], cleanupFailures: Array<{ id: number; reason: string }> = [];
  const history = new BuildHistory();
  let failure: unknown, uncertainMutation: string | null = null, adapterCalls = 0;
  const primaryBefore = fixture.verifyPrimary();
  const prefix = `Transform-${randomUUID()}`;
  const options = (index: number) => ({ ...fixture.connection, username: fixture.accounts[index].username, password: fixture.accounts[index].password });
  const cloneObjects = () => [...owned.values()].map(object => ({ ...object }));
  function exactStates(objects: readonly WorldObject[]) {
    for (const object of objects) for (const probe of probes) assert.deepEqual(probe.objects.get(object.id), object, 'Both clients must agree with the exact saved canonical state');
  }
  async function check(name: string, action: () => Promise<void> | void) {
    await action(); checks.push({ name, elapsedMs: Date.now() - started }); console.log(`PASS ${name}`);
  }
  const adapter: BuildAdapter = {
    read: id => a.objects.get(id),
    async apply(change) {
      // This adapter deliberately supports only changes to this run's two adds.
      assert(change.before && change.after); assert.equal(change.before.id, change.after.id);
      const known = owned.get(change.before.id);
      assert(known && !initialIds.has(known.id)); assert.deepEqual(change.before, known);
      exactStates([known]); assert.equal(uncertainMutation, null); adapterCalls++;
      assert.equal(a.latest('status').phase, 'online'); assert.equal(b.latest('status').phase, 'online');
      const requestId = randomUUID(), from = b.events.length;
      uncertainMutation = `change:${requestId}`;
      await a.command({ type: 'object-change', requestId, previous: { ...known }, object: { ...change.after } });
      const result = a.result(requestId); assert.equal(result.operation, 'change'); assert.equal(result.id, known.id); assert(result.object);
      const canonical = { ...result.object };
      assert.deepEqual(canonical, testCanonicalObject(change.after, known.id, known.owner), 'Canonical centimetres/tenth-degrees and metadata must match the independent wire oracle');
      assert.deepEqual(a.objects.get(canonical.id), canonical); await b.observed(canonical, from);
      owned.set(canonical.id, canonical); uncertainMutation = null;
      mutations.push({ operation: 'change', requestId, id: canonical.id, before: { ...known }, requested: { ...change.after }, canonical });
      return { before: { ...known }, after: { ...canonical } };
    },
  };
  async function deleteKnown(id: number) {
    const known = owned.get(id); assert(known);
    const target = exactOwnedTransformDelete({ initialIds, known, current: a.objects.get(id), observer: b.objects.get(id), uncertain: uncertainMutation !== null });
    assert(target, 'Cleanup requires an exact nonseeded owned snapshot on both clients and no uncertain mutation');
    assert.equal(a.latest('status').phase, 'online'); assert.equal(b.latest('status').phase, 'online');
    const requestId = randomUUID(), from = b.events.length;
    uncertainMutation = `delete:${requestId}`;
    await a.command({ type: 'object-delete', requestId, object: target });
    const result = a.result(requestId); assert.equal(result.operation, 'delete'); assert.equal(result.id, id); assert.equal(result.object, undefined);
    await b.wait('object-delete', event => event.id === id, from);
    assert.equal(a.objects.has(id), false); assert.equal(b.objects.has(id), false);
    owned.delete(id); uncertainMutation = null; mutations.push({ operation: 'delete', requestId, id, before: target });
  }
  try {
    await check('Owned fresh fixture and two distinct citizens enter with exact original properties', async () => {
      assert.equal(primaryBefore.unchanged, true, 'Primary fixture changed before transform checks');
      assert.equal(fixture.assetProfile, 'baseline'); assert.equal(fixture.restrictMovement, false);
      assert.equal(fixture.connection.host, '127.0.0.1'); assert.equal(fixture.world, 'Haven');
      for (const port of Object.values(fixture.ports)) assert(![16670, 17000, 17400].includes(port));
      assert.notEqual(fixture.accounts[0].citizen, fixture.accounts[1].citizen);
      for (const [index, probe] of probes.entries()) {
        await probe.command({ type: 'connect', options: options(index) });
        assert.equal(probe.latest('login').citizen, fixture.accounts[index].citizen);
        assert.equal(probe.latest('status').phase, 'online');
        const settings = probe.latest('world').settings;
        assert.equal(settings.name, fixture.world); assert.equal(settings.objectPath, fixture.objectPath);
        assert.equal(settings.canBuild, true); assert.equal(settings.caretaker, true); assert.equal(probe.objects.size, 32);
      }
      for (const [id, object] of a.objects) { initial.set(id, { ...object }); initialIds.add(id); }
      exactStates([...initial.values()]);
      const model = await readFile(join(fixture.directory, 'assets/models/column.rwx'));
      assert.match(model.toString('utf8'), /ModelBegin[\s\S]+ModelEnd/);
      oracleEvidence.push({ originalModel: 'column.rwx', sha256: digest(model) });
    });
    await check('Two owned compound-rotation columns receive exact canonical identities and metadata', async () => {
      const candidates: WorldObject[] = [
        { id: 0, owner: fixture.accounts[0].citizen, model: 'column.rwx', description: `${prefix} primary`, action: 'create rotate 0 12 0, color blue',
          x: 8.23456, y: 1.23789, z: -20.34567, yaw: .45678, pitch: -.23456, roll: .34567, type: 0, data: Buffer.from('Original transform primary').toString('base64') },
        { id: 0, owner: fixture.accounts[0].citizen, model: 'column.rwx', description: `${prefix} secondary`, action: 'create color green; activate visible off',
          x: 11.87654, y: 3.45678, z: -17.65432, yaw: -.56789, pitch: .32109, roll: -.43219, type: 0, data: Buffer.from('Original transform secondary').toString('base64') },
      ];
      for (const candidate of candidates) {
        const requestId = randomUUID(), from = b.events.length; uncertainMutation = `add:${requestId}`;
        await a.command({ type: 'object-add', requestId, object: candidate });
        const result = a.result(requestId); assert.equal(result.operation, 'add'); assert(result.object && result.id > 0);
        assert.equal(result.id, result.object.id); assert(!initialIds.has(result.id) && !owned.has(result.id));
        const canonical = { ...result.object };
        assert.deepEqual(canonical, testCanonicalObject(candidate, result.id, fixture.accounts[0].citizen));
        assert.deepEqual(a.objects.get(result.id), canonical); await b.observed(canonical, from);
        owned.set(result.id, canonical); uncertainMutation = null;
        mutations.push({ operation: 'add', requestId, id: canonical.id, requested: candidate, canonical });
      }
      assert.equal(owned.size, 2); assert.equal(a.objects.size, 34); assert.equal(b.objects.size, 34);
    });
    const original = cloneObjects();
    await check('Local-axis translation uses the primary authored YXZ frame and preserves both orientations', async () => {
      const before = cloneObjects(), primary = before[0], centre = selectionCentre(before), independentCentre = testSelectionCentre(before);
      closeVector(centre.toArray(), independentCentre, 1e-12, 'Centroid');
      const localOffset: TestVector = [1.237, -.486, .913];
      const primaryQuaternion = new Quaternion().setFromEuler(new Euler(primary.pitch, primary.yaw, primary.roll, 'YXZ'));
      const destination = centre.clone().add(new Vector3(...localOffset).applyQuaternion(primaryQuaternion));
      const independentOffset = testRotateVector(localOffset, testPropertyQuaternion(primary));
      const independentDestination: TestVector = [independentCentre[0] + independentOffset[0], independentCentre[1] + independentOffset[1], independentCentre[2] + independentOffset[2]];
      assert(Math.hypot(...independentOffset.map((value, index) => value - localOffset[index])) > .1, 'The fixture must distinguish local axes from world axes');
      const changes = transformObjects(before, centre, destination, new Quaternion());
      checkTransformOracle(changes, independentCentre, independentDestination, [0, 0, 0, 1]);
      for (const change of changes) for (const key of ['yaw', 'pitch', 'roll'] as const) assert.equal(change.after[key], change.before[key]);
      acceptedHistory(await history.execute('Isolated local translation', changes, adapter));
      assert.deepEqual(history.size, { undo: 1, redo: 0 });
      oracleEvidence.push({ operation: 'local translation', primaryId: primary.id, localOffset, independentOffset, centre: independentCentre, destination: independentDestination, canonical: cloneObjects() });
    });
    const translated = cloneObjects();
    await check('Local group rotation conjugates the primary frame and turns both origins around their centroid', async () => {
      const before = cloneObjects(), primary = before[0], centre = selectionCentre(before), independentCentre = testSelectionCentre(before), angle = .646543;
      const frame = new Quaternion().setFromEuler(new Euler(primary.pitch, primary.yaw, primary.roll, 'YXZ'));
      const localRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle);
      const worldDelta = frame.clone().multiply(localRotation).multiply(frame.clone().invert());
      const independentDelta = testLocalWorldDelta(primary, 'X', angle);
      closeQuaternion(worldDelta.toArray(), independentDelta, 1e-12, 'Conjugated local X');
      const changes = transformObjects(before, centre, centre.clone(), worldDelta);
      checkTransformOracle(changes, independentCentre, independentCentre, independentDelta);
      // Both objects have different compound orientations: this detects replacing
      // all selected rotations with the primary's absolute gizmo quaternion.
      for (const change of changes) assert(Math.hypot(change.after.x - change.before.x, change.after.y - change.before.y, change.after.z - change.before.z) > .25);
      acceptedHistory(await history.execute('Isolated local group rotation', changes, adapter));
      assert.deepEqual(history.size, { undo: 2, redo: 0 });
      oracleEvidence.push({ operation: 'local group rotation', primaryId: primary.id, axis: 'X', angle, frame: testPropertyQuaternion(primary), independentDelta, centre: independentCentre, canonical: cloneObjects() });
    });
    const rotated = cloneObjects();
    await check('Stale-before protocol and history requests cannot overwrite the newer canonical transforms', async () => {
      const requestId = randomUUID(), from = a.events.length;
      uncertainMutation = `stale-check:${requestId}`;
      await assert.rejects(a.command({ type: 'object-change', requestId, previous: original[0], object: { ...original[0], x: 99 } }), /Object changed/);
      assert.equal(a.events.some(event => event.type === 'object-result' && event.requestId === requestId), false);
      const errors = a.events.slice(from).filter(event => event.type === 'error' && /Object changed/.test(event.message));
      assert.equal(errors.length, 1); errors.forEach(event => expectedErrors.add(event));
      uncertainMutation = null;
      const beforeCalls = adapterCalls;
      const denied = await history.execute('Stale isolated edit', [{ before: original[0], after: { ...original[0], x: 99 } }], adapter);
      assert.equal(denied.applied.length, 0); assert.match(denied.error ?? '', /changed since this edit/);
      assert.equal(adapterCalls, beforeCalls); assert.deepEqual(history.size, { undo: 2, redo: 0 }); exactStates(rotated);
    });
    await check('A fresh observer connection queries the same stored centimetres, tenth-degrees and action metadata', async () => {
      b.client.disconnect(); b.objects.clear(); const from = b.events.length;
      await b.command({ type: 'connect', options: options(1) });
      assert.equal(b.latest('status').phase, 'online'); assert.equal(b.latest('login').citizen, fixture.accounts[1].citizen);
      for (const object of rotated) await b.observed(object, from);
      exactStates(rotated); exactStates([...initial.values()]); assert.equal(b.objects.size, 34);
    });
    await check('Canonical group undo and redo restore exact original transforms without changing authored metadata', async () => {
      acceptedHistory(await history.undo(adapter)); exactStates(translated);
      acceptedHistory(await history.undo(adapter)); exactStates(original); assert.deepEqual(history.size, { undo: 0, redo: 2 });
      acceptedHistory(await history.redo(adapter)); exactStates(translated);
      acceptedHistory(await history.redo(adapter)); exactStates(rotated); assert.deepEqual(history.size, { undo: 2, redo: 0 });
      acceptedHistory(await history.undo(adapter)); exactStates(translated);
      acceptedHistory(await history.undo(adapter)); exactStates(original);
      oracleEvidence.push({ operation: 'history restoration', original, final: cloneObjects(), history: history.size });
    });
    await check('Exact owned deletes leave both clients with only the unchanged original 32 properties', async () => {
      for (const id of [...owned.keys()]) await deleteKnown(id);
      assert.equal(a.objects.size, initial.size); assert.equal(b.objects.size, initial.size); exactStates([...initial.values()]);
    });
    const unexpected = probes.flatMap(probe => probe.events.filter(event => event.type === 'error' && !expectedErrors.has(event)));
    assert.deepEqual(unexpected, [], 'Unexpected protocol errors occurred');
  } catch (cause) { failure = cause; }
  finally {
    // No rollback of seeded or user properties. Failure cleanup is restricted to
    // exact, known additions; any uncertain write stops all destructive cleanup.
    for (const id of [...owned.keys()]) {
      if (uncertainMutation) { cleanupFailures.push({ id, reason: 'An uncertain mutation requires inspection; no delete attempted.' }); continue; }
      try { await deleteKnown(id); }
      catch (cause) { cleanupFailures.push({ id, reason: cause instanceof Error ? cause.message : 'Exact cleanup refused' }); }
    }
    if (cleanupFailures.length && !failure) failure = new Error('Some owned transform objects were retained for inspection.');
    let stop: Awaited<ReturnType<typeof fixture.stop>> | undefined;
    try { stop = await fixture.stop(); }
    catch (cause) { if (!failure) failure = cause; }
    const sourceAfter = await sourceFingerprint();
    const changedSourceFiles = [...new Set([...Object.keys(sourceBefore), ...Object.keys(sourceAfter)])].filter(path => sourceBefore[path] !== sourceAfter[path]);
    if (changedSourceFiles.length && !failure) failure = new Error('Sources changed during the live run; rerun against a frozen tree.');
    if (stop && !stop.primary.unchanged && !failure) failure = new Error('Primary fixture drift detected; no primary data was restored.');
    const report = fixture.writeReport('transform-integration', {
      schema: 1, passed: !failure, timestamp: new Date().toISOString(), elapsedMs: Date.now() - started,
      scope: 'Fresh owned Axis fixture; connected transform/helper/history boundary, not native gizmo interaction.',
      world: fixture.world, ports: fixture.ports, checks, oracleEvidence, mutations,
      initialObjects: [...initial.values()], remainingTemporaryObjectIds: [...owned.keys()], uncertainMutation, cleanupFailures,
      sourceBefore, sourceAfter, changedSourceFiles, primaryBefore, stop,
      ...(failure ? { failure: failure instanceof Error ? failure.message : 'Unknown isolated transform failure' } : {}),
    });
    console.log(`Private isolated transform report: ${report}`);
  }
  if (failure) throw failure;
  console.log(`All ${checks.length} isolated transform checks passed in ${Date.now() - started}ms.`);
});
