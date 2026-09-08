# Terrain editing protocol

Wayfarer implements Axis's browser `TerrainSet` operation, not SDK-only
`TerrainLoad` or terrain reset. Each command changes one horizontal X row at a
fixed global cell Z. A cell is 10 metres across; height values at the application
boundary are raw terrain metres before the authored terrain offset.

## Contract and supported limits

`TerrainSetCommand` in `src/shared/terrain-edit.ts` carries `requestId`, `world`,
`session`, `cellX`, `cellZ`, `heights`, one `texture`, `previousHeights` and
`previousTextures`. The last two arrays are the exact canonical baseline, not a
suggestion. All arrays have matching lengths, from one to 32 cells. Heights must
round-trip exactly through signed int32 centimetres; sub-centimetre values are
rejected rather than rounded. Textures accept the full uint16 range, allowing
height-only edits to preserve existing extended texture values. Renderer support
for extended texture appearance is a separate limitation.

Cell coordinates are integers within ±2,147,483, consistent with the client's
existing int32-centimetre world position envelope. A row must remain inside that
range. These are Wayfarer limits; pinned Axis accepts rows up to 1,000 cells.
Only one row may be pending, including its readback. Other terrain writes reject
instead of entering a queue. A user-interface batch must submit and verify each
row explicitly and retain partial results; there is no implicit bulk transaction
or automatic rollback across commands.

`TerrainEditRow` holds an origin plus per-cell `heights` and `textures`, for
canonical snapshots and local previews. `TerrainRegion` is a rectangular origin,
width and depth. `TerrainCellSample` explicitly represents unknown height/texture
with `null`; unknown samples must never become assumed zeros.

## Permission and baseline

The pinned server has no Terrain capability bit. Effective `canEditTerrain` is
the authoritative caretaker flag OR the advertised `TerrainRight` attribute
(0x9b) evaluated against the current logged-in citizen. This client does not offer
privilege-password impersonation. Owner and Build flags do not grant terrain
rights. Missing or invalid rights fail closed.

The ACL follows `WorldRightsValue`, including its unusual exact-wildcard rule:
only the complete raw string `*` is a wildcard; ` * ` and `*,-5` are not. Explicit
denies override allows and inclusive ranges. Partial attribute packets retain
the current ACL, while non-text/oversized replacements revoke it locally.

Before sending, the adapter requires the current entered world/session, enabled
terrain, effective permission, and matching cached complete-page samples. It
reserves the terrain query worker, drains its outstanding request and rechecks
the baseline and scope immediately before writing. Unloaded, partial, unknown
or changed baselines reject without a terrain write.

## Acknowledgement, readback and uncertainty

`TerrainSet` (0x58) sends TerrainX/Z, count, one texture and an exact-length
little-endian int32 height buffer. Axis success echoes TerrainNodeX/Z, but neither
count, a request ID nor a resulting sequence. Unauthorized replies may omit
coordinates. A valid nonzero reason rejects without waiting for a coordinate
match. A success-like reply must include an int32 reason and the exact row start.

An ACK alone is not a successful editing result. Axis excludes the writer from
its terrain-change broadcast, so Wayfarer explicitly queries every affected page
with sequence −1. At most two pages are affected by a supported row; readbacks
are serialized ahead of ordinary terrain refreshes. The signed −1 value differs
from every persisted unsigned sequence, forcing actual default-page data even
when its sequence is zero. Initial/evicted terrain queries also use −1. A known
sequence-zero page survives later unchanged zero-sequence replies.

`terrain-page` events carry world/session, page coordinates, sequence and
`complete`. Completion requires the addressed Begin, a valid node chain,
TerrainComplete=1, and no intervening change/obsolescence. A false completion
invalidates editing readiness. The renderer still receives individual `terrain`
tiles for display; it must not infer edit readiness from those alone.

Only after the readback completes does `terrain-result` report the scoped
request ID, row origin and canonical per-cell heights/textures. `status: verified`
means the readback matched all submitted values. `status: conflict` means the
server acknowledged the write, but the observed row differs; this is not a
successful match. In either case the event precedes command resolution. A
conflict does not cause an automatic retry or overwrite.

ACK timeout, malformed success, failed send or unverified post-ACK readback
rejects the command as uncertain and pauses further terrain edits until world
re-entry. Never infer that an uncertain edit failed to reach the database or was
rolled back. Disconnect, world change and travel eviction cancel pending
readbacks without old-scope results or extra retained pages. Each network request
has a 15-second timeout; one edit can include draining one current page, its ACK,
and up to two readbacks, so callers must not install a shorter aggregate deadline
and then resubmit the write.

## Remaining limits and source evidence

The server's `SetTerrainRow` transaction covers all pages in one row, but accepts
no expected baseline or sequence. The local preflight and post-write readback
are not atomic compare-and-swap. Concurrent clients can overwrite each other
between checks, or change a page after the observed result. A verified event is
a point-in-time readback, not lasting ownership or guaranteed conflict detection.

Canonical samples add fixed 112 KiB per retained page (int32 heights, uint16
textures and known bits), at most nine pages / 1,008 KiB, excluding metadata and
renderer allocations. Existing [streaming bounds](streaming.md) remain in force.
No additional page pins are created for edits.

Primary source baseline: World `c3e7486fc153ac31b3df1a07bc2b03d20e348152` and
Platform `f18054d5d16e3869d54243788bced30b59cccf05`:

- [TerrainHandler.SetNode / Query](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/TerrainHandler.cs): browser authorization, row fields, success/denial ACKs, writer exclusion and explicit page query.
- [TerrainDbContext.SetTerrainRow / QueryPage](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Database/TerrainDbContext.cs): centered pages, row transaction and signed-query/unsigned-persisted sequence comparison.
- [TerrainGrid](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Terrain/TerrainGrid.cs) and [NodeGenerator](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Terrain/NodeGenerator.cs): zero default grids and row-major singleton or 8×8 detailed node samples.
- [WorldClient.SendWorldAttributes](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Services/WorldClient.cs) and [WorldRightsValue](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Models/WorldRightsValue.cs): the advertised seven capabilities and exact ACL semantics.

Deterministic tests use the production packet encoder/dispatcher with no sockets:
`npx vitest run tests/protocol-terrain-edit.test.ts tests/protocol-streaming.test.ts`.
Separate isolated-server evidence belongs in [Terrain integration](terrain-integration.md).
