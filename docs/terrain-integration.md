# Terrain editing: pinned source and isolated evidence

This work targets the pinned Axis implementation, not a claim of complete AW
terrain-editor parity. The frozen v0.8 isolated checkpoint below verifies the
bounded editing contract; the later v0.9 regression is recorded separately.
The fixture workflow never targets the existing primary servers.

## Wire and storage contract

The source is World commit `c3e7486fc153ac31b3df1a07bc2b03d20e348152`
and Platform commit `f18054d5d16e3869d54243788bced30b59cccf05`.
Primary implementation references are
[TerrainHandler](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/TerrainHandler.cs),
[TerrainDbContext](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Database/TerrainDbContext.cs),
[TerrainGrid](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Terrain/TerrainGrid.cs),
[NodeGenerator](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Terrain/NodeGenerator.cs)
and [WorldRightsValue](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Models/WorldRightsValue.cs).

| Value | Meaning |
| --- | --- |
| Global cell X/Z | Signed terrain coordinates, at 10-metre spacing |
| Page | 128 × 128 cells; `floor((cell + 64) / 128)` on each axis |
| Page-local cell | `cell - (page * 128 - 64)`, range 0–127 |
| Height payload | Signed 32-bit centimetres; client API uses metres, before display terrain offset |
| Row | Consecutive cells increasing X at one fixed Z |
| Texture payload | One unsigned 16-bit value applied to every cell in the row |
| Detailed node | 8 × 8 samples in `z * 8 + x` order; heights and textures pack independently |
| Flat node | One value fills its authored 8/16/32-cell square |

`TerrainSet` (`0x58`) carries global X (`0xa6`), Z (`0xa7`), count
(`0x99`), heights (`0x9a`) and texture (`0xa5`). The server accepts
1–1000 cells; the client editing slice deliberately uses a smaller row limit.
Send exactly four bytes per declared height: the pinned handler's permissive
length check is followed by an array copy which can throw on oversized input.

A successful or invalid-argument ACK echoes **TerrainNodeX/Z** (`0x9e/0x9f`),
not the request's TerrainX/Z field IDs. Unauthorized reason **32** omits those
coordinates. There is no request ID, count, expected sequence or resulting data
in the ACK. Serializing mutations is therefore necessary; an uncertain reply
must not be retried automatically.

`SetTerrainRow` changes all affected pages in one SQLite transaction. It
increments their page sequences, but does **not** compare an expected sequence
or previous values. Local stale-baseline checks and full readback cannot turn
this into atomic compare-and-swap. A matching readback means the requested values
were observed at that point, not that another client cannot change them next.

Other subscribed browser/SDK sessions receive `TerrainChanged` page coordinates;
the submitting session is excluded. A writer must explicitly refresh affected
pages. `TerrainBegin` supplies page coordinates, data supplies nodes, and
`TerrainEnd` supplies the page sequence but no page coordinates. Page queries
must remain correlated and serialized independently of mutation ACKs.

## Empty pages and permissions

An absent page has sequence zero. Querying it with sequence zero returns no
nodes, which cannot by itself establish an editable full snapshot. A forced
query with sequence **-1** makes the pinned server generate the real default:
16 disjoint flat 32 × 32 nodes, all height zero and texture zero, followed by
`TerrainEnd` sequence zero. Missing/unloaded client data is not permission to
invent a baseline.

Browser, SDK and world-admin sessions may submit rows. Non-admin sessions need
caretaker status or `TerrainRight`; build permission alone is insufficient.
The exact raw ACL `*` grants all nonnegative citizen numbers, including tourist
zero. Empty ACL denies; explicit negative IDs deny before allow/range checks.
Comma/space-separated integer IDs and inclusive ranges are supported. Embedded
wildcards such as `*,-5` and whitespace-padded ` * ` are not equivalent to `*`
in the pinned parser. Unsupported or malformed client-side interpretations must
fail closed, not broaden server rights.

## Isolated runner and restoration

```sh
npx tsx scripts/axis-isolated-terrain-smoke.ts
npx vitest run tests/axis-isolated-terrain.test.ts
```

The script accepts no external host, account, directory or PID arguments.
Pure helper tests do not start servers.
The renderer/native contract is documented in [terrain protocol](terrain-protocol.md).

The fresh fixture's citizens 2/3 are caretakers and its TerrainRight is `2,3`;
tourist zero has no terrain right. The immutable seed creates one all-zero page.
The dedicated test uses two fresh citizen clients and a separate tourist,
with exact loopback World-target guards and no primary credentials or endpoints.

Checks cover retained sequence-zero baselines, accepted centimetre heights/texture values, observed second-client
refresh, stale and unloaded baseline rejection, positive/negative X page
boundaries, a separate Z page boundary, and real unauthorized server reason 32.
That final wire-denial check bypasses only the test client's local permission
precheck on its own authenticated tourist transport; it never changes rights or
server code.

