# World environment

Network worlds now default to **World lighting**. Their ambient and directional light, six sky colors, fog switch/range and viewing distance come from the server. The viewport lighting button cycles through world lighting and three explicitly local presets. Preferences also offers **Follow the world's lighting**. These choices do not edit server attributes.

The offline studio keeps a separate atmosphere preference. Migrating an older studio preference does not silently override a network world's lighting. An explicitly selected network override persists on this device across worlds; its local badge remains visible. Overrides affect sky/light/exposure, not authored fog, viewing distance, water or flying permissions.

## Read-only details

The information button beside the world name opens World details: source, entrance, capabilities, light/fog, terrain, scenery and water. A disconnected scene is labelled with its last received attributes; a new connection clears the previous world's details. Build permission does not override ownership or optimistic concurrency checks.

The panel does not enumerate raw attributes. Object-path credentials, query parameters and fragments are removed from its display; invalid URL-shaped scenery references are not echoed. Object-path passwords are excluded from protocol state forwarded to the renderer. Welcome text is inert, bounded text, not HTML. This is not a world-settings editor.

## Implemented semantics

| Setting | Interpretation / current behavior |
| --- | --- |
| Colors | Integer RGB bytes, converted to colors. Partial packets preserve unchanged channels. Six sky anchors use west +X, north +Z and top +Y. Smooth interpolation between anchors is a Wayfarer approximation, not verified historical raster parity. |
| Light direction | Three components in -1..1, preserving the authored vector in metadata. The renderer places the light along its negative direction, following AW 3.3+ semantics. A zero vector does not invent a directional sun. |
| Fog / visibility | Fog enable controls scene fog. Fog maximum also controls the camera far plane when fog is disabled. The AW 3.4+ documented maximum range is 50..1200 metres; minimum is 0..1200, with invalid/inverted ranges retaining the prior safe range. |
| Terrain elevation | Metres, applied to rendered terrain and collision/raycast height. |
| Basic water | Enabled flag, metre level, RGB color and opacity. The wire opacity byte 0..255 becomes 0..1; zero stays transparent, not a missing default. |
| Flying | Authored rule plus the caretaker exception. Revocation stops flight; all world replacements reset the actual state and toolbar indicator. |
| RWX / experimental X skybox | Authored size, faces and materials in a camera-centered background pass, drawn before world geometry with independent depth. X remains in bind pose. |
| RWX / experimental X ground | A bounded model at its authored world origin, available alongside terrain and included in collision queries. |

The normalizer uses pinned Axis defaults, including disabled white fog at 0..1200 metres, ambient RGB 191, zero directional vector, black sky and terrain offset -0.1 metres. It does not invent a remote object path. Invalid fields retain safe prior values with diagnostic notes; documented numeric bounds are client limits, not proof that Axis rejects wider inputs. Malformed capability bits fail closed. Cumulative state is bounded and partial updates retain earlier attributes/capabilities.

## Remaining compatibility work

Six-color interpolation and modern material/tone mapping are not pixel-identical AW rendering. RWX `PRELIGHT` and `VertexExt` now carry additive vertex illumination through the shared world, avatar, preview and environment renderer. Full Surface coefficients, historical gamma and certain TextureMode combinations remain approximate. See [prelighting behavior and its real GPU comparison](rwx-prelight.md).

Repeating ground is drawn once with a warning; historical placement spacing is not assumed. AWG ground groups and legacy panorama backdrops are unsupported. Cloud layers, light-source sprites, tinted fog, terrain ambient/diffuse material controls, water textures/masks/underwater visibility/waves/shader water and advanced collision/physics remain metadata or open renderer work. Local teleport restrictions now distinguish manual navigation from caretaker and supported object/server-triggered exceptions. Normalized passthrough/gravity/friction values do not imply full historical movement enforcement.

Environment asset loads use a shared queue with two active and 32 waiting tasks. Accepted models are limited to 500,000 vertices and 2,048 parts; texture retention is limited to 16 images, 4,096 pixels per dimension and 16,777,216 total pixels. These acceptance limits do not bound peak parser/image-decoder allocation. Stale loads are discarded and owned resources disposed on replacement/reset.

## Sources and verification boundaries

Attribute IDs, packet representation and defaults come from pinned [Axis WorldAttributes](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Models/WorldAttributes.cs) and the pinned Axis platform enum. Physical conventions were checked against archived official [World Features](https://web.archive.org/web/20250506133806/https://wiki.activeworlds.com/index.php?title=World_Features), [light direction](https://web.archive.org/web/20250506091000/https://wiki.activeworlds.com/index.php?title=AW_WORLD_LIGHT_Y), [water opacity](https://web.archive.org/web/20250506091018/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_OPACITY) and [fog maximum](https://web.archive.org/web/20250506090937/https://wiki.activeworlds.com/index.php?title=AW_WORLD_FOG_MAXIMUM). Additional exact references are retained in `WORLD_ENVIRONMENT_SOURCES` in the normalizer.

Skybox behavior was checked against official [viewer-centered rendering](https://www.activeworlds.com/newsletter/1001/1002.html) and [skybox authoring](https://www.activeworlds.com/newsletter/1001/1006.html) articles. The official [AWG ground example](https://www.activeworlds.com/newsletter/1012/awgs-for-ground.html) establishes that ground can coexist with terrain; neither RWX nor [experimental X loading](directx-models.md) implements AWG groups.

For manual GPU checks, run the existing local dev server and open `http://127.0.0.1:5173/tests/environment-render.html`. This dev-only page imports the real controller, scene pass and asset loader, with an exact in-memory allowlist of original RWX/PNG fixtures. It never connects to Axis or downloads a remote asset. Controls expose sky directions, RWX skybox/ground, fog, water and lighting modes; shader errors and resource counts are visible in the page. It is not part of the production build.

Automated protocol/engine/UI tests and original GPU fixtures are separate from live-server and packaged-native validation. See [dated verification](verification.md) for what was actually exercised. Neither compact original fixtures nor archived documentation establishes general AW 5.2/6.2 content parity.
