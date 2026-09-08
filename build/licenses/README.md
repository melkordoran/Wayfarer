# Pinned macOS framework notices

Electron 44.2.0 includes Mantle and ReactiveObjC frameworks. Its distributed
`LICENSES.chromium.html` includes Squirrel's notice but omits these two notices.
The files here are byte-identical copies from the framework revisions pinned by
[Electron 44.2.0 DEPS](https://github.com/electron/electron/blob/v44.2.0/DEPS).

| File | Upstream revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `LICENSE.Mantle.txt` | `2a8e2123a3931038179ee06105c9e6ec336b12ea` | 2445 | `285eede6f638adc9c352be7d66134611e5ea95044095a84de9867fb864e66eab` |
| `LICENSE.ReactiveObjC.txt` | `74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76` | 1093 | `095fec1a3d6ad029fe0661fa6092a272d50af016b1771992e0bba9b2a73e7763` |

Exact sources:

- [Mantle LICENSE.md](https://raw.githubusercontent.com/Mantle/Mantle/2a8e2123a3931038179ee06105c9e6ec336b12ea/LICENSE.md), including its Proton/Bitswift notice.
- [ReactiveObjC LICENSE.md](https://raw.githubusercontent.com/ReactiveCocoa/ReactiveObjC/74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76/LICENSE.md).

Squirrel is already covered by the supplied Chromium omnibus. Electron pins
revision `8d808803bc89ec0e2aa1450474856dfee3b00c6b`; its
[complete LICENSE](https://raw.githubusercontent.com/Squirrel/Squirrel.Mac/8d808803bc89ec0e2aa1450474856dfee3b00c6b/LICENSE)
is 1073 bytes (SHA-256 `6f240e244a105d6366bc898ac9c67460624c9052839d4b988c6dbe4c571008b3`).
After decoding HTML entities, normalizing CRLF and trimming surrounding
whitespace, the supplied omnibus entry matches that complete license with
SHA-256 `c72401a39a3e930223e33f2ffe78cc38c51df3dcba6a77d2b45c1b0bf841d345`.
The verifier also checks this entry; no duplicate Squirrel file is needed.

Package both complete files under app resources `licenses/`. These upstream
notices retain their original terms; the Wayfarer root license does not replace
them. `verify-release-notices.mjs` checks both source hashes and packaged bytes,
and requires re-review when the installed Electron version changes.
