# Avatar gestures

Open the hand button in the world toolbar, or press **G** while the world has focus. The picker lists explicit motions for the selected avatar, with search across names and groups. Search and pagination preserve catalog ordinals; they never renumber a filtered list.

Choose a gesture to play once. **Show me in third-person view** is checked initially; uncheck it to keep the current camera. Playback still finishes while your local figure is hidden in first person. The viewport's **Stop** control ends local playback, and natural completion returns to idle/walk animation. Closing the picker does not stop a motion. Reopening it and selecting the same motion explicitly restarts it locally.

The original studio collection contains two independently authored rigid RWX figures and **Wave** and **Bow** sequences. These are bundled into the client and use an exact, in-memory asset allowlist; no network or protocol bridge is needed. The internal `https://studio.wayfarer.invalid/` address is a virtual lookup key, never a remote fetch. It is used only in the explicitly local studio. A network world with no catalog does not borrow this catalog or invent valid gesture numbers.

## Network behavior and honest limits

Wayfarer uses **0 for neutral** and **N for the Nth explicit catalog entry** (one-based). This matches the official [AW_MY_GESTURE documentation](https://web.archive.org/web/20250506090959/https://wiki.activeworlds.com/index.php?title=AW_MY_GESTURE), recovered from the archived ActiveWiki on 2026-09-07. The interface was introduced in SDK 2.1. The UI accepts 1–255; this upper bound is a Wayfarer support limit, not a documented protocol maximum, and later catalog entries remain visible but unavailable.

The official [AW_AVATAR_GESTURE documentation](https://web.archive.org/web/20250506090912/https://wiki.activeworlds.com/index.php?title=AW_AVATAR_GESTURE) confirms that movement repeats the current gesture value and that browser build 434 onward submits zero when its sequence finishes. Its example detects changes in the value rather than treating every movement update as another trigger. These documented indexing and completion semantics are now verified. Fresh isolated Axis runs on 2026-09-07 also proved avatar selection and two positive/neutral gesture cycles reaching a second citizen, deliberately waiting for each observation. This does **not** establish exact-version AW 5.2/6.2 playback parity, immediate retrigger delivery, or visual playback in a second native window. Compatibility profiles and licensed real-world fixtures remain release gates.

Axis transports an opaque signed integer for the gesture. Its [pinned avatar handler](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/PacketHandlers/AvatarHandler.cs) stores the latest state, and the [refresh service](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Services/AvatarRefreshHandler.cs) rate-limits/coalesces broadcasts. The [client packet writer](https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Services/WorldClient.cs) supplies neither a gesture start time nor a retrigger serial.

Consequently:

- **Submitted** means the transport write succeeded, not that the server acknowledged playback or another visitor saw it.
- Movement packets retaining the same positive gesture do not restart it. An observed neutral or different gesture followed by a positive value starts a new remote playback.
- A quick stop/repeat may be coalesced into the same positive state. Short gestures can be missed entirely. Wayfarer does not invent a counter, a guaranteed neutral delay, or a delivery receipt.
- Stop, completion and playback failure request neutral state for the same avatar/world/session. A failed or uncertain send exposes **Retry clear**. A failed replacement does not forget potentially active remote state, and another motion is blocked until that state is cleared or its session/type is replaced.
- Gesture commands reject stale world names, avatar types and Universe sessions. UI request epochs and object-path checks reject late local playback after a transition. An already-submitted old-catalog gesture is cleared when still in the same transport context. The wire guards cannot distinguish re-entry into an identical world within the same Universe session by name alone.
- Avatar selection is a separate guarded command. Local state follows successful dispatch or an actual server override; these sources are distinguished internally. A failed selection does not optimistically change the UI avatar or erase its recovery state.

## Playback and resource boundaries

Sequences must have a finite, positive duration of at most **60 seconds**. Loading has a **10-second deadline**; both deadlines have timer and frame-loop checks. Stop, avatar/world/source changes and disposal cancel ownership tokens so a late asset result cannot revive old playback. Browser/OS suspension can delay timers; these are best-effort active-process bounds, not wall-clock guarantees during suspension.

Unsupported or failed assets produce an explicit playback error and return to locomotion. An unavailable Bow or Dance is never substituted with an endless generic wave. Weighted DirectX avatars and separate catalog-referenced X motions are experimental; CAV, sheared rigs and complete historical sequence semantics remain unsupported. Root motion is not applied by these gestures; they do not move the user's world coordinates. The original studio's X avatar adds **X Salute** after Wave and Bow, without changing either RWX avatar's gesture ordinals. See [X animation limits](directx-animation.md).

## Verification

- `tests/engine-gestures.test.ts`: real original poses, neutral restoration, remote deduplication, repeat/stop, hidden first-person completion, loading races, deadlines and world/type/source lifecycle.
- `tests/gesture-dialog.test.tsx`: picker ordinals, grouping/search, bounded presentation, explicit consent, unavailable entries, pending guards and stale completion after unmount.
- `tests/gesture-app.test.tsx`: UI-to-protocol context, completion/clear, failures and transition recovery with a mocked engine/bridge.
- `tests/protocol-gestures.test.ts`: packet fields, entered-world/session/type guards, successful-write ordering and no false acknowledgements. Related avatar-selection/state regressions are alongside protocol tests.
- `tests/studio-avatar-assets.test.ts`: deterministic original assets, exact URL allowlist, byte ownership, distinct Wave/Bow poses and preservation of live fixture files.
- `scripts/axis-isolated-smoke.ts`: fresh real Universe/World sessions observe selection, gesture 1, neutral 0, then a second 1/0 cycle. Waiting for each received state makes this a delivery check, not a stress test of short or immediately repeated gestures.

Run `node scripts/axis-avatar-assets.mjs --studio --check` to verify the 17 bundled studio assets and the default `--check` separately for the 15 unchanged live avatar artifacts. These automated checks, documented semantics and bounded live observation do not substitute for immediate replay/coalescing tests, packaged-native interaction, exact-version sequence behavior or platform-wide verification. See [the dated checkpoint](verification.md); its earlier evidence and limitations remain a historical record.
