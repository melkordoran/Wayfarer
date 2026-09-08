# Server-authoritative building results

`object-add`, `object-change`, and `object-delete` accept optional `requestId` (nonempty, at most 128 characters). Successful correlated commands emit `object-result` before their command promise resolves. Add/change include the complete canonical `WorldObject`; delete includes the acknowledged ID. Callers without a request ID retain the earlier ACK-only behavior.

The pinned World server returns object ID, cell, number, and callback reference in its ACK, but no geometry/property text. The adapter subscribes before sending, correlates the originating session's broadcast by a unique in-flight object number, then requires its ID to match the ACK. It never matches descriptions, model names, coordinates, or other fuzzy properties. Owner, text, data, and quantized coordinates/angles come from the actual server broadcast.

## Concurrency limits

Before a change, the adapter requires the supplied previous object to match its current cached canonical properties. It also sends the cached `ObjectOldNumber`, `ObjectOldX`, and `ObjectOldZ` (cell indices). The server rejects a version that no longer exists at lookup with Axis 204. This protects stale renderer snapshots and changes that lose a race before lookup.

**This is optimistic stale-version protection, not a guaranteed atomic compare-and-swap.** The pinned server's object lookup happens before `CellDbContext.UpdateObject` opens its transaction, and the update is by primary ID without an old-number predicate. Concurrent handlers can therefore still race after lookup. Delete reads but does not enforce the requested old number. Local undo/redo must not promise conflict-free atomic deletion or a multi-object transaction. A successful mutation followed by a lost connection before its canonical broadcast can also leave an uncertain outcome; do not automatically retry an add.

## Primary source evidence

Pinned World revision: `c3e7486fc153ac31b3df1a07bc2b03d20e348152`.

- [WorldClient.SendObjectResult](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Services/WorldClient.cs): ACK fields and callback reference.
- [ObjectHandler](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/ObjectHandler.cs): add/change/delete handling; originating session always receives its update; old-number lookup; delete limitation.
- [PacketBuilderExtensions.AddObjectDetails](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Extensions/PacketBuilderExtensions.cs): canonical property broadcast and cell-relative coordinates.
- [CellDbContext.UpdateObject](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Database/CellDbContext.cs): transaction boundary and lack of compare-and-swap.

## Verification

```sh
npx vitest run tests/protocol-mutations.test.ts
npx tsx scripts/axis-mutation-smoke.ts
node scripts/axis-social-provision.mjs
npx tsx scripts/axis-mutation-conflict-smoke.ts
```

Focused tests cover coalesced/reordered ACK and broadcast delivery, identical simultaneous adds, rejection/cancellation cleanup, canonical properties, compatibility, and stale snapshots. The first live smoke uses Explorer; the conflict smoke uses Explorer and SocialTester, never Wayfarer. Temporary objects are removed. The conflict smoke deliberately simulates a delayed local cache and proves a real server stale-number rejection; it does not prove atomicity across server threads.
