# Contacts and telegrams

Wayfarer's native adapter implements the pinned Axis Universe browser packets, independently of the vendor SDK.

| Command | Behavior |
| --- | --- |
| `contacts-list` | Full authoritative list and default privacy options |
| `contact-add {name, options?}` | Name lookup/add, then list refresh; may trigger a consent request |
| `contact-delete {citizen}` | Acknowledged removal, then list refresh |
| `contact-change {citizen, options}` | Per-contact privacy; citizen 0 means account defaults; verified by list readback because no ACK exists |
| `contact-confirm {citizen, options?}` | Explicit consent; requester must currently be online |
| `telegram-send {to, text}` | Submit at most 1,000 UTF-16 code units; no silent client truncation |
| `telegram-fetch` | Fetch **exactly one** pending message, only when explicitly commanded |

Events are `contacts {contacts, defaultOptions}`, `telegram-pending {pending}`, and `telegram {message}`. Contact states retain the server's offline/online/away/unknown/invalid/removed/default distinction. Privacy bits are exported as `CONTACT_OPTIONS` in shared types; they are policy settings, not proof a person is offline. Account-default updates and per-contact overrides follow server behavior.

## Important delivery and privacy limits

- Telegram collection marks the record delivered in the server database **before sending the response**. Notifications never fetch automatically. The caller must persist a received event successfully before requesting another message. There is no server replay/receipt acknowledgment protocol to repair a lost response or failed local storage write.
- A send ACK can report success while recipient privacy silently discards the message. Outgoing status therefore says **submitted**, never delivered or read. There are no read receipts.
- The delivery packet exposes sender name, body, age in seconds, and a more-remain flag; it does not expose a stable server message ID or sender citizen ID. Message IDs are local UUIDs and incoming send times are approximate.
- A contact-consent request uses special telegram text. Parsed request metadata is untrusted; it never triggers automatic confirmation. Confirm requires explicit user action, and the pinned server requires the requester to be online.
- Contact list completion is identified by citizen ID 0, not `More=0`, which also occurs in live status notifications. Uncorrelated social requests are serialized. Contact-change success is checked by a subsequent list rather than invented acknowledgments.
- Citizen login is required by this client; tourist social commands are rejected locally. Reserved system-recipient telegram commands (such as account verification) are outside this implementation. Join invitations, file transfer, private chat sessions, citizen administration, and server inbox history replay are not implemented by these commands.

## Primary source evidence

Universe revision: `8ecd16abd46853f91c7af04f07d4d518f465017f`.

- [ContactHandler](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/PacketHandlers/ContactHandler.cs), [ContactService](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/Services/ContactService.cs), and [ContactRules](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/Entities/ContactRules.cs): list, flags, add/request/confirm, and privacy semantics.
- [TelegramHandler](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/PacketHandlers/TelegramHandler.cs), [TelegramService](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/Services/TelegramService.cs), and [TelegramRepository](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/Repositories/TelegramRepository.cs): packet fields, truncation, silent blocking, and destructive collection.
- [UniverseClient](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/Application/UniverseClient.cs) and [PacketBuilderExtensions](https://gitlab.pp16.org/axis/universe_server/-/blob/8ecd16abd46853f91c7af04f07d4d518f465017f/Axis.UniverseServer/Application/PacketBuilderExtensions.cs): pending notification and live/list contact framing.

## Local verification

```sh
npx vitest run tests/protocol-social.test.ts
node scripts/axis-social-provision.mjs
npx tsx scripts/axis-social-smoke.ts
```

The provisioning helper creates only unused citizen ID 4, `SocialTester`, using the official import entrypoint that exits before listener startup. A preexisting different account is preserved. Because the pinned repository drops the imported Comment field, the exact private fixture manifest plus ID/name records fixture provenance. Reruns do not reimport or reset an existing account password. Development credentials are `SocialTester` / `SocialTesterLocal42!`; use only on this loopback fixture.

The live smoke uses Explorer and SocialTester, never signs in as Wayfarer, does not restart services, restores both accounts' original contact/default options, and refuses to consume pending telegrams from non-fixture senders. It covers nine real-server checks: login/privacy snapshots; add/list/world presence; live status; online delivery; 1,000-character body; offline queue and single retrieval; actual silent blocking; explicit consent; deletion. Consumed fixture-authored telegram records can remain in the private server database under its retention policy.
