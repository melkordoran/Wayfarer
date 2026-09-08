# Local Axis development fixture

Wayfarer has an isolated, reproducible Universe/World fixture for testing against the actual Axis protocol. Run these commands from the project root:

```sh
npm run axis:bootstrap
npm run axis:start
npm run axis:status
npm run axis:smoke
npm run axis:stop
```

The underlying commands are `node scripts/axis-bootstrap.mjs`, `node scripts/axis-start.mjs`, `node scripts/axis-status.mjs`, `npx tsx scripts/axis-smoke.ts`, and `node scripts/axis-stop.mjs`.

Bootstrap requires Node 22+, Git, curl, bash and the `sqlite3` command. The fixture scripts currently support macOS and Linux. They install .NET SDK 10.0.400 inside `.runtime/dotnet`, keep NuGet packages and CLI state under `.runtime`, clone pinned source into `vendor`, and compile both servers. No PATH, shell, launchd, or global Git configuration is changed. `--rebuild` republishes the pinned sources. The initial SDK activation performed during development also generated an untrusted ASP.NET development certificate; the committed bootstrap explicitly disables that SDK first-run behavior for future installs.

The services bind only to loopback:

| Service | Address | Purpose |
| --- | --- | --- |
| Universe | `127.0.0.1:16670` | Login, citizen sessions, world discovery |
| World | `127.0.0.1:17000` | Haven property, terrain, avatars and chat |
| Assets | `http://127.0.0.1:17400/` | Original RWX fixture models |

Sign in as **Wayfarer** with password **WayfarerLocal42!**, then enter **Haven**. **Explorer** uses the same development password and provides a second citizen for integration tests. Citizen numbers 2 and 3 are Haven caretakers. These are deliberately public development credentials; the fixture is intended only for local testing. Axis creates its own administrator account on first startup and logs the generated credential; logs are private files under `.runtime/axis/logs`.

The fixture uses the legacy RSA/AES transport to exercise AW 5.2/6.2 interoperability over loopback. Do not expose these listener ports as a public deployment; configure and validate TLS separately for remote use.

Haven starts with 32 original objects, eight simple RWX models, and one flat 128×128 terrain page. `public/assets/haven.json` is the object manifest. It uses centimetres and tenths of degrees, while the client API uses metres and radians. Models use the conventional AW scale of 10 metres per RWX unit. Fixture geometry is CC0 and contains no Active Worlds models, textures, logos, sounds or proprietary SDK binaries.

Bootstrap preserves existing data and refuses to run while its services are active. Stop/start retains builds, terrain and accounts. The stop script verifies each saved PID's full command path before sending SIGTERM; it never signals an unrelated process merely because it occupies a fixture port. Start refuses occupied ports and confirms that Haven actually registered with Universe, not only that the World listener exists.

The smoke test uses two real citizen `AxisClient` sessions and a tourist session with the explicit fixture email `visitor@wayfarer.invalid`. It verifies login, world listing and entry, property and terrain queries, original model downloading, avatar presence and movement, chat delivery, object add/change/delete broadcasts, disconnect cleanup and tourist access. Temporary objects are removed in cleanup. The latest passing result is saved in `.runtime/axis/smoke-latest.json`.

Pinned upstream sources:

| Repository | Commit |
| --- | --- |
| [Universe](https://gitlab.pp16.org/axis/universe_server) | `8ecd16abd46853f91c7af04f07d4d518f465017f` |
| [World](https://gitlab.pp16.org/axis/world_server) | `c3e7486fc153ac31b3df1a07bc2b03d20e348152` |
| [Platform](https://gitlab.pp16.org/axis/platform) | `f18054d5d16e3869d54243788bced30b59cccf05` |

Both server checkouts use HTTPS for submodule checkout through a command-scoped override. Upstream files are unmodified. The fixture seeder links the World project, uses its schema/repository classes, and invokes the existing private world-attribute serializer through reflection because upstream has no public offline save method. It does not patch upstream source or fabricate a replacement server.

Source notices stay intact in `vendor`; those third-party source and runtime directories are not included in Wayfarer's desktop package. Upstream licensing clarification for unmarked files remains a release dependency for redistributing Axis binaries.
