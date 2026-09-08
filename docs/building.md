# Building in Wayfarer

Building supports individual property/action edits, Shift-click multi-selection, group translation/yaw, duplication, deletion and undo/redo. A group rotates about its centre in metre/radian coordinates. Selected objects have individual bounds: gold for the primary object and teal for the rest. There is a 256-object operation/selection limit.

## Undo and remote changes

The client records only accepted canonical results, including the owner, rounded coordinates, angles and IDs returned by the server. Undoing a deletion recreates the object; server IDs may change, and older history references are rebased. Undo is limited to 100 transactions and a bounded 16 MiB snapshot estimate per current world session.

Each affected object is checked before a compound operation begins, and again before its own command. Known remote edits cause a conflict rather than being overwritten. If a later object fails, earlier accepted changes remain individually replayable through the compound undo/redo history. No rollback or all-or-nothing server transaction is claimed. Disconnects, world entry and world-only connection loss invalidate history; uncertain network outcomes are not automatically retried.

The pinned Axis server offers old-number lookup but no atomic compare-and-swap across its database update, and deletes do not enforce old numbers. See [the protocol evidence](protocol-building.md). Permissions remain server-authoritative.

Unapplied inspector drafts are separate from saved world objects. Apply or explicitly discard them before changing selection, hiding the inspector, undoing another operation or leaving the session. Drafts survive rejected edits and a selected object's deletion; a successful edit adopts the server's canonical rounded transform. A failed group transform retains its offsets and requires explicit review before retrying, because some objects may already have changed. Discard the offsets first to undo accepted changes.

Position, rotation and group-offset fields retain the exact text while you type,
including a leading minus sign and fractional precision. Incomplete or invalid
numbers stay visible as drafts and cannot be applied; finish the number or
discard the edit. Position is in world metres, authored rotation is in degrees,
and group offsets are relative world coordinates. Choosing Local axes changes
the 3D handles, not the inspector's coordinate convention.

## Offline projects

Studio saves contain a version, project name, bounded object list, camera position and update timestamp. No credentials, universe config or remote object path is included. Import accepts only validated plain data, unique uint32 IDs, safe model references and bounded transforms/text. Maximums are 5 MiB and 5,000 objects; these are validation ceilings, not measured performance guarantees.

Autosave runs after edits, periodically for camera movement, and on orderly departure. Corrupt saved bytes are not replaced by a fallback scene. Quota errors remain visible, and leaving an unsaved studio for another universe is blocked. Export a backup from Project; import and restore require explicit replacement confirmation. Abrupt process termination or power failure can still lose edits made since the last successful write.

The renderer requests unload prevention when a save fails, an inspector or telegram draft exists, or an operation is pending. The native shell then offers Keep editing or an explicit Close without saving choice using Electron's [documented unload handling](https://www.electronjs.org/docs/latest/api/web-contents#event-will-prevent-unload).

Keyboard shortcuts act only outside text inputs: Ctrl/Command-Z undo, Ctrl/Command-Shift-Z or Ctrl-Y redo, Ctrl/Command-D duplicate, Ctrl/Command-A select all loaded objects (up to 256), Delete/Backspace request deletion. Native menu accelerators and OS-specific keyboard interactions still require broader platform QA; the visible buttons are the primary tested controls.

The [model browser](model-browser.md) provides scene-derived search, scoped Favorites/Recent and actual 3D previews. [Move/Rotate handles](build-tools.md) provide direct manipulation, world/local reference axes and grid/angle snapping. [Terrain editing](terrain-editor.md) supports bounded height/texture previews and canonical row writes. Remaining building work includes surface/object snapping, continuous terrain brushes, permission-detail display and persistent undo history.
