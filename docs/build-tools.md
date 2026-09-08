# Move and rotate tools

Wayfarer’s build handles translate and rotate one object or a selection. They work in the offline studio and use the same accepted-result history when connected to an Axis world. This is an independent AW-style interface, not a claim of complete AW 5.2/6.2 browser fidelity.

## Quick start

1. Click **Build**, or press **B** with the world view focused.
2. Click an object. **Shift-click** adds or removes objects, up to 256. Gold bounds identify the primary object; teal bounds identify the others.
3. Choose **Move** or **Rotate** in the toolbar above the world view.
4. Choose **World** or **Local** axes. Local follows the gold primary object's saved orientation.
5. Drag a colored axis or rotation ring. The scene previews the edit while you drag; no object mutation is submitted yet.
6. Release the pointer to apply one undoable batch. Press **Esc before releasing** to cancel instead.

Move handles include axis arrows, plane handles and a central free-move handle. Rotate offers three axis rings in the chosen frame. Right-drag still turns the camera when no handle is being dragged. Camera movement and ordinary object selection pause during a handle drag.

**Move snap** offers Off, 0.1, 0.25, 0.5 and 1 metre. **Turn snap** offers Off, 5°, 15°, 45° and 90°. Defaults are World axes, 0.5 m and 15°; these preferences are saved on this device. World translation snaps the selection pivot to the world grid, not every object independently. Local translation snaps the displacement from the drag's starting centroid in the frozen primary-local basis. An off-grid selection does not jump to a rotated absolute grid. Plane handles snap their two local components; the central free-move handle snaps all three local components of its camera-plane movement.

For a selection, the pivot is the average of the objects’ property origins in all three dimensions—not the centre of their visible bounds. Translation preserves relative placement. Rotation moves each origin around that pivot and rotates each object's existing orientation. It does not flatten existing pitch or roll. Local rings rotate the group about the primary's saved YXZ orientation at the start of the drag, with turn snapping applied to the rotation increment. Animated visual rotations and nonuniform `create scale` actions do not determine this frame; action scale remains intact. A valid primary is required for Local handles. The inspector continues to show world position in metres and authored rotation in degrees.

## Apply, undo and recover

Use the visible Undo/Redo buttons after an edit. With the world view focused, Ctrl/Command-Z undoes; Ctrl/Command-Shift-Z or Ctrl-Y redoes. A released handle operation is one history entry, even when it affects several objects. History is bounded and lasts only for the current world session; it is not saved in studio project files.

Online edits wait for accepted canonical properties, including the server’s rounded coordinates, angles and owner. An accepted broadcast is authoritative. A rejected callback cannot restore an older preview over it. If part of a group is accepted and a later object fails, accepted changes remain undoable; the client does not claim an all-or-nothing server transaction.

After pointer release, **Esc cannot unsend an edit**. Use Undo after acceptance. If a request times out or the connection disappears, inspect the current world before retrying: the server may already have accepted part of it. Wayfarer never automatically retries the batch.

An active drag is canceled by Escape, lost pointer capture, window focus loss, a relevant remote property change, object removal, world reset, tool disablement, or a change of mode, axes, snap settings or primary object. A changed authored primary frame also cancels the preview. Unrelated object updates, metadata-only refreshes and reordering the same selection with the same primary do not discard the drag. A refused 257th additive selection retains the current primary and drag. Full property replacement queries conservatively cancel its preview.

Handles are unavailable while a dialog is open, an operation is pending, build permission is absent, selected models are still loading, or the inspector contains unapplied edits. Apply or **Discard edits** first. Inspector drafts are separate from saved objects: project autosave and export do not include draft text or relative offsets. A failed inspector group transform retains its offsets and requires explicit review before retrying, since some objects may already have moved.

## Current boundaries

- No scale handles: the property protocol has no independent scale field. Existing `create scale` actions remain intact; a handle drag does not rewrite action scripts.
- No surface alignment, object-to-object snapping or persistent undo history yet. Terrain editing uses separate tools, not these object handles.
- The 256-object bound limits a single selection/batch; it is not a large-world performance guarantee.
- Axis permissions and concurrency limits still apply. Cached stale-object checks are not atomic compare-and-swap, and deletes have additional limitations. See [building protocol evidence](protocol-building.md).
- Offline and automated results do not establish fresh server health, official Active Worlds compatibility or platform-wide native interaction coverage. See [verification](verification.md) and [compatibility](compatibility.md).

## Implementation and evidence

The installed dependency is Three.js **0.185.1**, pinned by `package-lock.json`. Its primary `TransformControls` implementation is inspected locally at `node_modules/three/examples/jsm/controls/TransformControls.js`. Wayfarer routes the public pointer methods itself: the stock DOM handlers also capture right-button pointers and do not handle pointer cancellation. The control/helper is disposed separately from world geometry.

Local translation disables Three's absolute local-grid snap and quantizes the constrained displacement in the frozen start basis before publishing a preview. For rotation, the world-space delta is the current pivot quaternion multiplied by the inverse starting pivot quaternion; preview and immutable commit use the same delta. This preserves compound group orientations and spacing without baking the primary frame into every object. A narrow camera-aligned local-ring correction uses the public raycaster and a frozen camera-facing plane: Three r185's fallback otherwise treats a world camera-eye axis as a local axis. Parallel and antiparallel real-pointer tests exercise the corrected signed angle. Current engine property roots and the gizmo share an identity world scene; arbitrary transformed scene parents are not an advertised editing contract.

Undo/redo receives the existing immutable before/after batch, not a local-axis command. Online history must still record canonical server-rounded values. Changing axes after acceptance therefore does not change what Undo means, and the gizmo itself never synthesizes an accepted result.

[Transform tools](../src/renderer/engine/transform-tools.ts) implement bounded snapshots, centroid/quaternion math, preview restoration and lifecycle cancellation. [WorldEngine](../src/renderer/engine/index.ts) integrates pointer/camera routing and authoritative object updates. [App](../src/renderer/App.tsx), [BuildHistory](../src/renderer/build-history.ts) and [the mutation gateway](../src/renderer/build-mutations.ts) apply permission/draft/dialog gates and record accepted results. UI degrees are converted to radians at the engine boundary.

The [transform tests](../tests/engine-transform.test.ts) use real Three geometry and raycasting—not a mocked gizmo—to exercise world/local arrows, planes and rings, incremental local snapping, camera-aligned rings, compound YXZ orientations, animation/action-scale immunity, immutable previews, primary selection changes, cancellation, partial acceptance, late callbacks and disposal. [Building UI tests](../tests/building-ui.test.tsx) separately verify the React/history handoff and stored axes/snapping preferences with a mocked engine.

```sh
npx vitest run tests/engine-transform.test.ts tests/building-ui.test.tsx tests/build-history.test.ts tests/build-mutations.test.ts
npm run typecheck
```

These checks do not log in, change server data or replace a native pointer-interaction review.

The separate [isolated transform smoke](../scripts/axis-isolated-transform-smoke.ts)
owns a fresh fixture and two generated citizens. It verifies canonical local-frame
translation/group rotation, second-client broadcasts and fresh queries, stale
rejection, Undo/Redo, metadata preservation and exact owned-object cleanup.
Its scalar Hamilton-product oracle does not import Three or production math.
This exercises the connected transform/history boundary, not a connected native
gizmo. The [v0.12 verification](verification.md) records the eight live checks
and the distinct offline native pointer visit.
