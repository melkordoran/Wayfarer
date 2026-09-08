# Guarded world-settings writes

Wayfarer implements the pinned Axis `AttributeChange` contract independently.
It does not claim atomic writes, durable save acknowledgements, or a
server-enforced compare-and-swap operation.

## Source contract

- `vendor/axis-world/Axis.WorldServer/PacketHandlers/AttributesHandler.cs:39-62`:
  packet 7 is accepted for a caretaker's acting citizen or WorldAdmin. An
  unauthorized request is silently ignored. After updating, an asynchronous
  broadcast sends current settings to clients in the initiating instance.
- `Models/WorldAttributes.cs:693-774`: only String/Data fields are processed.
  Numeric values are parsed from invariant strings; unsupported fields and
  invalid numeric values are skipped. Values change before `SaveToFile`.
- `Models/WorldAttributes.cs:352-389`: saving truncates and rewrites the file;
  neither memory changes nor partial disk writes are rolled back on failure.
- `Services/WorldClient.cs:205-235`: a compressed envelope contains full
  Attributes (6), followed by all seven recalculated Capabilities (16).
- `Axis.Platform/Axis.Platform.Network/IO/NetServerBase.cs:238-293`: handlers
  run in order per connection, but different connections run concurrently;
  handler exceptions are traced, not returned as attribute-write responses.

There is no supported attribute-read query handler in this pinned server.
Sending an empty AttributeChange would itself write the file and is not used
as a readback request. The shared world attribute object spans instances, but
the broadcast reaches only the initiating instance.

## Adapter guarantees and limits

An edit carries a fresh per-entry UUID, Universe session, world name, raw
attribute revision, exact prior strings, request ID, and whitelisted changes.
The main-process adapter independently validates these, requires caretaker
rights and a ready world, clones the request, validates edited cross-field
constraints, removes semantic no-ops, and pre-encodes the bounded packet.
Only changed UTF-8 String fields are sent. There is one pending write.

A one-character String update alone would have a legacy frame length of 16,
which collides with the v4 header marker. Only for that exact collision, the
adapter sends the same AttributeChange fields explicitly as v4. Pinned
`NetConnection.ProcessPacket` accepts v4 and then upgrades its replies; this
does not establish compatibility with other historical world servers. Ordinary
non-colliding legacy updates retain their negotiated version. No filler field,
no-op update, or string padding is added, and sending does not itself change
the client's negotiated version before a v4 reply is actually received.

Readback is registered before dispatch. Each Attributes/AttributeChange packet
advances the local revision; capabilities do not. Only a fresh Attributes
packet containing unique valid text fields for every changed ID can become a
candidate. An intervening partial/malformed attributes packet invalidates it.
The subsequent capability packet must contain all seven unique valid Y/N
values. Values compare through the shared schema, including C# float32
semantics. Normalized cached defaults cannot establish readback.

The adapter emits canonical world state before the scoped result event and
resolves the command after that event. `observed` means the requested values
were seen, not that this request uniquely caused or durably saved them.
`conflict` and `uncertain` block another write until re-entry. After 12 seconds,
dispatch failure, disconnect, or world-entry replacement, an unresolved write
becomes uncertain; no retry, cancellation claim, or rollback is sent. The old
entry ID stays on its result so the UI can preserve the correct draft.

Cross-caretaker races remain possible because Axis has no request identifier,
revision/CAS protocol, or transactional snapshot. An unrelated broadcast can
show matching or conflicting values. These limits are explicit in result text.

`tests/protocol-world-settings-edit.test.ts` uses independently authored
packets through the real codec and transport dispatcher, with sockets mocked.
It exercises scope/baseline checks, no-ACK behavior, float32 round trips,
partial/duplicate/malformed fields, ordering, conflict, timeout, dispatch
failure, and same-world re-entry. It starts no server or remote connection.
