# Third-party notices and asset provenance

Wayfarer's root license applies to its original client code and documentation.
Separately marked assets and third-party components retain their own terms.
Wayfarer is not affiliated with or endorsed by Active Worlds. The working name
has not undergone trademark clearance.

## Bundled desktop components

The npm lockfile pins the versions used for a build. Renderer notices are
generated during `npm run build` as `dist/third-party-licenses.txt`, and the
complete file is included in the application archive.

| Component | Version at this release | License / notice location |
| --- | --- | --- |
| fflate | 0.8.3 | MIT, generated renderer notices |
| lucide-react | 1.41.0 | ISC plus the included Feather icon MIT notice |
| React / React DOM | 19.2.8 | MIT, generated renderer notices |
| scheduler | 0.27.0 | MIT, generated renderer notices |
| Three.js | 0.185.1 | MIT, generated renderer notices |
| Electron | 44.2.0 | MIT, `licenses/LICENSE.electron.txt` in app resources |
| Chromium and Electron's bundled third parties | As shipped by Electron 44.2.0 | Full upstream `licenses/LICENSES.chromium.html` in app resources |
| Mantle, including its Proton-derived notice | Electron 44.2.0 DEPS pin | Full `licenses/LICENSE.Mantle.txt` in app resources |
| ReactiveObjC | Electron 44.2.0 DEPS pin | MIT, `licenses/LICENSE.ReactiveObjC.txt` in app resources |

Electron/Chromium notices are copied byte-for-byte from the installed Electron
distribution. The root `LICENSE` and this notice are also included in the app
archive. Package verification checks those bytes; keep all notices when
redistributing the app. Build-tool dependencies retain their individual notices
in their npm packages. The MIT-licensed `ws` dependency is used by the optional
development preview bridge, not by the packaged desktop main process.

Mantle and ReactiveObjC are macOS frameworks included by Electron. Their full
notices are supplied separately from the exact upstream revisions pinned by
Electron; see [framework notice provenance](build/licenses/README.md). Updating
Electron requires reviewing those revisions and their notices again.

## Original fixture content

The original Commons geometry, generated avatar rigs/motions, fixture RWX/X
assets and textures have the CC0 dedication stated in their asset notices:

- `public/assets/LICENSE.txt`
- `public/assets/avatars/LICENSE.txt`
- `public/assets/textures/LICENSE.txt`
- `tests/fixtures/directx/directx-LICENSE.txt`
- The embedded notices in the deterministic fixture generators and archives

No proprietary Active Worlds browser, `aw.dll`, SDK header, retail asset or
Microsoft sample mesh is included. Loading content from a world does not grant
permission to redistribute it. Keep authorized real-world QA content outside
the source repository and published releases.

## Axis protocol references — not redistributed server software

The client implementation uses the public behavioral contracts of these pinned
references:

- [Universe](https://gitlab.pp16.org/axis/universe_server): `8ecd16abd46853f91c7af04f07d4d518f465017f`
- [World](https://gitlab.pp16.org/axis/world_server): `c3e7486fc153ac31b3df1a07bc2b03d20e348152`
- [Platform](https://gitlab.pp16.org/axis/platform): `f18054d5d16e3869d54243788bced30b59cccf05`

Optional fixture scripts fetch and build those sources locally. Their checkouts,
submodules, .NET SDK, NuGet packages, server binaries and data are excluded from
this repository and release assets. Pinned upstream files carry mixed MPL-2.0,
CC0 and unmarked notices; no blanket license grant has been verified for every
file. Wayfarer's license does not relicense those sources. Resolve the upstream
rights and corresponding obligations before redistributing an Axis server.

Additional primary format references are recorded in
[source provenance](docs/provenance.md) and the parser documentation.
