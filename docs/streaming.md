# Bounded world streaming

Wayfarer queries a 3×3 sector area and retains property data within a 5×5 sector
window around the latest requested position. Axis sectors are centered 80-metre
squares: cells −4 through 3 belong to sector zero. The retained window is therefore
400×400 metres. This is a client support limit, not a claim of original-browser
visibility parity or a limit on the world's dimensions.

## Retained bounds

| Data | Limit |
| --- | --- |
| Property records | 12,000, including pending-mutation pins |
| Property storage accounting | 32 MiB total; 256 KiB per record |
| Pending object mutations | 64; at most one pinned identity each |
| Property query work | One active chain and one latest pending position |
| Sector sequence metadata | 25 retained sectors; nine active continuation cursors |
| Terrain | Nine centered 1,280-metre pages |
| Terrain nodes | 256 nodes and 16,384 cumulative node cells per page |
| Canonical terrain samples | 112 KiB/page, 1,008 KiB across nine pages |
| Terrain query work | One active page and at most nine coalesced pending pages |

Property storage accounting is `256 + 2 × (model + description + action + base64
data string lengths)` bytes, not a measurement of JavaScript heap use. Packet
decoding, event dispatch, renderer geometry, materials, asset caches and history
have separate allocations; these figures must not be presented as a total memory
cap. Oversized records and excess terrain nodes are ignored with a warning. Under
property pressure, unpinned objects farthest from the visitor are evicted first;
ties retain the most recently received records. Incomplete sectors do not retain
a completion sequence.

## Unload, refresh and revisit

`stream-unload` carries the current world name and Universe session, explicit
object IDs and terrain page coordinates, plus `distance`, `budget`, `refresh` or
`reset`. It is a local cache/resource event, never a server deletion. Consumers
must discard events outside their current scope. World replacement/disconnection
emits reset unload using the old scope before clearing identity.

Eviction removes the associated sequence. Property revisits request sequence
zero; unknown/revisited terrain requests use −1 to force an actual complete
default-page grid even when its persisted sequence is zero. The
outer retained property sectors are not live subscriptions: sectors returning to
the queried 3×3 area are cleared and fully queried again. This also removes stale
properties when a formerly populated cell has become empty: pinned Axis does not
send an empty cell frame. A completed terrain refresh replaces the previous page,
including the case where the page has become empty; unchanged nonzero sequences
preserve existing nodes.

Rapid travel overwrites one pending query position rather than building a request
backlog. An outstanding reply is drained before changing query centers; its
off-window objects and terrain nodes are ignored. Property continuation cursors
are separate from retained sequence metadata so eviction cannot reset progress
inside an active chain. An obsolete partial terrain page remains obsolete even
if the visitor returns before its old completion arrives.

Both property and terrain completion packets lack request IDs; `TerrainEnd` also
lacks page coordinates. Requests are serialized. After a timeout, failed send or
property continuation failure, that stream pauses until world re-entry rather
than letting a late completion satisfy a newer request. Disconnect/re-entry
invalidates pending work and resets the paused state. A terrain-change notice is
coalesced with any current request and prevents adopting its now-stale sequence.

## Editing while traveling

Pending mutations pin their cached identity; a correlated add can pin its newly
assigned ID when the originating-session/random-number broadcast arrives. An
accepted canonical `object-result` is emitted before releasing the pin and
unloading an out-of-window result. Pins and waiters are released on rejection,
timeout or disconnect. Existing requests without `requestId` remain ACK-only.

Changes and deletes require a matching currently cached canonical snapshot.
Evicted or stale selections are rejected locally; deletion no longer falls back
to an unknown object number of zero. The upstream concurrency limits documented
in [Building protocol](protocol-building.md) still apply: this cache check is not
an atomic server-side compare-and-swap, and Axis deletion ignores the supplied
object number.

## Source and verification

Source baseline: Axis World `c3e7486fc153ac31b3df1a07bc2b03d20e348152`:

- [QueryHandler.cs](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/QueryHandler.cs): `ProcessQuery`, `ProcessCell`, `UpdateClientLiveZone`, and query budgets. The live zone changes after `QueryUpToDate`; empty cells have no frame. Server-side per-cell truncation remains an additional completeness limit.
- [TerrainHandler.cs](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/TerrainHandler.cs): `Query` emits page-addressed Begin/Data and an unaddressed End; equal sequences omit Data.
- [NodeGenerator.cs](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Terrain/NodeGenerator.cs): 32/16-cell flat nodes or 8×8 detail; each sample array is a packed singleton or a full node grid. Wayfarer rejects intermediate array lengths and nodes outside their declared page.
- [ObjectHandler.cs](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/ObjectHandler.cs): result/broadcast ordering and originating-session updates.

Deterministic regression suite (real packet encoder/dispatcher, no sockets or
account activity): `npx vitest run tests/protocol-streaming.test.ts`. The suite
covers count/text/node budgets, centered boundaries, distant late replies,
revisits, empty replacements, request coalescing, continuation failure, mutation
correlation, stale edits, timeout pausing, and world reset. Live isolated fixture
verification is a separate check; these tests alone do not establish arbitrary
server compatibility.
