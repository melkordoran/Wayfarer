# Original DirectX fixtures and isolated integration

This is an independent original-content test slice, not a claim of full legacy
ActiveWorlds/DirectX compatibility. The final frozen v0.9 checkpoint below
records the dedicated live run and three regression runs after the
studio-only presentation correction. Earlier candidate evidence is separate. No primary servers,
databases, asset catalogs or pinned DLLs are modified by fixture preparation.

## Original fixture content

`scripts/directx-fixture-assets.mjs` imports without filesystem or process side
effects. Its positive map contains 16 files: an asymmetric concave marker and a
132-vertex, 16-bone skinned figure in text, binary32 and binary64; matching
single-member ZIPs; an original 32-pixel labeled-corner PNG; a CC0 notice; and a
catalog overlay retaining RWX indices 0/1 and appending the X figure at index 2.
Ten separately labeled negative/compatibility/warning probes are never included
in a served profile. Microsoft/AW sample models or textures are not copied.

Text and binary encoders independently consume authored typed records. The
binary emitter uses little-endian WORD token IDs, DWORD counts and documented
DWORD string terminators, plus independently serialized skin-template UUIDs.
The separate WORD-terminator probe exercises an explicitly distinguishable
compatibility case; it does not redefine the normative format.
[Microsoft token records](https://learn.microsoft.com/en-us/windows/win32/direct3d9/token-records),
[tokens](https://learn.microsoft.com/en-us/windows/win32/direct3d9/tokens).

The fixtures use right-handed, +Y-up source coordinates. Their own authoring
convention is one source unit per metre; successful tests do **not** establish
historical AW geometry-scale parity. Skin offsets and per-bone vertex weights
follow the documented mesh-to-bone contract.
[Microsoft SkinWeights](https://learn.microsoft.com/en-us/windows/win32/direct3d9/skinweights).

Numerical oracles include nested noncommuting transforms, a concave polygon of
area 2, exact bind-pose invariance and genuinely blended elbow vertices. The
weighted witness moves from `(0.32,1.05,0.18)` to `(0.32,1.085,0.215)` after a
90-degree local elbow rotation, then returns exactly to neutral within floating
point tolerance. Tests also check independent Skeleton/Bone/geometry ownership.
The original external Wave/Walk/Bow SEQs are separate from embedded `.x`
AnimationSet playback, which is currently warned about rather than played.

Explicit fixture generation is confined to a new `tests/fixtures/directx[-name]`
directory. Existing modified files are preserved. `--check` is read-only:

```sh
node scripts/directx-fixture-assets.mjs --output=tests/fixtures/directx --check
node scripts/directx-fixture-assets.mjs --studio --check
```

The separate six-file `studio-directx-data.json` overlay contains only the X
avatar, its texture/license and a Wave/Bow-preserving catalog pair. It merges
with the unchanged 17-file original studio bundle into 21 exact synthetic URLs.
No fetch/network fallback occurs, and the old public and studio generator
checks remain unchanged. Offline native QA needs no relaxed network policy.
The studio figure uses an identity parent so it is centered and faces forward;
the separately served diagnostic figure retains its translated Y90 stress
transform. Only that root matrix differs: weighted geometry, joint rests,
inverse offsets and external gestures remain identical. Studio pose oracles are
therefore expressed directly in authored source space, not in the diagnostic
parent's transformed space.

## Opt-in disposable profile

`createIsolatedFixture({assetProfile:'directx'})` keeps the baseline 29 copied
files unchanged except for the fresh catalog pair and adds 14 original files,
for 43 allowlisted files. The merge happens in memory **before** initial private
`wx` writes; no running fixture is modified. Omitted `assetProfile` retains the
baseline byte map. Existing 64-file, 1 MB-per-file, 10 MB-total bounds remain.

The profile reuses the same immutable pinned seed/server DLLs and new accounts
and databases owned by the existing [isolated lifecycle](isolated-fixture.md).
The server serves only hash-matching manifest entries. No arbitrary directory
or downloaded object-path content enters the profile.

The explicit source-freeze/run gate uses:

```sh
npx tsx scripts/axis-isolated-directx-smoke.ts
```

The runner takes no external endpoint/account/path arguments. It verifies the
advertised isolated object path, exact original catalog/assets, all six raw/ZIP
model encodings and CPU factory bind/pose oracles. Two newly seeded accounts
select avatar 2 and explicitly observe positive and neutral gesture updates.
A newly added `.x` property is deleted only from an exact owned canonical
snapshot; unknown, changed or uncertain state is reported instead of blindly
deleted. The original 32 properties must remain intact.

Universe and resolved World transports are confined to their own loopback
fixture ports. Asset requests use the same strict nativeQA target policy,
`redirect:'error'`, `credentials:'omit'`, a 5-second timeout and 1 MB response cap.
Unit tests verify that primary/remote/query/credential URLs never reach fetch
and that redirect responses fail. A live asset fetch is not itself evidence of
a redirect hop being attempted or of GPU shader/visual correctness.

The private `reports/directx-integration.json` records checks, exact asset
hashes, numeric geometry results, cleanup/uncertainty and before/after source
fingerprints covering `src`, `scripts` and package manifests. Static imports
precede the first fingerprint, so this is source-stability evidence, not module
attestation. Existing lifecycle reports compare captured primary files and
PID/birth/command identities and stop only directly owned child processes.
All fixture artifacts are retained.

## Final frozen v0.9 checkpoint — 7 September 2026

These four sequential runs followed the studio-only identity-root correction.
They passed **50/50** checks against the same 116 captured source/script/package
files, with no in-run drift; an independent current-source rehash matched all
116 entries. The unchanged diagnostic profile still exercises its nonidentity
root, while focused studio tests verify the separate identity-root bundle.
Times below are UTC; durations measure integration callbacks, not preparation
and shutdown.

| Run | Retained directory under `.runtime` | Checks | Duration | Timestamp |
| --- | --- | --- | --- | --- |
| DirectX profile | `axis-isolated-os1i70` | 9/9 | 8,512 ms | 09:06:31.484Z |
| Baseline regression | `axis-isolated-XKXVQG` | 15/15 | 6,814 ms | 09:06:43.974Z |
| Restricted movement | `axis-isolated-s7lxQ7` | 16/16 | 6,796 ms | 09:06:57.785Z |
| Terrain regression | `axis-isolated-R0eGxd` | 10/10 | 805 ms | 09:07:05.725Z |

Report filenames are `reports/directx-integration.json`, `reports/integration.json`
for baseline/restricted, and `reports/terrain-integration.json`. The DirectX run
verified 15 asset hashes and 12 raw/ZIP geometry paths; its temporary/unexpected
IDs, cleanup failures and unexpected errors were empty, with no uncertain
mutation. Baseline/restricted also left no temporary properties. Terrain values
were restored: the original zero page advanced from sequence 128 to 135 and four
new zero pages remained at sequence 2, with no cleanup failures or unexpected
errors. This does not claim database-byte identity.

All 381 captured primary file hashes and three PID/birth/command identities
matched before/after every run and in the agent's immediate post-run recheck.
Every stop report lists World, Universe and assets stopped, with no refused
signals or cleanup errors. All following owned PIDs were absent afterward, and
no listeners remained on 26670/27000/27400. Exact birth/command identities are
retained in each private process record. These are captured-state comparisons,
not observation of every possible transient external change.

A later root audit at **11:50 UTC / 07:50 local** still matched all 116 current
source fingerprints, 380 primary files and all three process identities, but
found the primary `universe.db` had changed since those run-window snapshots.
Its recorded modification time was **11:27:04.686Z**, over two hours after the
last isolated run stopped. The file remained 122,880 bytes; SHA-256 changed from
`b217189820c7e965660572ba08f7d3f5fb24125c91c1baf77d6ce68a2fdc234a`
to `969a321a457acb9a176194d614bb2418f08cc38fb84438adac57f7c34cdbdfd1`.
The cause was not established, and no repair, overwrite or primary restart was
performed. The in-run preservation results remain dated evidence, not a claim
of continuous primary byte identity afterward. All 12 isolated child PIDs were
still absent and the three fixture ports had no listeners in that later audit.

| Run | Universe PID | World PID | Asset PID |
| --- | --- | --- | --- |
| DirectX | 96432 | 96443 | 96421 |
| Baseline | 96625 | 96636 | 96614 |
| Restricted | 96821 | 96832 | 96810 |
| Terrain | 97015 | 97026 | 97004 |

The focused fixture/studio/lifecycle set passed 87 tests in four files and
typecheck passed before the freeze. Reproducibility checks verified all 26
diagnostic fixture files, six new studio overlay entries, 15 unchanged original
public avatar assets and 17 unchanged old studio bundle entries. Live checks
verify numerical and transport behavior, not GPU presentation; native visual
evidence is recorded separately in [verification](verification.md).

## Pre-studio-presentation v0.9 evidence — 7 September 2026

These successful runs precede the later studio-only identity-root correction
and are historical checkpoint evidence, not fingerprints of the final corrected
renderer source. The final corrected-source rerun is recorded above.
The four runs were sequential, with no overlapping listeners on loopback
26670/27000/27400. Durations are report integration-callback durations, not total
preparation/shutdown time. Timestamps are UTC (local EDT is four hours earlier).

| Run | Retained directory under `.runtime` | Checks | Duration | Timestamp |
| --- | --- | --- | --- | --- |
| DirectX profile | `axis-isolated-93SDYt` | 9/9 | 8,507 ms | 09:00:03.151Z |
| Baseline regression | `axis-isolated-8RCovF` | 15/15 | 6,860 ms | 09:00:16.518Z |
| Restricted movement | `axis-isolated-rD4MZO` | 16/16 | 6,866 ms | 09:00:31.043Z |
| Terrain regression | `axis-isolated-NkZLem` | 10/10 | 509 ms | 09:00:46.970Z |

Reports are respectively `reports/directx-integration.json`,
`reports/integration.json` for both ordinary profiles, and
`reports/terrain-integration.json`. Each directory also retains its private
`stop-*.json`, primary-comparison reports and owned `*.process.json` identities.

The DirectX run verified 15 exact fetched asset hashes and 12 raw/ZIP geometry
paths through the production decoder/parser/factory. Both new accounts selected
X avatar 2 and separately observed positive/neutral gesture updates; the real
external Wave loaded and reset the weighted figure. The live catalog remains
Wave-only, whereas the separate offline studio catalog provides Wave and Bow.
The canonical X property was removed and both clients retained exactly the
original 32 properties. Remaining IDs, cleanup failures and unexpected errors
were empty; no add outcome remained uncertain. These numerical/transport checks
do not independently prove GPU visuals or historical AW scale/rendering parity.

Every run captured the same 116 source/script/package fingerprints with no
in-run drift. An independent post-run comparison matched the then-current 116 files.
All 381 captured primary file hashes and three primary PID/birth/command
identities matched before/after every run and in an independent current-state
recheck. This is captured-state evidence, not observation of every possible
transient external change.

All four stop reports list World, Universe and assets stopped, with no refused
signals or cleanup errors. The following exact owned PIDs were absent afterward;
birth timestamps and full executable/working-directory identities remain in each
private process record. No listeners remained on the three fixture ports.

| Run | Universe PID | World PID | Asset PID |
| --- | --- | --- | --- |
| DirectX | 88421 | 88432 | 88410 |
| Baseline | 88637 | 88648 | 88626 |
| Restricted | 88834 | 88845 | 88823 |
| Terrain | 89039 | 89050 | 89028 |

The baseline/restricted runs left no temporary property IDs. Terrain restoration
returned every height/texture blob to its original zero value: the original
page advanced from sequence 128 to 135, and four newly allocated zero pages
remained at sequence 2. Thus terrain values—not database bytes, page allocation
or sequence history—were restored. The existing
[terrain audit limitations](terrain-integration.md) still apply.
