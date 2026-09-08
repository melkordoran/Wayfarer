# Disposable Axis integration fixture

The isolated fixture is a separate local testing environment. It never restarts,
logs in to, seeds, or edits the primary `.runtime/axis` Universe, World, or asset
services. Do not use `axis:bootstrap`, `axis:start`, or `axis:stop` to manage an
isolated run: those existing commands target the primary fixture.

## Run and lifecycle

The guarded end-to-end runner is:

```sh
npx tsx scripts/axis-isolated-smoke.ts
```

It uses the exported lifecycle in `scripts/axis-isolated.mjs`:

```ts
import { withIsolatedAxis } from './axis-isolated.mjs';

await withIsolatedAxis(async fixture => {
  // Start has completed: the World has authenticated to this fresh Universe.
  const options = {
    host: '127.0.0.1', port: fixture.ports.universe, tls: false,
    world: fixture.world,
    username: fixture.accounts[0].username,
    password: fixture.accounts[0].password,
  };
  // Connect test clients using these options. Disconnect them in your finally.
  // Never print options: they contain this run's private credentials.
  fixture.writeReport('example', { world: fixture.world });
}); // Stops only this run's owned services, including after a rejected callback.
```

`createIsolatedFixture()` / `prepareIsolatedAxis()` prepares data but starts no
listening servers. Its returned object exposes `start()`, `stop()`,
`verifyPrimary()`, `writeReport(name, value)`, `directory`, `ports`, `objectPath`,
`world`, and the two `accounts`. Type declarations accompany the module.

For preparation alone:

```sh
node scripts/axis-isolated.mjs prepare
```

This command prints only the new directory and ports, not credentials. Its
prepared directory cannot later be attached to or started by the lifecycle:
ownership is intentionally process-local. To run services, create the fixture
and call `start()` in the same process, preferably through `withIsolatedAxis`.
Each fixture can start once; another test run creates another directory.

## Paths, ports, and accounts

Each run uses `mkdtemp` to create `.runtime/axis-isolated-XXXXXX` with mode `0700`.
Configuration, manifests, imports, logs, and reports are written with mode
`0600`. The directory contains:

```text
axis-isolated-XXXXXX/
  universe/       fresh config, citizen/license imports, Universe database
  world/data/     fresh Haven world, attributes, cells, and terrain database
  assets/         copied original assets; no writes to public/assets
  dotnet-home/   private CLI state
  tmp/           private temporary files
  logs/          key/import/seed/startup and service logs
  reports/       primary comparisons, integration results, shutdown results
  manifest.json  private provenance, asset hashes, and fixture credentials
  *.process.json diagnostic process records, never shutdown authorization
```

Default listeners bind only `127.0.0.1`:

| Service | Isolated port | Primary port, prohibited here |
| --- | ---: | ---: |
| Universe | 26670 | 16670 |
| World | 27000 | 17000 |
| Original assets | 27400 | 17400 |

All three assignments must be distinct, valid unprivileged ports and different
from every primary port. Preparation and startup check exclusive loopback bind
availability without connecting to existing services. These checks cannot
reserve ports across the subsequent process spawn. Readiness therefore also
requires the owned child's fresh ready log and a live child; World readiness
requires its `Started world Haven:` message, not merely an open TCP port. An
occupied port is an error, never permission to terminate its owner.

The two fresh citizens are Wayfarer (2) and Explorer (3), both Haven caretakers.
They receive a newly generated 19-character local login password per run.
Their matching names do not refer to the accounts in the primary Universe.
Tourist access is enabled in this independent Universe. Haven contains 32
original property objects and one flat terrain page from the existing seed.

The run independently generates its Universe key, database password, and World
administration password. It inherits the pinned server's legacy cryptographic
protocol and uses no TLS on these loopback connections. This is a local QA
fixture, not a production hosting or security configuration. Logs may include
generated key or account material; do not publish the private directory or raw
logs without reviewing and redacting them.

## Provenance and original assets

No SDK install, restore, server build, source change, or existing seed-project
change occurs. The runner executes the already-built local `.runtime/dotnet`
runtime and immutable existing DLLs under `.runtime/axis/bin/{universe,world,seed}`.
Only the fresh directories are passed to the existing key/import/seed
entrypoints. Environment variables are restricted so shell-provided Axis
configuration overrides cannot redirect the new services to primary data.

