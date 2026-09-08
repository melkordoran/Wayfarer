# Wayfarer

An independent desktop client for **Axis virtual worlds**, inspired by the feel
and capabilities of Active Worlds 5.2/6.2. Explore, chat and build together—or
create locally in the original offline world, **The Commons**.

**Development alpha.** This is not an official Active Worlds browser or a
drop-in replacement for every AW feature, exporter or world. Read the
[compatibility limits](docs/compatibility.md) before using important content.

## Try it

Public prereleases and checksums are available from
[GitHub Releases](https://github.com/melkordoran/Wayfarer/releases).
The initial binary targets **macOS Apple Silicon**. It is ad-hoc signed, not
Developer ID signed or notarized; macOS may block it. Verify the published
checksum and source before deciding whether to trust a development build.
Windows and Linux source/build configuration exist, but no native support or
installer-quality claim is made for those platforms yet.

To run from source, use Node **22.22.2** (see `.nvmrc`) and npm:

```sh
git clone https://github.com/melkordoran/Wayfarer.git
cd Wayfarer
npm ci
npm run build
npm run desktop
```

The Commons opens without an account. A connected world requires an authorized
Axis universe account or permitted tourist access and a working HTTP(S) object
path. Use trusted universes; this alpha's parser and networking limits are not
a formal security audit. For remote deployments, use certificate-validated TLS.

## Explore and build

- **WASD** walks; right-drag looks; double-click captures the mouse; **Esc**
  releases it. **F** toggles flying, **T** opens Travel, and **F1** shows help.
- **B** opens building tools. Shift-click selects multiple objects, up to 256.
  Move/Rotate handles offer World or primary-object Local axes, relative/grid
  snapping and one undoable batch per released drag.
- Inspector positions and rotations preserve signed/fractional text. Incomplete
  values remain drafts and cannot be applied. Gold bounds identify the primary
  object; teal bounds identify other selected objects.
- Undo/Redo records accepted canonical properties, not optimistic previews.
  Server edits are not atomic transactions; uncertain writes are never blindly
  retried. Back up important worlds and local projects.
- **Project** provides local autosave, import/export and explicit studio restore.
  Undo history remains session-scoped. **Build → Terrain** edits bounded height
  and texture selections with preview and canonical readback.
- **G** opens gestures. Citizen contacts and telegrams use explicit consent and
  manual retrieval. Local inbox files are not encrypted at rest.

See [building](docs/building.md), [3D handles](docs/build-tools.md),
[terrain](docs/terrain-editor.md), [gestures](docs/gestures.md),
[navigation](docs/navigation.md), and [social/privacy limits](docs/social-protocol.md).

## Current coverage

The alpha includes citizen/tourist entry, world discovery, streamed properties,
chat and avatar presence, travel/bookmarks, local projects, a scene-derived model
browser, scoped building history and a guarded caretaker world-settings editor.
Rendering supports RWX and experimental text/binary/MSZIP DirectX assets, original
avatar rigs, external motions, terrain and basic world lighting/water.

It does **not** establish complete historical AW compatibility. CAV, full action
and physics behavior, some legacy units/reference-space conventions, large-world
performance, native connected-workflow coverage, accessibility and release
signing remain open. See [verification](docs/verification.md),
[compatibility](docs/compatibility.md) and [the changelog](CHANGELOG.md).

## Development and tests

```sh
npm run typecheck
npm test
npm run build
npm run verify:public
npm run dev          # Vite UI :5173 and loopback preview bridge :5174
npm run desktop:dev  # native shell using the running development UI
```

Unit tests work from a clean checkout without .NET, Axis servers or an account.
They create small ignored safety fixtures under `.runtime`. The packaged app
connects through narrow Electron IPC and does not need the development bridge.

Optional real-server testing uses pinned upstream sources fetched separately:
[Axis fixture setup](docs/axis-development.md),
[disposable integration tests](docs/isolated-fixture.md), and
[isolated native QA](docs/native-qa.md). Fixture accounts are deliberately public,
loopback-only test accounts; never reuse their credentials on a real deployment.
The fixture is not a public server installer, and its source/binaries/data are
not included in this repository or release assets.

## Project map

| Path | Purpose |
| --- | --- |
| `src/main/protocol` | Independent Axis codec, transport and session client |
| `src/main` | Sandboxed desktop shell, IPC and bounded asset fetching |
| `src/shared` | Typed contracts, validation and coordinate conventions |
| `src/renderer` | React UI, projects, history, chat and world workflows |
| `src/renderer/engine` | Three.js scene, assets, RWX/X, terrain and avatars |
| `scripts` | Optional fixtures, packaging and verification tools |
| `public/assets`, `tests/fixtures` | Original, separately licensed test content |
| `tests` | Protocol, parsers, UI, lifecycle and security regressions |

Contributions are welcome: see [CONTRIBUTING](CONTRIBUTING.md).
Report vulnerabilities privately using [SECURITY](SECURITY.md), not public
issues. Release maintainers should follow [the release checklist](docs/releasing.md).

## License and provenance

Original client code and documentation are [MIT licensed](LICENSE). See
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) for dependency licenses and separately
CC0-dedicated original assets. No proprietary AW browser, `aw.dll`, SDK header
or retail content is bundled. Axis source references and redistribution limits
are recorded in [provenance](docs/provenance.md).

Wayfarer is not affiliated with or endorsed by Active Worlds.
