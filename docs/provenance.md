# Source provenance

## Protocol reference

The independent TypeScript implementation reads the behavioral contract exposed by these public sources:

- [Axis Universe](https://gitlab.pp16.org/axis/universe_server), commit `8ecd16abd46853f91c7af04f07d4d518f465017f`.
- [Axis World](https://gitlab.pp16.org/axis/world_server), commit `c3e7486fc153ac31b3df1a07bc2b03d20e348152`.
- [Axis Platform](https://gitlab.pp16.org/axis/platform), commit `f18054d5d16e3869d54243788bced30b59cccf05`.

The server fixture compiles the pinned C# sources unmodified. Those checkouts, NuGet packages, binaries and runtime data are not included in the desktop client package. Most upstream implementation files carry individual MPL-2.0 or CC0 notices, but there are unmarked files and no verified blanket license grant covering every file. Preserve the original notices and resolve unclear licensing before redistributing server binaries; do not infer a repository-wide license merely because the source is public.

No proprietary `aw.dll`, Active Worlds browser binary, retail model, or `aw_sdk_132.h` header is copied into this client.

## Original work

- Wayfarer name, UI, compass icon, Commons procedural geometry and code-generated labels are new work for this project. The working name has not undergone trademark clearance.
- `public/assets/LICENSE.txt` marks the new fixture geometry and textures CC0. It is separate from any Active Worlds object path.
- The bundled studio avatar data is deterministically generated from original Wayfarer rigs and motions by `scripts/axis-avatar-assets.mjs --studio`. Its embedded license dedicates those original assets to CC0; no third-party avatar is redistributed. Studio generation is isolated from the existing live fixture's assets.
- `scripts/directx-fixture-assets.mjs` independently authors CC0 text/binary X geometry, weighted bones, numeric witnesses and a labeled texture. Its separate `--studio` bundle appends the experimental X avatar while preserving the old bundle bytes and avatar ordinals. No Microsoft sample mesh, AW client code or proprietary object-path asset is included.
- Original client code and documentation use the root `LICENSE`; separately marked original assets retain their CC0 dedication. Renderer notices are generated during build. Exact Electron and Chromium notices are explicitly included in packaged resources and checked byte-for-byte. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Format references

Individual parser modules record the primary format sources used. RWX material/transform conventions and AW coordinates were checked against AW documentation; terrain naming and rotation/hole behavior are described in the official [terrain texture guide](https://activeworlds.com/newsletter/1202/120204.html) and [terrain guide](https://www.activeworlds.com/newsletter/0702/070202.html). Where a precise binary layout comes from an independent format author rather than Active Worlds, the source is identified as such, not represented as official documentation.

Reading a public object catalog or format example for interoperability does not grant redistribution rights to its models, textures or animations. Keep real-world content outside the repository unless permission is established.

The X reader uses Microsoft's public file grammar and templates, linked in
[DirectX support](directx-models.md). Historical AW animation/skeleton/CAV facts
are distinguished in [archived primary-source notes](directx-format-research.md).
Animation exporter settings are not treated as proof of universal geometry
scale or handedness. Assimp's original parser source was consulted while
researching the undocumented compressed-body layout; no code was copied or
ported. The independently implemented internal MSZIP path now has bounded
original-fixture coverage; that does not establish historical exporter parity.