The recorded source pins are:

| Source | Commit |
| --- | --- |
| [Axis Universe](https://gitlab.pp16.org/axis/universe_server) | `8ecd16abd46853f91c7af04f07d4d518f465017f` |
| [Axis World](https://gitlab.pp16.org/axis/world_server) | `c3e7486fc153ac31b3df1a07bc2b03d20e348152` |
| [Axis Platform](https://gitlab.pp16.org/axis/platform) | `f18054d5d16e3869d54243788bced30b59cccf05` |

The preparer checks these against the existing seeded provenance manifest and
records the actual reused DLL hashes. This records the existing build's
provenance; it does not establish a new reproducible-build attestation.

The asset copy is an explicit 29-file allowlist:

- Eight original property RWX models, `haven.json`, and the root license notice.
- Fifteen existing original avatar/catalog/sequence/license files, including
  their ZIP forms and model-path avatar aliases.
- Four existing terrain texture/license files: `terrain0.png`, `terrain1.png`,
  `terrain2.zip`, and `textures/LICENSE.txt`.

Every copied file is hashed. No fixture generator rewrites `public/assets`, and
no avatar or gesture is added to its live catalog. There are no proprietary AW
assets or external asset downloads. The separate HTTP child loads only
hash-matching copied files from the allowlist into a bounded in-memory map. It
refuses traversal, URL/query requests, symlinked files or parent directories,
modified bytes, oversized files, and an excessive aggregate asset set. It
serves GET/HEAD only and never exposes the private config, reports, or databases.

## Ownership and shutdown

Only child handles created by this exact lifecycle instance are eligible for
shutdown. The module keeps ownership in a private in-memory map; a saved,
forged, or stale manifest/PID object cannot authorize `start` or `stop`.

Before a signal, cleanup checks the PID's recorded process birth and complete
command, including the unique isolated working directory or manifest argument.
Reused PIDs, changed commands, and uncertain ownership are preserved and reported
as errors. Cleanup stops World, then Universe, then the isolated asset server.
It requests graceful termination first and escalates only for a still-matching
owned child that does not exit. Concurrent shutdown paths share one cleanup
operation, and a shutdown request cancels further startup.

`withIsolatedAxis` handles SIGINT and SIGTERM by stopping these owned children,
retaining a private interruption report, and exiting the runner. It removes its
signal handlers on normal completion. A caller may register up to eight owned
resource cleanup callbacks with `fixture.registerCleanup(callback)`. They run
once, in reverse registration order, before Axis shutdown, with a ten-second
limit per callback. Failures are retained in the stop report and do not skip
Axis cleanup. Registration does not confer ownership of arbitrary processes:
callbacks must independently limit their actions to resources their caller owns.

SIGKILL, a process crash, or power loss cannot run asynchronous cleanup. If that
happens, inspect the exact diagnostic process identities and unique directory
before any operator-directed cleanup. Do not treat a stale PID file as authority,
and do not use the primary fixture's stop command as a substitute.

## Retention and primary-state evidence

No fixture directory is recursively deleted. Successful, failed, and interrupted
runs retain their data, configs, logs, and reports for inspection. Tiny unit-test
safety directories are also retained under `.runtime`. Nothing here authorizes
cleaning unrelated runtime data.

Before preparation, the runner captures SHA-256 hashes and lengths of primary
Universe/World data and configuration, reused binary files, public assets,
primary PID files, and seeded provenance. It also captures each recorded primary
PID's process birth/command. Comparisons are retained after preparation and
shutdown; `verifyPrimary()` can add a checkpoint during a run. Primary log growth
is excluded, and no primary SQL query is performed for this comparison.

An unchanged report establishes that these captured files and recorded process
identities match across the interval. It does not establish that every transient
state or network event was unchanged. The live primary services can update their
own database/WAL/SHM files or exit autonomously. A changed report therefore names
the drift and explicitly does not attribute causation or restore prior bytes.
Do not turn an uncertain comparison into a claim that the isolated run caused,
or repaired, a primary service change.

Preparation and the safety-helper tests are separate from actual integration
success. Consult the retained integration report and current verification
checkpoint for live-test results; an open port, prepared database, or passing
unit suite alone does not prove the client completed a world visit.

### Verified checkpoints: 7 September 2026

The final v0.6 runs passed **14 standard checks** in
`.runtime/axis-isolated-I0Xtzr` and **15 restricted-profile checks** in
`.runtime/axis-isolated-JhGECF`, including actual failed-lookup recovery and
re-entry. The latter is reproducible with
`npx tsx scripts/axis-isolated-smoke.ts --restricted`. All three probe clients
also pin the exact World endpoint before opening a World transport. The runner
fingerprints `src`, `scripts`, and the two package manifests before preparation
and after the callback; launch from a frozen tree because static imports precede
the first snapshot. Both final runs and the later interactive preview reported
clean owned-service shutdown and unchanged captured primary state. See the
[dated verification record](verification.md) for exact results and boundaries.

The first earlier proof below is retained as historical evidence.

The guarded runner completed **13 of 13 live checks in 6.666 seconds** using the
fresh directory `.runtime/axis-isolated-OuQ76l`. It covered two citizens, authored
environment attributes and original assets, query/terrain, canonical object
mutations and stale-change rejection, positive/neutral gesture observation,
contacts and explicit telegram collection/privacy, reconnect, and tourist entry.
This is the native protocol integration runner, not a browser-rendering claim.

Shutdown reported all three isolated services stopped with no ownership refusals;
their listeners were absent afterward. All **381** captured primary file hashes
and the primary PID/birth/command identities matched the pre-run snapshot. The
private integration and shutdown reports remain in that directory. Separately,
the safety-helper suite passed 32 tests; those tests do not start Axis services.

## Separate interactive browser preview

```sh
npx tsx scripts/axis-isolated-preview.ts
```

This runner prepares and starts another fresh fixture, a private Vite UI at
`http://127.0.0.1:5183`, and a separate bridge on `127.0.0.1:5184`. It does not
touch existing previews on 5173/5174. It prints the UI URL and private directory,
never passwords, and performs no automatic account login. Use the fresh account
credentials from that directory's private manifest and its Universe port, not
the primary Universe. Type `q` and Enter, close stdin, or send SIGINT/SIGTERM to
stop the owned UI/bridge before the owned Axis services. Data and reports remain.

The opt-in bridge allows only the 5183 origin, connections to the configured
isolated `127.0.0.1` Universe port without TLS, World lookups targeting exactly
its independent World listener, and assets from its exact copied HTTP asset
origin. A saved primary/remote connection is rejected before it reaches the
protocol client; every resulting World connection is checked before its transport
opens. Isolated asset requests follow no redirects, omit cookies,
allow at most 16 active requests, and enforce a 1 MB file limit and five-second
request timeout. Ordinary previews retain their existing behavior when isolation
is not explicitly enabled.

Vite uses a cache inside the private run, not the shared default development
cache. It does not load project `.env` files or expose prefixed shell variables
to the QA renderer. Its file-serving allowlist includes only source, public assets,
dependencies, `index.html`, `package.json`, and that specific cache directory.
It does not allow the project or runtime root, primary configuration, isolated
manifests, or reports. The browser visit remains separate evidence from the
protocol runner; launch and verify the preview before claiming real-app QA.

For a separate movement-permission QA profile:

```sh
npx tsx scripts/axis-isolated-preview.ts --restricted
```

This opt-in passes `restrictMovement: true` to preparation. After seeding but
before any server starts, it checks the exact fresh attributes file and changes
only the two validated Boolean bytes for `AllowFlying` and `AllowTeleport` to
false. It retains the original bytes privately and records original/restricted
hashes in the manifest. The default fixture is unchanged. The two citizen
caretakers can still receive the server's caretaker exceptions; tourists can be
used to inspect the effective denied capabilities. This profile never edits
primary or already-running World attributes.

The v0.6 interactive pass in `.runtime/axis-isolated-OLMkG4` verified both tourist
denial and caretaker exceptions through the actual client, including Travel,
flight, entrance, World details, local lighting overrides and failed-lookup
recovery. Private manifest/script requests returned HTTP 403. The UI and all
owned services were stopped afterward; `reports/ui-verification.json` records
the observations without credentials. This does not certify packaged-native
interaction or full historical AW behavior.
