# Releasing Wayfarer

Publish prereleases until the compatibility and native release gates are met.
Do not publish the optional Axis servers, third-party world content, private QA
profiles or raw logs. GitHub's source archives should contain only audited
source, documentation and original fixtures.

## Verify a frozen tree

```sh
npm ci
npm run verify:public
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Record the exact commit and results in the public verification summary. Use
private ignored storage for raw reports. Run applicable fresh disposable Axis
checks and native QA separately; CI does not log in to a world or redistribute
the fixture. Follow [native QA](native-qa.md) and keep every old package intact.

## Package on macOS Apple Silicon

For the current public alpha:

```sh
npx electron-builder --mac dir --arm64 -c.directories.output=release/0.12.1-alpha.1
node scripts/verify-mac-package.mjs release/0.12.1-alpha.1/mac-arm64/Wayfarer.app 0.12.1-alpha.1
npx tsx scripts/axis-isolated-native.ts release/0.12.1-alpha.1/mac-arm64/Wayfarer.app --offline
```

Use a new output directory. The verifier checks architecture, ad-hoc signature,
version, current build bytes, excluded private roots and bundled notice bytes.
Never label an ad-hoc build as Developer ID signed or notarized.

After the owned QA app has exited, create a versioned ZIP with macOS `ditto`
using `--sequesterRsrc --keepParent`, retaining the app bundle's metadata. Generate
SHA-256 checksums for the distributable ZIP, inspect its entries, and test the
extracted app with the read-only verifier. Upload only that reviewed ZIP and its
checksums to a prerelease tied to the verified source tag. Source archives are
provided by GitHub automatically. Do not upload `release/` wholesale.

Check CI on the published commit, confirm repository visibility and tag target,
and verify each uploaded asset's digest and size. If an artifact changes, use a
new version; do not silently replace a published binary.

Native Windows/installer QA and Developer ID signing/notarization are separate
gates. The current release does not supply unverified Windows or Linux binaries.