Every touched row retains its original values and the test's last verified
canonical result. Restoration is allowed only when the current complete row
still matches that exact owned result. Unknown, conflicting, busy or uncertain
state is reported for inspection; it is not a reason for unconditional rollback.
After restoration, both client readback and a fixed query of the fresh
fixture's `terrain_page` blobs check all original values. The exact disposable
database, its parents and existing WAL/SHM/journal sidecars must be real, unlinked
paths. SQLite opens normally with `PRAGMA query_only=ON` before the SELECT and
without loading personal `.sqliterc` settings. This blocks SQL data writes but
permits SQLite WAL/SHM filesystem housekeeping; it is **not** a filesystem-read-only
audit. `immutable=1` is never used against the live database. This does **not** claim
byte-identical database restoration: sequence counters advance, and newly
allocated all-zero pages may remain. All private artifacts are retained.

The existing [isolated lifecycle](isolated-fixture.md) owns startup/shutdown,
primary-file/process comparisons and cleanup reports. Source fingerprints cover
`src`, `scripts` and package manifests, with the existing limitation that static
imports precede the first fingerprint. Frozen-source final runs, not work-in-
progress observations, establish a checkpoint.

## Final frozen v0.9 regression — 7 September 2026

After the studio DirectX presentation correction, `axis-isolated-R0eGxd` passed
10/10 terrain checks in 805 ms at `2026-09-07T09:07:05.725Z`. Its
`reports/terrain-integration.json` records 116 matching source/script/package
fingerprints, no drift, original terrain values restored, and no cleanup
failures or unexpected errors. The original zero page advanced 128→135 and
four new zero pages remained at sequence 2; database-byte identity is not claimed.
All 381 primary file hashes and three PID/birth/command identities matched on
the before/after and independent post-run checks. Owned Universe/World/assets
PIDs 97015/97026/97004 were stopped and absent; no fixture listeners remained.
The associated final 50-check DirectX/baseline/restricted/terrain run set is
documented in [DirectX integration](directx-integration.md). The earlier v0.9
`NkZLem` terrain run remains pre-studio-presentation candidate evidence.

## Final frozen v0.8 checkpoint — 7 September 2026

All three runs followed the final Travel-dialog draft, terrain-header and
help/copy polish. They were sequential, using independently prepared fixtures and
loopback ports 26670/27000/27400. Times below are UTC report timestamps; measured
durations cover the integration callback, not the entire bootstrap/shutdown.

| Run | Retained directory under `.runtime` | Checks | Duration | Timestamp |
| --- | --- | --- | --- | --- |
| Terrain | `axis-isolated-qhPM5A` | 10/10 | 657 ms | 08:28:17.558Z |
| Ordinary regression | `axis-isolated-WAQDdG` | 15/15 | 6,763 ms | 08:28:30.192Z |
| Restricted movement regression | `axis-isolated-IpVoZj` | 16/16 | 6,834 ms | 08:28:44.968Z |

Terrain evidence is in `reports/terrain-integration.json`; the other two use
`reports/integration.json`. Each directory also retains private primary
comparison and `stop-*.json` reports. All 109 captured files across `src`,
`scripts` and package manifests matched the frozen source, with no in-run drift.
An independent post-run comparison matched those same 109 files.

All 381 captured primary files and all three primary PID/birth/command identities
matched before and after each run and on the independent post-run recheck. Each
owned stop report lists World, Universe and assets stopped with no refused
signals or cleanup errors. All nine owned child PIDs were absent afterward
(terrain 70921/70932/70906, ordinary 71121/71132/71110, restricted
71339/71351/71327; order Universe/World/assets), and no listeners remained on
the three fixture ports. These are captured-state comparisons, not a claim to
observe every possible transient external change.

The terrain run observed canonical row edits from both clients, complete default
page snapshots, unchanged sequence-zero refreshes, positive and negative X
crossings, an independent Z crossing, stale/unloaded baseline refusal and the
server's real unauthorized tourist reply. Guarded restoration returned every
height and texture blob to zero. The original page advanced from sequence 128 to
135; four newly allocated all-zero pages remained at sequence 2. Thus the
original terrain **values** were restored, not the SQLite bytes or page
allocation history. Restoration cleanup failures and unexpected errors were empty. The
ordinary and restricted runs also left no temporary property IDs.

The first attempted terrain run, `axis-isolated-zPwbNw`, is retained as failed
preflight evidence: the platform SQLite `-readonly` connection could not open
the fresh WAL-mode database without WAL/SHM files. It stopped before any client
login or terrain write, shut down all owned services, and preserved primary
state. The bounded audit fix described above passed 24 helper tests, including
a real WAL-mode database read, rejected SQL UPDATE with unchanged values, and
linked-path/sidecar rejection. Its final live rerun is the successful terrain
checkpoint in the table. Earlier ordinary/restricted runs `nVe6Lm` and `WCSuYF`
predate that runner-only fix and are not the final source checkpoint.
The successful intermediate terrain/ordinary/restricted runs `4ttIWb`, `wiLuk9`
and `oIsIn4` (10/15/16 checks respectively) predate the final Travel-dialog,
terrain-header and copy polish. They remain historical evidence; the table above
binds the final 109-file source snapshot.
