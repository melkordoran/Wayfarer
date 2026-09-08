# Contributing

Wayfarer targets an independently branded AW-style experience on Axis servers.
It is not an official Active Worlds browser or a promise of historical parity.
Please discuss substantial protocol or renderer changes in an issue first.

## Local development

Use the Node version in `.nvmrc` and the committed npm lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:public
npm run desktop
```

Unit tests work from a clean checkout and do not bootstrap or log into Axis.
They retain small safety fixtures in ignored `.runtime` storage. Full fixture
testing is optional and requires additional tools; see
[local Axis setup](docs/axis-development.md) and
[disposable integration testing](docs/isolated-fixture.md).

For live tests, use a fresh disposable fixture and record the exact source
version, scope, result and cleanup. Do not restart, overwrite or repair an
existing world merely to make a test pass. Never point a destructive test at
someone else's universe. Native tests use [fresh QA profiles](docs/native-qa.md).

## Pull requests

- Keep changes focused, with regressions for the behavior they change.
- Preserve canonical server responses, stale-write safeguards, scoped history
  and recoverable drafts. A timeout is not proof that a write failed.
- Parsers need bounded malformed-input tests, original fixtures and explicit
  unsupported-feature diagnostics. Do not hide failures with guessed content.
- Cite primary format/protocol references and preserve third-party notices.
- Do not commit downloaded world assets, proprietary SDKs, server binaries,
  credentials, private conversations, screenshots with personal data, or runtime
  profiles. Original bundled fixture assets have separate CC0 notices.
- Say what was actually tested. Offline, two-client protocol, and native remote
  interaction evidence are different, and Windows packaging is not Windows QA.
- Use the existing formatting conventions and avoid unrelated whole-tree churn.

By submitting a contribution, you confirm you have the right to provide it
under the repository's applicable license, including any separately marked
asset license. No contributor license agreement is required.
