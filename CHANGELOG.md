# Changelog

## 0.12.1-alpha.2 — public prerelease

The alpha.1 source tag is preserved, but its binary release was held after
Linux CI exposed platform-dependent generated-fixture checks. The corrected
public release uses a new version and tag; no published artifact is replaced.

- Keep MSZIP test chunks inside the format's size bound across native zlib
  versions, with independent exact-boundary and input/output-budget tests.
- Preserve original animation fixture streams independently of host compressor
  output; validate authored-body hashes and every independently inflated chunk.
- Original Studio asset bytes and runtime decoder/security limits are unchanged.

## 0.12.1-alpha.1 — initial public source candidate

Public-release preparation of the tested v0.12.0 development milestone.

- Public-safe documentation, contributor guidance and private security reporting.
- Clean-checkout unit-test setup and least-privilege, commit-pinned GitHub CI.
- Complete Electron/Chromium and client license notices in packaged apps, with
  byte-level verification.
- Public-tree checks for private files, credentials, paths and oversized content.
- Production source maps excluded; runtime profiles and optional servers remain
  local and are not release assets.

Retains v0.12's primary-local building axes, relative snapping, group rotation,
canonical Undo/Redo and signed/fractional inspector drafts. Also includes the
earlier caretaker settings editor, bounded terrain editing, RWX and experimental
DirectX rendering/animation, world chat/presence, travel and offline projects.

This is a development alpha. Native connected-workflow coverage, legacy-content
fidelity, full actions/physics, accessibility, native Windows testing and release
signing/notarization remain incomplete. See [verification](docs/verification.md)
and [compatibility](docs/compatibility.md).

## 0.12.0 — local development milestone

- World and primary-local move/rotate tools, relative local snapping and shared
  group pivots based on authored YXZ rotations.
- Corrected camera-aligned local rotation handles and preserved canonical history.
- Fixed character-by-character negative and fractional inspector input.
- Recorded 2,427 automated tests, 48 disposable Axis checks, and a separate
  offline macOS native interaction pass on 7 September 2026.

Earlier development checkpoints were local-only and are not public releases.
