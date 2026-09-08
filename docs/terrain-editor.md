# Terrain editor

Open **Build → Terrain**, then click the ground or choose **At my feet**.
The coordinate fields use global 10-metre cells: positive X is west, positive Z
is north. Select a 1, 2, 4 or 8-cell square (up to 64 cells).

Choose **Raise**, **Lower**, **Set height** or **Texture**, then **Preview terrain**.
Height inputs are metres at centimetre precision, before the world's terrain
offset. Raise/Lower preserve every cell's existing texture. Texture painting
preserves heights; it accepts legacy textures 0–63 and quarter-turn rotation.
Texture 62 at 270° is reserved for hole code 254: use the explicit hole checkbox
instead of accidentally selecting that combination.

The cyan outline and temporary surface are a local visual preview. They do not
write to a server or change collision. **Apply terrain** commits; **Discard
preview** cancels the remaining draft. Height samples are terrain vertices, so
raising one cell also changes the slopes of adjacent faces. Authored property
objects, such as paths and floors, can cover terrain. Painted faces behind a
ridge may require another viewpoint to see.

## Permission, drafts and history

- Network editing requires complete loaded terrain, enabled terrain and the
  world's effective terrain-editing right. Ordinary Build permission alone is
  insufficient. Missing data is never assumed to be flat zero terrain.
- Opening a dialog hides the preview but preserves its copyable values. Close
  the dialog and choose **Restore preview** before Apply is enabled again.
- Changed or unloaded terrain invalidates an old preview. A draft from an older
  world entry stays copyable but cannot be submitted, even on same-world reentry.
  Discard it and preview the current data to continue.
- Travel, building-category changes and closing build mode are guarded while a
  draft or write is pending. Do not forcibly quit during an uncertain write.
- **Undo/Redo**, or **Ctrl/⌘ Z** and **Ctrl/⌘ Shift Z**, restore verified values.
  Text fields retain their normal editing shortcuts. History retains up to 32
  edits in the current world entry; it does not survive reconnect or restart.

Connected patches are sent as serial rows. Each row requires a server ACK plus
canonical page readback before it counts as verified. If a later row fails,
earlier verified rows remain applied; the UI reports the partial result. Discard
the remaining draft to undo the verified portion. There is no automatic retry or
unconditional rollback. Axis provides no atomic compare-and-swap: another builder
can change terrain between checks or immediately after readback. See the
[wire contract](terrain-protocol.md) and [isolated evidence](terrain-integration.md).

## Offline studio

The original Commons has one editable 128 × 128-cell page, extending from −640 m
to +640 m on both axes. Original scenery remains separate. Its original swatches
are 0 Grass, 1 Sand, 2 Stone and 3 Soil; other indices use a plain fallback, not a
downloaded or invented world texture.

Applying terrain upgrades the saved project to version 2 with sparse 8 × 8-cell
patches. Existing version 1 projects remain readable and are not rewritten as
version 2 just by opening them. Project save, rename, import and export preserve
terrain and objects together. If storage rejects a write, canonical local terrain
does not change and the draft remains copyable. The existing 5 MiB project limit
still applies.

This is a bounded editing slice, not full historical AW terrain-editor parity.
Smoothing, continuous brush strokes, selections larger than 8 × 8, extended
texture appearance, persistent history and connected native GUI verification
remain open.
