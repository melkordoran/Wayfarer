import type { TelegramMessage } from "../shared/types";

export interface SocialScope {
  host: string;
  port: number;
  tls: boolean;
  citizen: number;
}
export interface SocialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface SocialInbox {
  format: "wayfarer-inbox";
  version: 1;
  scope: SocialScope;
  messages: TelegramMessage[];
}
export type SocialErrorCode =
  | "invalid-inbox"
  | "unsupported-version"
  | "inbox-full"
  | "too-large"
  | "corrupt-storage"
  | "storage-unavailable"
  | "quota-exceeded"
  | "message-conflict";
export type SocialResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: SocialErrorCode; message: string } };
export const SOCIAL_LIMITS = Object.freeze({
  messages: 500,
  fileBytes: 2 * 1024 * 1024,
  exportMessages: 1000,
  exportBytes: 4 * 1024 * 1024,
  textCharacters: 1000,
});
const encoder = new TextEncoder();
class Invalid extends Error {
  constructor(
    readonly code: SocialErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const failure = <T>(
  code: SocialErrorCode,
  message: string,
): SocialResult<T> => ({ ok: false, error: { code, message } });
function result<T>(task: () => T): SocialResult<T> {
  try {
    return { ok: true, value: task() };
  } catch (error) {
    return error instanceof Invalid
      ? failure(error.code, error.message)
      : failure("invalid-inbox", "The telegram inbox contains invalid data.");
  }
}
function record(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Invalid("invalid-inbox", `${label} must contain plain data.`);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Invalid("invalid-inbox", `${label} contains unsupported fields.`);
  return value as Record<string, unknown>;
}
function text(
  value: unknown,
  label: string,
  maximum: number,
  nonempty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (nonempty && !value.trim())
  )
    throw new Invalid(
      "invalid-inbox",
      `${label} is missing or exceeds its text limit.`,
    );
  return value;
}
function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Invalid(
      "invalid-inbox",
      `${label} is outside its supported range.`,
    );
  return value;
}
function scope(value: unknown): SocialScope {
  const raw = record(
    value,
    ["host", "port", "tls", "citizen"],
    "Inbox identity",
  );
  let host = text(raw.host, "Universe address", 253, true).trim().toLowerCase();
  if (!/^[a-z0-9_.:[\]-]+$/.test(host) || host.includes(".."))
    throw new Invalid(
      "invalid-inbox",
      "Use a universe hostname or IP address, without credentials or a URL.",
    );
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || typeof raw.tls !== "boolean")
    throw new Invalid("invalid-inbox", "Invalid universe identity.");
  return {
    host,
    port: integer(raw.port, "Universe port", 1, 65535),
    tls: raw.tls,
    citizen: integer(raw.citizen, "Citizen number", 1, 0x7fffffff),
  };
}
function message(value: unknown): TelegramMessage {
  const raw = record(
    value,
    [
      "id",
      "direction",
      "from",
      "to",
      "text",
      "time",
      "status",
      "contactRequest",
    ],
    "Telegram",
  );
  if (raw.direction !== "incoming" && raw.direction !== "outgoing")
    throw new Invalid("invalid-inbox", "Invalid telegram direction.");
  if (raw.status !== (raw.direction === "incoming" ? "received" : "submitted"))
    throw new Invalid(
      "invalid-inbox",
      "Invalid telegram status. Submitted messages cannot be marked delivered.",
    );
  const normalized: TelegramMessage = {
    id: text(raw.id, "Telegram ID", 128, true),
    direction: raw.direction,
    from: text(raw.from, "Sender", 255),
    to: text(raw.to, "Recipient", 255),
    // Preserve untrusted server text exactly, including Axis contact-request markers.
    // It is rendered as text, never interpreted as markup or an instruction.
    text: text(raw.text, "Telegram text", SOCIAL_LIMITS.textCharacters),
    time: integer(
      raw.time,
      "Telegram timestamp",
      -8_640_000_000_000_000,
      8_640_000_000_000_000,
    ),
    status: raw.direction === "incoming" ? "received" : "submitted",
  };
  if (raw.contactRequest !== undefined) {
    if (raw.direction !== "incoming")
      throw new Invalid(
        "invalid-inbox",
        "Only an incoming telegram may contain a contact request.",
      );
    const request = record(
      raw.contactRequest,
      ["citizen", "name"],
      "Contact request",
    );
    normalized.contactRequest = {
      citizen: integer(request.citizen, "Contact citizen", 1, 0x7fffffff),
      name: text(request.name, "Contact name", 255, true),
    };
  }
  return normalized;
}
function messages(value: unknown, maximum: number): TelegramMessage[] {
  if (!Array.isArray(value))
    throw new Invalid("invalid-inbox", "Inbox messages must be an array.");
  if (value.length > maximum)
    throw new Invalid(
      "inbox-full",
      `This inbox can hold at most ${maximum} messages. No existing messages were removed. Export your messages before receiving more.`,
    );
  const ids = new Set<string>();
  return Array.from(value, (raw) => {
    const normalized = message(raw);
    if (ids.has(normalized.id))
      throw new Invalid("invalid-inbox", "Telegram IDs must be unique.");
    ids.add(normalized.id);
    return normalized;
  });
}
function serialize(value: unknown, maximum: number): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length > maximum || encoder.encode(json).byteLength > maximum)
    throw new Invalid(
      "too-large",
      "The telegram inbox exceeds its file size limit. Existing messages were left untouched.",
    );
  return json;
}
function normalize(value: unknown): SocialInbox {
  const raw = record(
    value,
    ["format", "version", "scope", "messages"],
    "Telegram inbox",
  );
  if (raw.format !== "wayfarer-inbox")
    throw new Invalid(
      "invalid-inbox",
      "This is not a Wayfarer telegram inbox.",
    );
  if (raw.version !== 1)
    throw new Invalid(
      "unsupported-version",
      "This telegram inbox version is not supported.",
    );
  return {
    format: "wayfarer-inbox",
    version: 1,
    scope: scope(raw.scope),
    messages: messages(raw.messages, SOCIAL_LIMITS.messages),
  };
}
function keyFor(identity: SocialScope): string {
  return `wayfarer:social-inbox-v1:${encodeURIComponent(JSON.stringify([identity.host, identity.port, identity.tls, identity.citizen]))}`;
}
export function socialInboxKey(identity: SocialScope): SocialResult<string> {
  return result(() => keyFor(scope(identity)));
}
export function encodeSocialInbox(
  identity: SocialScope,
  entries: readonly TelegramMessage[],
): SocialResult<string> {
  return result(() =>
    serialize(
      normalize({
        format: "wayfarer-inbox",
        version: 1,
        scope: identity,
        messages: entries,
      }),
      SOCIAL_LIMITS.fileBytes,
    ),
  );
}
export function decodeSocialInbox(json: string): SocialResult<SocialInbox> {
  return result(() => {
    if (typeof json !== "string")
      throw new Invalid("invalid-inbox", "Inbox must contain JSON text.");
    if (
      json.length > SOCIAL_LIMITS.fileBytes ||
      encoder.encode(json).byteLength > SOCIAL_LIMITS.fileBytes
    )
      throw new Invalid("too-large", "Inbox file exceeds 2 MB.");
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Invalid("invalid-inbox", "Inbox JSON is malformed.");
    }
    const inbox = normalize(raw);
    serialize(inbox, SOCIAL_LIMITS.fileBytes);
    return inbox;
  });
}
/** A portable, readable export may include unsaved overflow messages. It is not a connection configuration. */
export function encodeTelegramMessages(
  entries: readonly TelegramMessage[],
): SocialResult<string> {
  return result(() =>
    serialize(
      {
        format: "wayfarer-telegram-export",
        version: 1,
        messages: messages(entries, SOCIAL_LIMITS.exportMessages),
      },
      SOCIAL_LIMITS.exportBytes,
    ),
  );
}
function storageTarget(storage?: SocialStorage): SocialResult<SocialStorage> {
  try {
    const target = storage ?? globalThis.localStorage;
    if (
      !target ||
      typeof target.getItem !== "function" ||
      typeof target.setItem !== "function"
    )
      throw new Error("Unavailable");
    return { ok: true, value: target };
  } catch {
    return failure(
      "storage-unavailable",
      "Telegram storage is unavailable. Do not receive more messages; export those already in memory.",
    );
  }
}
function read(
  identity: SocialScope,
  storage: SocialStorage,
): SocialResult<TelegramMessage[]> {
  let saved: string | null;
  try {
    saved = storage.getItem(keyFor(identity));
  } catch {
    return failure(
      "storage-unavailable",
      "The saved inbox could not be read. Existing data was left untouched.",
    );
  }
  if (saved === null) return { ok: true, value: [] };
  const decoded = decodeSocialInbox(saved);
  if (!decoded.ok || keyFor(decoded.value.scope) !== keyFor(identity))
    return failure(
      "corrupt-storage",
      "The saved inbox is corrupt, unsupported or belongs to a different identity. It was left untouched. Do not receive more telegrams; export any messages already in memory.",
    );
  return { ok: true, value: decoded.value.messages };
}
export function loadSocialInbox(
  identity: SocialScope,
  storage?: SocialStorage,
): SocialResult<TelegramMessage[]> {
  const normalized = result(() => scope(identity));
  if (!normalized.ok) return normalized;
  const target = storageTarget(storage);
  if (!target.ok) return target;
  return read(normalized.value, target.value);
}
/** Merge only: never evict an older telegram or replace corrupt storage to make room. */
export function saveSocialInbox(
  identity: SocialScope,
  entries: readonly TelegramMessage[],
  storage?: SocialStorage,
): SocialResult<TelegramMessage[]> {
  const normalized = result(() => ({
    identity: scope(identity),
    entries: messages(entries, SOCIAL_LIMITS.messages),
  }));
  if (!normalized.ok) return normalized;
  const target = storageTarget(storage);
  if (!target.ok) return target;
  const existing = read(normalized.value.identity, target.value);
  if (!existing.ok) return existing;
  const merged = new Map(existing.value.map((entry) => [entry.id, entry]));
  for (const entry of normalized.value.entries) {
    const previous = merged.get(entry.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
      return failure(
        "message-conflict",
        "A telegram ID conflicts with an existing saved message. No message was overwritten.",
      );
    merged.set(entry.id, entry);
  }
  const encoded = encodeSocialInbox(normalized.value.identity, [
    ...merged.values(),
  ]);
  if (!encoded.ok) return encoded;
  try {
    target.value.setItem(keyFor(normalized.value.identity), encoded.value);
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? error.name
        : undefined;
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const quota =
      name === "QuotaExceededError" ||
      name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      code === 22 ||
      code === 1014;
    return failure(
      quota ? "quota-exceeded" : "storage-unavailable",
      "The telegram could not be saved on this device. Keep it in memory, stop receiving and export your messages before closing. Existing saved messages were left untouched.",
    );
  }
  return { ok: true, value: [...merged.values()] };
}
export function appendSocialMessage(
  identity: SocialScope,
  entry: TelegramMessage,
  storage?: SocialStorage,
): SocialResult<TelegramMessage[]> {
  return saveSocialInbox(identity, [entry], storage);
}

/** Destructive recovery is explicit and refuses to remove messages the caller has not seen. */
export function clearSocialInbox(
  identity: SocialScope,
  expectedSavedIds: readonly string[] | ReadonlySet<string>,
  storage?: SocialStorage,
): SocialResult<TelegramMessage[]> {
  const normalized = result(() => {
    const expected = Array.from(expectedSavedIds);
    if (
      expected.length > SOCIAL_LIMITS.exportMessages ||
      expected.some(
        (id) => typeof id !== "string" || !id.trim() || id.length > 128,
      ) ||
      new Set(expected).size !== expected.length
    )
      throw new Invalid(
        "invalid-inbox",
        "The expected saved message IDs are invalid.",
      );
    return { identity: scope(identity), expected: new Set(expected) };
  });
  if (!normalized.ok) return normalized;
  const target = storageTarget(storage);
  if (!target.ok) return target;
  const existing = read(normalized.value.identity, target.value);
  if (!existing.ok) return existing;
  if (
    existing.value.some((entry) => !normalized.value.expected.has(entry.id))
  ) {
    return failure(
      "message-conflict",
      "The saved inbox changed since it was loaded. Nothing was cleared. Reload and export the new messages before trying again.",
    );
  }
  const empty = encodeSocialInbox(normalized.value.identity, []);
  if (!empty.ok) return empty;
  try {
    target.value.setItem(keyFor(normalized.value.identity), empty.value);
  } catch {
    return failure(
      "storage-unavailable",
      "The inbox could not be cleared on this device. Existing messages were left untouched.",
    );
  }
  return { ok: true, value: [] };
}
