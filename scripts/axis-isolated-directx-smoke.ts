/** Explicitly launched, fresh DirectX profile only. Never accepts arbitrary
 * endpoints/accounts/directories and never changes the primary asset catalog. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AxisClient } from "../src/main/protocol/axis-client";
import { createScopedAssetFetcher } from "../src/main/scoped-assets";
import { nativeQaAssetTarget } from "../src/main/native-startup";
import { decodeModelAsset } from "../src/renderer/engine/assets";
import {
  loadAvatarCatalog,
  loadAvatarSequence,
} from "../src/renderer/engine/avatar-assets";
import {
  parseDirectX,
  type DirectXModel,
} from "../src/renderer/engine/directx";
import type {
  ClientCommand,
  ClientEvent,
  WorldObject,
} from "../src/shared/types";
import { withIsolatedAxis } from "./axis-isolated.mjs";
import { directXFixtureAssets } from "./directx-fixture-assets.mjs";
import { directXAnimationAssets, withDirectXAnimationCatalog } from "./directx-animation-assets.mjs";
import {
  exactOwnedDirectXObject,
  verifyOriginalDirectXModel,
  verifyOriginalDirectXWave,
  verifyOriginalDirectXSalute,
} from "./axis-isolated-directx-helpers";

const animation = process.argv.length === 3 && process.argv[2] === '--animation';
if (process.argv.length !== 2 && !animation)
  throw new Error(
    "The DirectX fixture runner accepts only --animation; no caller-supplied endpoints, accounts or directories.",
  );
type Event<K extends ClientEvent["type"]> = Extract<ClientEvent, { type: K }>;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function sourceFingerprint() {
  const root = join(import.meta.dirname, ".."),
    files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Source fingerprints refuse links.");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[path.slice(root.length + 1)] = hash(await readFile(path));
    }
  }
  await walk(join(root, "src"));
  await walk(join(root, "scripts"));
  for (const name of ["package.json", "package-lock.json"])
    files[name] = hash(await readFile(join(root, name)));
  return files;
}
class Probe {
  readonly events: ClientEvent[] = [];
  readonly objects = new Map<number, WorldObject>();
  readonly client: AxisClient;
  session = 0;
  constructor(worldPort: number) {
    this.client = new AxisClient(
      (event) => {
        this.events.push(event);
        if (this.events.length > 10_000)
          throw new Error("DirectX fixture event budget exceeded");
        if (event.type === "login") this.session = event.session;
        if (event.type === "objects") {
          if (event.replace) this.objects.clear();
          for (const object of event.objects)
            this.objects.set(object.id, object);
        }
        if (event.type === "object-delete") this.objects.delete(event.id);
        if (event.type === "stream-unload")
          for (const id of event.objectIds) this.objects.delete(id);
      },
      {
        authorizeWorldConnection: (target) =>
          assert.deepEqual(
            target,
            { host: "127.0.0.1", port: worldPort, tls: false },
            "Unowned World target refused",
          ),
      },
    );
  }
  command(command: ClientCommand) {
    return this.client.command(command);
  }
  latest<K extends ClientEvent["type"]>(type: K): Event<K> {
    const event = [...this.events]
      .reverse()
      .find((value) => value.type === type);
    assert(event, `Missing ${type} event`);
    return event as Event<K>;
  }
  async wait<K extends ClientEvent["type"]>(
    type: K,
    predicate: (event: Event<K>) => boolean,
    from = 0,
  ): Promise<Event<K>> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const event = this.events
        .slice(from)
        .find((value) => value.type === type && predicate(value as Event<K>));
      if (event) return event as Event<K>;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${type}; recent event types ${this.events
        .slice(-12)
        .map((value) => value.type)
        .join(", ")}`,
    );
  }
  result(requestId: string): Event<"object-result"> {
    const event = this.events.find(
      (value) =>
        value.type === "object-result" && value.requestId === requestId,
    );
    assert(event, "Command completed without its canonical request result");
    return event as Event<"object-result">;
  }
}

// Static imports precede this fingerprint: run only once the source tree freezes.
const sourceBefore = await sourceFingerprint();
await withIsolatedAxis(
  async (fixture) => {
    assert.equal(fixture.assetProfile, animation ? 'directx-animation' : 'directx');
    const started = Date.now(),
      a = new Probe(fixture.ports.world),
      b = new Probe(fixture.ports.world),
      probes = [a, b];
    fixture.registerCleanup(() => {
      for (const probe of probes) probe.client.disconnect();
    });
    const checks: Array<{ name: string; elapsedMs: number }> = [],
      assetHashes: Record<string, string> = {},
      geometryChecks: Record<
        string,
        ReturnType<typeof verifyOriginalDirectXModel>
      > = {};
    const animationChecks: Record<string, ReturnType<typeof verifyOriginalDirectXSalute>> = {};
    const baseline = new Map<number, WorldObject>(),
      temporary = new Map<number, WorldObject>(),
      cleanupFailures: string[] = [];
    const qa = {
      mode: "fixture" as const,
      universePort: fixture.ports.universe,
      worldPort: fixture.ports.world,
      assetPort: fixture.ports.assets,
    };
    const fetcher = createScopedAssetFetcher((input) =>
        nativeQaAssetTarget(input, qa),
      ),
      originals = animation ? withDirectXAnimationCatalog(new Map([...directXFixtureAssets(), ...directXAnimationAssets()])) : directXFixtureAssets();
    const account = (index: number) => ({
      ...fixture.connection,
      username: fixture.accounts[index].username,
      password: fixture.accounts[index].password,
    });
    let failure: unknown,
      uncertainMutation = false,
      avatarModel: DirectXModel | undefined;
    async function check(name: string, action: () => Promise<void> | void) {
      await action();
      checks.push({ name, elapsedMs: Date.now() - started });
      console.log(`PASS ${name}`);
    }
    async function exactAsset(name: string) {
      const response = await fetcher(new URL(name, fixture.objectPath).href);
      const expected = originals.get(name);
      assert(expected, `Unknown generated original asset ${name}`);
      assert.equal(
        hash(response.bytes),
        hash(expected),
        "Served fixture bytes changed",
      );
      assetHashes[name] = hash(response.bytes);
      return response;
    }
    async function removeOwned(id: number, known: WorldObject) {
      const current = b.objects.get(id);
      assert(
        exactOwnedDirectXObject(current, known),
        "Canonical object changed; cleanup refused",
      );
      const requestId = randomUUID(),
        fromA = a.events.length,
        fromB = b.events.length;
      await b.command({ type: "object-delete", requestId, object: current! });
      assert.equal(b.result(requestId).id, id);
      await a.wait("object-delete", (event) => event.id === id, fromA);
      await b.wait("object-delete", (event) => event.id === id, fromB);
      temporary.delete(id);
    }
    try {
      await check(
        "Fixture asset scope refuses primary/remote/query URLs before any request",
        async () => {
          for (const url of [
            "http://127.0.0.1:17400/models/wf-x-marker.x",
            "http://example.invalid/models/wf-x-marker.x",
            fixture.objectPath + "avatars/avatars.dat?cache=1",
          ])
            await assert.rejects(fetcher(url), /only its own/);
        },
      );
      await check(
        "Two fresh citizens enter the original 32-property world with its isolated object path",
        async () => {
          for (const [index, probe] of probes.entries()) {
            await probe.command({ type: "connect", options: account(index) });
            assert.equal(
              probe.latest("login").citizen,
              fixture.accounts[index].citizen,
            );
            assert.equal(
              probe.latest("world").settings.objectPath,
              fixture.objectPath,
            );
            assert.equal(probe.objects.size, 32);
          }
          await b.wait("avatar", (event) => event.avatar.session === a.session);
          await a.wait("avatar", (event) => event.avatar.session === b.session);
          for (const [id, object] of a.objects) {
            baseline.set(id, { ...object });
            assert.deepEqual(b.objects.get(id), object);
          }
        },
      );
      await check(
        "Real catalog keeps RWX 0/1 and appends original X 2 without changing live Wave ordinals",
        async () => {
          await exactAsset("avatars/avatars.dat");
          await exactAsset("avatars/avatars.zip");
          const catalog = await loadAvatarCatalog(fixture.objectPath, fetcher);
          assert.deepEqual(
            catalog.entries.map((entry) => [entry.index, entry.geometry]),
            [
              [0, "wf-voyager.rwx"],
              [1, "wf-keeper.rwx"],
              [2, "wf-x-voyager.x"],
            ],
          );
          assert.deepEqual(catalog.warnings, []);
          for (const entry of catalog.entries)
            assert.deepEqual(entry.explicit, [
              { name: "Wave", sequence: "wf-wave" },
              ...(animation && entry.index === 2 ? [{ name: 'X Salute', sequence: 'wf-x-salute.x' }] : []),
            ]);
        },
      );
      await check(
        "Static text/binary32/binary64 raw and ZIP paths parse and retain exact authored geometry",
        async () => {
          for (const suffix of ["", "-binary32", "-binary64"])
            for (const extension of [".x", ".zip"]) {
              const name = `models/wf-x-marker${suffix}${extension}`,
                response = await exactAsset(name),
                decoded = await decodeModelAsset(
                  response.bytes,
                  `wf-x-marker${suffix}.x`,
                  new URL(name, fixture.objectPath).href,
                );
              assert.equal(decoded.format, "x");
              if (decoded.format !== "x")
                throw new Error("Fixture model format changed");
              const model = parseDirectX(decoded.source);
              assert.deepEqual(model.warnings, []);
              geometryChecks[name] = verifyOriginalDirectXModel(
                model,
                "static",
              );
            }
        },
      );
      await check(
        "Skinned text/binary32/binary64 raw and ZIP paths preserve bind and blended numeric poses",
        async () => {
          for (const suffix of ["", "-binary32", "-binary64"])
            for (const extension of [".x", ".zip"]) {
              const name = `avatars/wf-x-voyager${suffix}${extension}`,
                response = await exactAsset(name),
                decoded = await decodeModelAsset(
                  response.bytes,
                  `wf-x-voyager${suffix}.x`,
                  new URL(name, fixture.objectPath).href,
                );
              assert.equal(decoded.format, "x");
              if (decoded.format !== "x")
                throw new Error("Fixture avatar format changed");
              const model = parseDirectX(decoded.source);
              assert.deepEqual(model.warnings, []);
              geometryChecks[name] = verifyOriginalDirectXModel(
                model,
                "avatar",
              );
              if (!suffix && extension === ".x") avatarModel = model;
            }
        },
      );
      await check(
        "Original texture and external Wave load from the isolated path and return the X rig to neutral",
        async () => {
          await exactAsset("textures/wf-x-corners.png");
          assert(avatarModel);
          const wave = await loadAvatarSequence(
            fixture.objectPath,
            "wf-wave",
            fetcher,
          );
          assert.equal(wave.durationMs, 2200);
          verifyOriginalDirectXWave(avatarModel, wave);
        },
      );
      if (animation) await check(
        'External X text/binary32/binary64/tzip/bzip raw and ZIP plus .seq paths drive independent weighted poses and return neutral',
        async () => {
          assert(avatarModel);
          for (const name of directXAnimationAssets().keys()) {
            if (name.endsWith('.txt')) continue;
            await exactAsset(name);
            const url = new URL(name, fixture.objectPath).href;
            // Force each real HTTP path through the production loader, including
            // raw forms that would normally lose to the ZIP-first candidate.
            const sequence = await loadAvatarSequence(fixture.objectPath, name.slice('seqs/'.length), async candidate => {
              if (candidate !== url) throw new Error('This check selects one exact fixture URL');
              return fetcher(candidate);
            });
            animationChecks[name] = verifyOriginalDirectXSalute(avatarModel, sequence);
          }
          assert.equal(Object.keys(animationChecks).length, 11);
          const catalog = await loadAvatarCatalog(fixture.objectPath, fetcher);
          const catalogSequence = await loadAvatarSequence(fixture.objectPath, catalog.entries[2].explicit[1].sequence, fetcher);
          animationChecks['catalog:X Salute'] = verifyOriginalDirectXSalute(avatarModel, catalogSequence);
        },
      );
      await check(
        animation ? 'Both citizens select X 2 and observe Wave, X Salute and separate neutral gesture states' : "Both citizens select X 2 and observe separate positive and neutral gesture states",
        async () => {
          for (const [sender, observer] of [
            [a, b],
            [b, a],
          ]) {
            let from = observer.events.length;
            await sender.command({
              type: "avatar-select",
              avatar: 2,
              world: fixture.world,
              session: sender.session,
            });
            await observer.wait(
              "avatar",
              (event) =>
                event.avatar.session === sender.session &&
                event.avatar.type === 2 &&
                event.avatar.gesture === 0,
              from,
            );
            for (const gesture of animation ? [1, 0, 2, 0] : [1, 0]) {
              from = observer.events.length;
              await sender.command({
                type: "gesture",
                gesture,
                avatar: 2,
                world: fixture.world,
                session: sender.session,
              });
              await observer.wait(
                "avatar",
                (event) =>
                  event.avatar.session === sender.session &&
                  event.avatar.type === 2 &&
                  event.avatar.gesture === gesture,
                from,
              );
            }
          }
        },
      );
      await check(
        "A real X property returns a canonical ID and identical observer model reference",
        async () => {
          const requestId = randomUUID(),
            description = "Original DirectX isolated " + requestId,
            from = b.events.length;
          const object: WorldObject = {
            id: 0,
            owner: 0,
            model: "wf-x-marker.x",
            description,
            action: "",
            x: 6.25,
            y: 0,
            z: -18.5,
            yaw: 0,
            pitch: 0,
            roll: 0,
          };
          uncertainMutation = true;
          await a.command({ type: "object-add", requestId, object });
          const canonical = a.result(requestId).object;
          assert(canonical && canonical.id > 0);
          temporary.set(canonical.id, canonical);
          uncertainMutation = false;
          assert.equal(canonical.model, object.model);
          assert.equal(canonical.owner, fixture.accounts[0].citizen);
          await b.wait(
            "objects",
            (event) =>
              event.objects.some(
                (value) =>
                  value.id === canonical.id &&
                  value.description === description,
              ),
            from,
          );
          assert.deepEqual(b.objects.get(canonical.id), canonical);
        },
      );
      await check(
        "Guarded canonical deletion restores the exact original 32 properties and avatar types",
        async () => {
          for (const [id, known] of [...temporary])
            await removeOwned(id, known);
          for (const probe of probes) {
            assert.equal(probe.objects.size, baseline.size);
            for (const [id, object] of baseline)
              assert.deepEqual(probe.objects.get(id), object);
          }
          for (const [sender, observer] of [
            [a, b],
            [b, a],
          ]) {
            const from = observer.events.length;
            await sender.command({
              type: "avatar-select",
              avatar: 0,
              world: fixture.world,
              session: sender.session,
            });
            await observer.wait(
              "avatar",
              (event) =>
                event.avatar.session === sender.session &&
                event.avatar.type === 0 &&
                event.avatar.gesture === 0,
              from,
            );
          }
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      for (const [id, known] of [...temporary]) {
        try {
          await removeOwned(id, known);
        } catch {
          cleanupFailures.push(
            `Canonical cleanup refused or failed for owned property ${id}`,
          );
        }
      }
      if (uncertainMutation)
        cleanupFailures.push(
          "An add outcome is uncertain; no unknown property was deleted.",
        );
      const remainingUnexpectedIds = [
        ...new Set(
          probes.flatMap((probe) =>
            [...probe.objects.keys()].filter((id) => !baseline.has(id)),
          ),
        ),
      ];
      const unexpectedErrors = probes.flatMap((probe) =>
        probe.events
          .filter((event) => event.type === "error")
          .map((event) => (event as Event<"error">).message),
      );
      for (const probe of probes) probe.client.disconnect();
      const sourceAfter = await sourceFingerprint(),
        changedSourceFiles = [
          ...new Set([
            ...Object.keys(sourceBefore),
            ...Object.keys(sourceAfter),
          ]),
        ].filter((path) => sourceBefore[path] !== sourceAfter[path]);
      if (
        !failure &&
        (cleanupFailures.length ||
          temporary.size ||
          remainingUnexpectedIds.length ||
          unexpectedErrors.length ||
          changedSourceFiles.length)
      )
        failure = new Error(
          "DirectX checkpoint has cleanup/protocol/source failures; inspect retained report.",
        );
      const report = {
        passed: !failure,
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        checks,
        directory: fixture.directory,
        assetProfile: fixture.assetProfile,
        assetPolicy: {
          host: "127.0.0.1",
          port: fixture.ports.assets,
          redirect: "error",
          credentials: "omit",
        },
        assetHashes,
        geometryChecks,
        ...(animation ? { animationChecks } : {}),
        remainingTemporaryObjectIds: [...temporary.keys()],
        remainingUnexpectedIds,
        uncertainMutation,
        cleanupFailures,
        unexpectedErrors,
        sourceFiles: sourceAfter,
        changedSourceFiles,
        ...(failure
          ? {
              failure:
                failure instanceof Error ? failure.message : "Unknown failure",
            }
          : {}),
      };
      const path = join(fixture.directory, animation ? 'reports/directx-animation-integration.json' : "reports/directx-integration.json");
      await writeFile(path, JSON.stringify(report, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(`Private DirectX integration report: ${path}`);
    }
    if (failure) throw failure;
    console.log(`All ${checks.length} isolated DirectX checks passed.`);
  },
  { assetProfile: animation ? 'directx-animation' : 'directx' },
);
