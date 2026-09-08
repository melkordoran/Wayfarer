# Isolated packaged native QA

This is an opt-in launcher for an explicitly selected, supported macOS arm64
package. It does not reuse the user's ordinary Wayfarer profile, perform an
automatic login, or manage an already-running Wayfarer process. No installed
application path is inferred.

```sh
# Fresh independent Axis services and native profile:
npx tsx scripts/axis-isolated-native.ts release/0.12.1-alpha.1/mac-arm64/Wayfarer.app

# Same, with the separate fixture's movement-restriction profile:
npx tsx scripts/axis-isolated-native.ts release/0.12.1-alpha.1/mac-arm64/Wayfarer.app --restricted

# Native offline interaction only: no Axis preparation, import, or listener:
npx tsx scripts/axis-isolated-native.ts release/0.12.1-alpha.1/mac-arm64/Wayfarer.app --offline
```

The selected version must equal the current source/build version. The commands
above describe the current interface, not evidence that a native visit has passed.
Read the current verification checkpoint for actual packaged-test results.

## Before launch

The launcher requires an explicit versioned `Wayfarer.app` under this project's
`release/VERSION/mac-arm64` directory, with real executable/archive paths rather
than symlinks. Before creating a profile or starting Axis, it checks:

- Packaged `package.json` declares `wayfarerNativeQa: 1`, the expected version,
  and the expected production main entry.
- The existing read-only `verify-mac-package.mjs` check passes: bundle/archive/
  source versions agree, the arm64 executable and signature verify, private roots
  are excluded, and archived build files match the current local build bytes.
- The executable and archive hashes remain unchanged immediately before spawn
  and after the native ready receipt.

An older package that ignores profile/QA flags must fail preflight, not be
launched and discovered unsafe afterward. The capability marker and byte
comparison are controlled local QA checks, not a security attestation against
malicious concurrent local package replacement. No signing or rebuilding is
performed by this runner.

## Profile and transport containment

Connected mode uses `withIsolatedAxis`, documented in
[isolated-fixture.md](isolated-fixture.md). Its empty `native-profile` directory
is created with mode `0700` under the fresh fixture. Offline mode creates a
separate `.runtime/native-qa-XXXXXX/native-profile` and does not call Axis setup.
Logs and reports are private and retained in the owning run directory.

The launcher executes `Contents/MacOS/Wayfarer` directly, never `open`, with:

```text
--profile-dir=<absolute fresh native-profile>
--qa-network=<isolated Universe port>,<isolated World port>,<isolated asset port>
```

Offline mode substitutes `--qa-offline`. The supported main process sets
`userData` and `sessionData` before readiness, directs logs/crash dumps inside
the profile, and refuses a reused/nonempty QA profile. Network mode pins all
three independent endpoints; World lookup results are checked before transport
creation and asset redirects are forbidden. Offline mode refuses server
connections and external asset requests. The ordinary application's networking
and profile behavior are unchanged without these explicit QA options.

The runner does not inherit `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `WAYFARER_DEV`,
or unrelated application environment overrides. The QA window is labeled
`Wayfarer · Isolated QA`. No credentials are printed or entered automatically;
connected-mode account credentials remain in the private fixture manifest.

## Runtime receipts and ownership

The app writes `native-startup.json` and `native-ready.json` privately in the
fresh profile, using schema `wayfarer.native-qa/v1`. The launcher requires both
receipts to match its owned PID, package version, exact profile/userData/
sessionData paths, packaged `app.asar` path, `isPackaged: true`, and complete
requested QA endpoint policy. The ready receipt must additionally confirm a
visible window, valid dimensions, and the packaged `dist/index.html` entry.
This verifies native startup, not world login or full UI functionality.

Immediately after spawning, the launcher captures the child's process birth and
complete command. It observes exit throughout startup, so an old or dead app
cannot leave the receipt/interactive wait falsely ready. Process identity and
the exact `--profile-dir` argument are checked again before every signal.
Saved receipts or process records cannot attach to, or authorize killing,
another app instance.

## Finish and retained work

Type `q` and Enter, close stdin, or send SIGINT/SIGTERM to finish. Quitting the
owned native app normally also finishes the visit. Cleanup stops only its
verified child, then the independently owned Axis services in connected mode.
It requests termination first and escalates only while that exact child still
matches. It never kills applications by name or uses a primary fixture stop
command. Closing only the window may leave a macOS app process alive; `q`
finishes the entire owned visit.

Explicit runner termination can discard unsaved **test** drafts. The private
profile, local saved projects/inbox, logs, receipts, and reports remain; no
recursive deletion is performed. SIGKILL or a machine crash cannot execute
normal cleanup. Review exact retained identities before any subsequent
operator-directed cleanup; a stale PID by itself is not authorization.

Connected runs retain the fixture's primary-file/process comparisons. Offline
mode does not start or query primary Axis services and does not claim a separate
primary-profile hash audit. Its containment evidence is the preflight, fresh
profile contract, and verified runtime receipts. Neither mode promises that
unrelated live services or the user's other app instance remain temporally
unchanged on their own.
