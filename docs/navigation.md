# Navigation permissions

Wayfarer checks manual local teleporting at the engine boundary, not just on buttons. Travel coordinates, same-world bookmarks, `/home`, the entrance button, and same-world world-list re-entry obey `WorldSettings.canTeleport`. The normalized value is `allowTeleport || caretaker`; legacy settings without an effective value use the authored rule and caretaker flag. Studio is unrestricted. Normalized explicit `false` wins over inconsistent legacy flags.

Travel inputs accept fractional metre positions (`step="any"`), including terrain-derived floating-point heights, without silently rounding the submitted destination. Command validation still rejects non-finite/out-of-protocol-range coordinates.

The official [AW_WORLD_ALLOW_TELEPORT reference](https://web.archive.org/web/20250506090855/https://wiki.activeworlds.com/index.php?title=AW_WORLD_ALLOW_TELEPORT), introduced with AW 2.1, describes manual/menu restrictions, the caretaker exemption, and the exception for authored teleport/warp actions. Accordingly, implemented `activate teleport` actions retain their exception. A disabled entrance/bookmark or Travel form displays the restriction; `/home` and rejected re-entry provide a message.

## Entry and trusted positioning

- Manual `enter` commands default to `origin: 'user'`. Denied same-world entry fails before closing the current connection, even with no coordinates or different name casing/whitespace.
- Cross-world manual entry remains possible. If the destination disallows local teleporting, **all manual entries land at X=Z=0**, including initial sign-in and omitted coordinates. The official [World Features page](https://web.archive.org/web/20250506133806/https://wiki.activeworlds.com/index.php?title=World_Features) specifies the horizontal origin for restricted entry from outside. It does not specify the forced altitude/heading: Wayfarer deliberately retains the destination's authored entry Y/yaw/pitch, discarding requested values. This is a client policy, not verified AW vertical/heading parity. When permitted, an omitted manual position uses the authored entry point.
- Object cross-world entry uses `{ type: 'enter', world, position, origin: 'action', fromWorld, session }`. Source world/session and completed entry must match. Connection generation is checked after asynchronous lookup/connect/entry; leaving or superseding travel invalidates it. This scope prevents stale UI actions, not a malicious-client bypass.
- Server `P.Teleport` is a distinct internal path. Local events call `engine.applyServerPosition`; cross-world routing stays inside `AxisClient` and emits positioning after entry. **There is no public `origin: 'server'` command**: validation rejects it. Malformed server world names do not disconnect the current world.

The pinned [Axis AvatarHandler](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/AvatarHandler.cs) only forwards `P.Teleport` for senders with caretaker/eject rights. [EntryHandler](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/EntryHandler.cs) sends attributes/capabilities before successful entry; these determine the final manual landing policy. User/menu engine teleport calls remain separate from trusted initial entry, server positions and private parsed object activation.

Missing or out-of-order permission packets fail closed: manual travel remains disabled until a valid `AllowTeleport` value or positive caretaker capability arrives. A malformed first value does not turn server defaults into permission. Later attributes update the effective rule without automatically moving the visitor.

Trusted server positioning is applied even while an inspector draft or build operation is active; local positioning preserves those edits rather than consulting the user-navigation veto. A failed World lookup restores Universe-only `connected` status so another entry can be attempted. Older lookup failures cannot overwrite a newer entry or disconnect.

Intentional disconnect immediately stops automatic movement/query submissions and gesture-completion clears, before the asynchronous bridge's status reply arrives. A failed disconnect restores those automatic updates; a fresh login enables them for the new session. Explicit stale commands still report errors—there is no blanket suppression of navigation failures.

## Boundaries and verification

This implements browser navigation policy, **not server anti-cheat**: ordinary movement coordinates are client-authored, and Axis does not enforce teleport distance in `StateChange`. No speed/physics heuristic was invented. World physics, passthrough/camera collision rules, relative action-coordinate syntax, bump activation and smooth warp behavior are not completed by this slice. The [official Teleport command reference](https://web.archive.org/web/20250506084906/https://wiki.activeworlds.com/index.php?title=Teleport) remains broader than the current parser. No new `/tp` or `/teleport` chat command was added.

Run `npx vitest run tests/protocol-navigation.test.ts tests/engine-navigation.test.ts tests/navigation-app.test.tsx`. These are real codec/dispatcher and Three.js engine tests plus React interaction regressions, with scripted protocol peers and no sockets/accounts.

Separately, the v0.6 [isolated live runner and browser pass](verification.md) verified tourist origin/denial, caretaker exceptions, fractional Travel, failed lookup recovery and clean disconnects against fresh real servers. Object/server exceptions and trusted positioning during active edits have regression coverage, not a new live server-teleport claim. No primary service restart, login or attribute edit was performed.
