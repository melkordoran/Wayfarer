# Authored navigation actions

Wayfarer supports local and cross-world `activate teleport` and `bump teleport`. Relative horizontal coordinates use two signed bare numbers, first north/south and then west/east, in 10-metre units. They are offsets from the avatar's current world position, not its facing direction. Positive X is west, as documented by [AW_MY_X](https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=AW_MY_X). Absolute destinations require one N/S and one E/W coordinate; their existing reversed-axis-order spelling remains accepted. Do not mix an absolute coordinate with a relative one.

Optional altitude ends in `A` and uses 10-metre units. A signed altitude is relative; an unsigned altitude is absolute. Optional direction is in degrees: unsigned replaces heading, signed adds to it. Omitted altitude and heading retain their current values. A world-only destination uses ground zero at altitude zero and preserves heading. Both horizontal coordinates are otherwise required. The archived official [Teleport reference](https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Teleport) documents this syntax; its altitude example confirms that `+10a` means 100 metres, not 10 metres.

```text
activate teleport +0 +0 +10a
activate teleport 10N 20W 1.5A 90
activate teleport +2 -1 -.5A +90
create solid off; bump teleport Haven 0N 0W
```

The [Bump trigger](https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Bump) fires on avatar/object contact. Non-solid objects still receive bumps according to the official [Solid reference](https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Solid). Wayfarer keeps their actual loaded meshes in a separate trigger list; placeholders never become bump geometry. Rendering visibility does not remove collision/trigger geometry. Walking, flying, foot contact and upward/downward movement use bounded ray probes. This is a capsule-like collision approximation, not historical AW collision-mesh or swept-volume parity.

## Safety and lifecycle

- A contact fires once on entry. One global one-second cooldown prevents rapid portal chains. Contact entered during cooldown or suspension is consumed, never replayed later. This interval is a Wayfarer policy, not a verified historical AW interval.
- Blocked contacts remain latched within a one-frame movement margin; a new stationary contact requires the ordinary avatar-radius probe. Edited or newly loaded geometry touching the avatar is suppressed until the avatar leaves it.
- One valid teleport ends the current command chain and clears held movement. Cross-world navigation continues through the existing scoped host/protocol callback; the renderer cannot connect to a different world by itself.
- `setNavigationActionsEnabled(false)` pauses both activation and bump navigation, clears held input, and never queues actions. The host uses this for dialogs, unsaved inspector drafts, busy builds and inactive sessions. Build mode and an active transform also suppress authored navigation.
- World positioning/reset, object deletion/replacement and disposal invalidate old contact/action state. Entry identity and generation checks prevent a callback from continuing an old-world command chain.
- `lock` is not implemented; encountering it stops subsequent navigation in that trigger instead of silently bypassing an ownership condition.
- Scripts over 65,536 characters or 256 commands are rejected as a whole. Destinations are limited to 1,024 characters, world names to 64 characters, and resolved positions to protocol numeric bounds. At most 256 contact candidates are retained per update. Local bounds exclude distant portal geometry before raycasts, which examine at most 256 nearby trigger meshes; unusually dense/fragmented overlapping portals can exceed this safety budget and are not guaranteed to fire.

Existing `activate url` only reports a link to the host; it does not automatically launch a browser. Bump URL/media execution, create/adone teleports, teleportx, smooth warp, global actions, named-object commands and full action scripting are not implemented. The official [Warp reference](https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Warp) describes additional gravity/collision timing that this immediate-teleport slice deliberately does not claim.

## Streamed-out geometry

`unloadSceneData(objectIds, terrainPages)` removes requested objects and every node belonging to the exact page coordinates. It does not produce server deletion events or change player position, world settings or avatars. Geometry, materials and exclusively owned textures are disposed; shared object-path textures remain cache-owned so surviving models do not lose their maps. Late object downloads cannot reinsert an evicted entry, and late terrain texture completions cannot attach to disposed materials. The host checks network world/session scope before calling this method; no automatic offline-studio eviction is introduced.

## Verification boundaries

The focused engine tests use real Three geometry/raycasting with a stub renderer: relative syntax, malformed/overflow input, contact edges/cooldown, solid-off/invisible/flying portals, nearer blockers, UI/lifecycle cancellation, conditional failure, exact page eviction and late-resource ownership. They do not establish native pointer-driven teleport behavior or proprietary-client pixel/physics parity. No primary universe/world login is required by these tests.
