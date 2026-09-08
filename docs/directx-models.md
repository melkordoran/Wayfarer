# DirectX model compatibility

Wayfarer's experimental `.x` path is an independent implementation, not an
Active Worlds renderer or SDK port. It supports a bounded geometry subset and
retains visible warnings for unverified or unsupported behavior.

## What loads

- X headers `0302` / `0303`, text or little-endian binary, with 32- or 64-bit
  numeric records. Outer ZIP and GZIP packaging and internal MSZIP `tzip` / `bzip`
  are supported; legacy `cmp` remains rejected. See [compression validation](directx-compression.md).
- Nested frames and affine transforms, polygon meshes (including concave faces),
  independent face-normal indices, UVs, indexed RGBA vertex colors, diffuse,
  specular, emissive and opacity material fields, and texture basenames.
- Named or UUID material references, including references carrying both
  identifiers. Conflicting or unresolved identities are rejected.
- `SkinWeights` with explicit bone-offset matrices and up to four positive
  influences per vertex. Every vertex in a weighted mesh must have weights
  summing to one within a small numeric tolerance; excess influences are not
  silently discarded. Each rendered instance owns its skeleton and GPU data.
- Avatars can use external binary SEQ/AWSQ or catalog-referenced X animation
  through documented AW joint names and aliases. X supports text/binary, internal
  MSZIP, quaternion/translation and decomposable matrix keys in one AnimationSet.
  Arbitrary skeleton retargeting is not inferred. Loading geometry never starts
  an embedded animation automatically. See [motion behavior and limits](directx-animation.md).

An explicit `piece.x` stays DirectX-specific; `piece.rwx` stays RWX-specific.
Bare `piece` and `piece.zip` retain automatic ZIP → RWX → X lookup. The model
library preserves that distinction in previews, placement, favorites and recent
choices. Existing saved explicit `.rwx` references are not silently migrated.
Archives must contain exactly one matching basename/format; ambiguous archives,
traversal-like names and filename/header disagreement are rejected.

## Coordinate and visual boundaries

The CPU parser preserves authored coordinates and matrices. The current
renderer uses an identity basis and **one source unit per metre**. This is an
explicit provisional Wayfarer policy, not proof of universal historical AW
geometry units or handedness. In particular, `.x` data is not scaled by RWX's
tenfold unit conversion. The retrieved official animation-exporter preset is
right-handed and Y-up; its scope does not establish every geometry exporter's
convention. See [the primary-source research notes](directx-format-research.md).

Materials use Three.js Phong lighting and the existing decoded texture path.
This preserves the listed source fields but is not pixel-exact legacy lighting,
gamma, alpha sorting or shader fidelity. Texture names must be plain basenames:
embedded paths/URLs are warned about and are not fetched. A malformed or
unsupported avatar uses an original fallback; the avatar dialog exposes the
current loaded/fallback state and compatibility notes.

Static world/preview/environment geometry stays in its bind pose. CAV's XML
assembly, body deformation, layered textures, permissions and presets are a
separate feature set, not implemented by accepting an `.x` mesh. Other open
items include password-protected assets, COB, custom vertex declarations
(`DeclData`/`FVFData`), sheared animated-joint bind transforms, nonuniformly scaled,
sheared or reflected internal skin ancestry/offset matrices, generic retargeting,
animated scale, spline translation and automatic embedded AnimationSet playback.

## Resource limits and evidence

The parser bounds downloaded/expanded data at 30 MB, token work at two million,
frame depth at 128, frames at 1,024, meshes/materials at 4,096, source vertices at
250,000, faces at 250,000 and total face corners at one million (normal faces
also count). Skin bone declarations are limited to 256 per mesh even when they
contain no weights. Rendering has a separate expanded-vertex budget; preview
and environment sessions retain their stricter resource limits.

[`directx-fixture-assets.mjs`](../scripts/directx-fixture-assets.mjs) authors
original CC0 asymmetric, concave, textured and weighted figures. Its text and
binary writers independently consume authored records; neither uses the parser
to generate its input. Numeric witness points cover nonidentity parents,
inverse bind matrices, blended elbow vertices and separate avatar instances.
Fixtures and test results establish behavior for those original assets, not
licensed real-world content or retail AW 5.2/6.2 parity.

The parser was implemented from Microsoft's public [X-file format reference](https://learn.microsoft.com/en-us/windows/win32/direct3d9/dx9-graphics-reference-x-file-format),
[binary token records](https://learn.microsoft.com/en-us/windows/win32/direct3d9/token-records),
[data-reference grammar](https://learn.microsoft.com/en-us/windows/win32/direct3d9/dx9-graphics-reference-x-file-textencoding-data)
and [SkinWeights semantics](https://learn.microsoft.com/en-us/windows/win32/direct3d9/skinweights).
No Microsoft sample geometry, proprietary AW client, SDK DLL or retail asset is
included. Actual automated, native and connected test coverage is recorded
separately in [verification](verification.md); support descriptions here are not
a claim that every workflow has already received native QA.
