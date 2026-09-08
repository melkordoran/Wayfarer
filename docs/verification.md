# Alpha verification

These results apply to the exact named source/build and test environment. They
do not establish official Active Worlds compatibility, arbitrary-world fidelity
or a security certification. Raw profiles, private connection details and local
service records are intentionally excluded from the public repository.

## Public prerelease: 0.12.1-alpha.1

This is a release-packaging revision of the v0.12.0 development milestone.
It adds public-source hygiene, clean-checkout testing, CI, bundled license
verification and release guidance. It does not claim new historical rendering or
protocol compatibility. Current prerelease validation results are recorded in
the GitHub release notes and CI for the corresponding source commit.

On 8 September 2026, the final public source passed **2,498 tests in 103
files** on macOS Apple Silicon with Node 22.22.2. TypeScript, the production
build, the desktop runtime dependency guard and the public-source privacy gate
passed. The production dependency audit reported zero vulnerabilities. These
checks are not a packaged-native or live-server test of the public version.
A separate clean source checkout reproduced all 2,498 tests, TypeScript, build,
runtime and public-source checks after `npm ci`, without copying installed
dependencies, server software, build outputs or private runtime data.

### Final packaged offline check

The macOS arm64 Electron 44.2.0 bundle matched all 38 production build files,
passed strict/deep ad-hoc signature verification and included ten byte-verified
notice files, including the pinned macOS framework licenses. Its `app.asar`
SHA-256 is `780df1885d19c704d88622adb5526d3583b47124f4569a81c26d24d629f51497`.

A fresh isolated native profile displayed version **0.12.1-alpha.1** and The
Commons with 57 objects at 60 FPS. The targeted check exercised mouse capture
and Esc release, the Build keyboard shortcut, original cube addition, a lone
minus remaining an unapplied draft, completion to -1.5, Apply, Undo to 0 and
Redo to -1.5, keyboard Local-axis selection and visible move handles. The
58-object test studio remained private. This check did not repeat the earlier
drag-math matrix or establish connected-native compatibility.

The app quit normally with an empty application log; owned cleanup reported no
failures. The offline policy blocked server connections and external assets.
No Axis service was started, no login was performed, and no live world was
modified. Profiles and screenshots are retained privately, not released.

## v0.12.0 development milestone — 7 September 2026

### Automated checks

- **2,427 tests in 101 files** passed on macOS Apple Silicon with Node 22.22.2.
  TypeScript, production build and the desktop runtime dependency guard passed.
- **77 real-ray transform tests** covered world/local arrows, planes and rings,
  compound YXZ orientations, camera-aligned rotation, canonical handoff,
  cancellation, action-scale immunity and primary-selection changes.
- **38 character-by-character numeric-draft tests** and two App integration
  tests covered signed/fractional input, incomplete numbers, bounds, conflict
  recovery and canonical acceptance. Incomplete input cannot submit zero.
- Four fresh disposable Axis runs passed **48 checks**:

  | Suite | Checks | Scope |
  | --- | ---: | --- |
  | Local-frame transform/history | 8 | Independent scalar math oracle, two-client canonical results, stale rejection and Undo/Redo |
  | Baseline | 15 | Entry, properties, assets, chat/presence and mutation flows |
  | Restricted movement | 16 | Tourist/caretaker movement and permission boundaries |
  | World settings | 9 | All 70 typed editable attributes, observers, denial and guarded restoration |

  All four runs used identical source fingerprints. The transform test performed
  20 canonical mutations on two owned additions, restored original transforms
  and removed only exact known test objects. Original fixture properties stayed
  unchanged. The settings test restored its original 4,256 attribute bytes
  exactly. All owned fixture processes exited, cleanup had no errors, and the
  existing local fixture's 381 protected files and process identities were
  preserved. These are disposable-test results, not current server health.

### Packaged offline native check

An exact-byte verified Electron 44.2.0 arm64 development bundle was launched
with a fresh private QA profile. Its offline policy refused server connections
and external asset requests. The check exercised:

- A lone minus retained as a draft, disabled Apply/axes, and typed completion
  into negative coordinates and rotations.
- Real primary-local X movement with 0.5 m relative snap and compound authored
  pitch/yaw/roll, checked against the expected quaternion displacement.
- A real local X ring drag with 15° snapping, verified as a −75° increment, then
  Undo and Redo restoring the expected authored orientation.
- A 58-object private studio group's signed fractional offset/rotation, Apply
  and Undo, with the test cube restored to its pre-group displayed transform.
- Keyboard axes selection, text-editing shortcut guards, compact toolbar layout,
  visible focus indication and scrollable inspector.

The owned application quit normally; logs were empty and the profile was
retained privately. No native login, remote-server mutation or GUI deletion
occurred. Offline native checks and the separate two-client protocol checks must
not be described as connected-native handle verification.

## Remaining release gates

- Native held-drag cancellation and connected handles, caretaker editor and
  terrain interaction need broader end-to-end coverage.
- CAV, historical units/reference-space conventions, unsupported rig transforms,
  full actions/physics, immediate gesture retrigger and broad licensed-content
  compatibility remain incomplete.
- Large-world memory/render/collision profiling, surface/object snapping,
  continuous terrain brushes and persistent history remain open.
- Native Windows/installer testing, full accessibility review and Developer ID
  signing/notarization have not been completed. Ad-hoc signature verification is
  not notarization or Gatekeeper approval.

## Reproduce

Start with `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and
`npm run verify:public`. Use [disposable fixtures](isolated-fixture.md) for
server checks and [fresh native profiles](native-qa.md) for UI checks. Record
the exact source commit, app version, environment, checks, limitations and
cleanup. Never publish raw credentials, private addresses, caches or QA profiles.

See [compatibility](compatibility.md), [source provenance](provenance.md) and
[the release checklist](releasing.md).
