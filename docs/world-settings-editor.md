# Caretaker world-settings editor

Open the information button, then **Edit world settings**, while connected as a
caretaker. The normal World details view stays read-only. Offline studio settings,
effective citizen capabilities and personal lighting overrides are separate.

The editor offers 50 logical fields (70 Axis attributes) in eight sections:
General, Movement rules, Lighting & sky, Fog, Terrain & scenery, Water, Physics,
and Object path. RGB controls edit separate red/green/blue integer attributes.
Numbers show their editing limits and units; these are Wayfarer support limits,
not claims that the server rejects all wider legacy values. Water opacity stays
on the server's exact 0–255 scale. Entrance coordinates use N/S, E/W, optional
altitude in 10-metre AW units, then heading in degrees.

## Drafts and conflicts

Nothing is sent until **Apply changes**. There is no local preview, automatic
retry, undo, rollback, reset-all or batch transaction. Only changed values are
sent, using their exact received baselines. Unsupported untouched legacy values
remain untouched; renderer defaults are never serialized as authored settings.

Unedited fields follow new broadcasts. Edited fields retain the draft; a changed
server baseline requires explicit **Use current value** or **Keep my draft**
review. The latter accepts the displayed current baseline but does not send.
Dirty close/navigation paths are guarded. Drafts live in memory, not storage.

A draft belongs to its original world entry and signed-in session. Disconnect,
same-world re-entry, switching worlds, caretaker revocation or an uncertain
result preserve the text but permanently disable that draft. Close/discard it,
re-enter if necessary, and open a new editor after inspecting the world.

## What Apply proves

Axis packet7 is fire-and-forget. Wayfarer waits for a fresh full attribute packet
containing every changed ID and the following valid capability packet. Its
12-second timeout never means the server definitely rejected the edit.

- **Observed:** requested values appeared in a server broadcast. This is not a
  durable or atomic save acknowledgement and does not identify which caretaker
  caused those values.
- **Conflict:** observed values differ. The original edit may still have run.
- **Uncertain:** a complete observation was unavailable. The edit may have run.

Conflict/uncertainty stop further settings writes until re-entry; no retry or
restoration is sent automatically. Axis offers no revision/CAS or transaction:
cross-caretaker races remain possible. Broadcasts reach the initiating instance
although attributes are shared across instances. See the
[source-backed protocol notes](world-settings-protocol.md).

## Object paths and privacy

The current path is displayed without URL credentials, query parameters or
fragments. The replacement input always starts blank: blank means unchanged.
Enter a new HTTP(S) URL to replace it. **Clear object path…** requires a separate
confirmation and only stages an empty value; Apply is still required. Clearing
can prevent models, textures and avatars from loading for everyone.

Do not paste credentials or signed URLs into the replacement. Such new values
are rejected without echoing them into validation errors. Unsupported URL-shaped
model/texture references are not copied into inputs. No attribute passwords,
rights ACLs, ownership/caretaker flags, CellLimit, media, advanced shader/cloud
parameters or WorldAdmin settings are editable in this milestone.

Object-path configuration is the world operator's responsibility. No client-side fallback
was added: this editor neither guesses an object path nor repairs servers automatically.
