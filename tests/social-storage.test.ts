import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramMessage } from "../src/shared/types";
import {
  appendSocialMessage,
  clearSocialInbox,
  decodeSocialInbox,
  encodeSocialInbox,
  encodeTelegramMessages,
  loadSocialInbox,
  saveSocialInbox,
  socialInboxKey,
  SOCIAL_LIMITS,
  type SocialScope,
  type SocialStorage,
} from "../src/renderer/social-storage";
const identity: SocialScope = {
  host: "127.0.0.1",
  port: 16670,
  tls: false,
  citizen: 3,
};
const telegram = (id = "one"): TelegramMessage => ({
  id,
  direction: "incoming",
  from: "Alice",
  to: "Explorer",
  text: "Hello\nfrom the world",
  time: 1000,
  status: "received",
});
function store() {
  const values = new Map<string, string>();
  const storage: SocialStorage = {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      values.set(key, value);
    }),
  };
  return { values, storage };
}
function key(scope = identity) {
  const result = socialInboxKey(scope);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function encoded(scope = identity, entries = [telegram()]) {
  const result = encodeSocialInbox(scope, entries);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
afterEach(() => vi.unstubAllGlobals());

describe("universe and citizen scoped telegram storage", () => {
  it("loads a missing inbox without writing and returns detached saved messages", () => {
    const memory = store();
    expect(loadSocialInbox(identity, memory.storage)).toEqual({
      ok: true,
      value: [],
    });
    expect(memory.storage.setItem).not.toHaveBeenCalled();
    const original = telegram();
    expect(saveSocialInbox(identity, [original], memory.storage).ok).toBe(true);
    original.text = "later changed";
    expect(loadSocialInbox(identity, memory.storage)).toEqual({
      ok: true,
      value: [telegram()],
    });
  });
  it.each([
    { ...identity, host: "other.example" },
    { ...identity, port: 16671 },
    { ...identity, tls: true },
    { ...identity, citizen: 4 },
  ])("isolates identity %j", (other) => {
    const memory = store();
    saveSocialInbox(identity, [telegram()], memory.storage);
    expect(loadSocialInbox(other, memory.storage)).toEqual({
      ok: true,
      value: [],
    });
    expect(key(other)).not.toBe(key());
  });
  it("normalizes case, trailing DNS dot and IPv6 brackets without combining TLS scopes", () => {
    expect(key({ ...identity, host: "  UNIVERSE.Example. " })).toBe(
      key({ ...identity, host: "universe.example" }),
    );
    expect(key({ ...identity, host: "[::1]" })).toBe(
      key({ ...identity, host: "::1" }),
    );
  });
  it.each([
    { ...identity, host: "https://host" },
    { ...identity, host: "user:secret@host" },
    { ...identity, host: "host/path" },
    { ...identity, citizen: 0 },
    { ...identity, port: 65536 },
    { ...identity, tls: "false" },
    { ...identity, password: "secret" },
  ])("rejects invalid identity or hidden credentials %j", (invalid) => {
    expect(socialInboxKey(invalid as SocialScope).ok).toBe(false);
  });
  it("merges without evicting older or concurrently appended messages", () => {
    const memory = store();
    appendSocialMessage(identity, telegram("one"), memory.storage);
    appendSocialMessage(identity, telegram("two"), memory.storage);
    const saved = saveSocialInbox(
      identity,
      [telegram("one"), telegram("three")],
      memory.storage,
    );
    expect(saved.ok && saved.value.map((entry) => entry.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(
      appendSocialMessage(identity, telegram("one"), memory.storage),
    ).toEqual(saved);
  });
  it("refuses same-ID content changes rather than overwriting a saved telegram", () => {
    const memory = store();
    appendSocialMessage(identity, telegram(), memory.storage);
    const before = memory.values.get(key());
    expect(
      appendSocialMessage(
        identity,
        { ...telegram(), text: "different" },
        memory.storage,
      ),
    ).toMatchObject({ ok: false, error: { code: "message-conflict" } });
    expect(memory.values.get(key())).toBe(before);
  });
  it.each([
    "{broken",
    "",
    '{"format":"wayfarer-inbox","version":99}',
    encoded({ ...identity, citizen: 4 }),
  ])("preserves corrupt, unsupported or mismatched inbox %s", (corrupt) => {
    const memory = store();
    memory.values.set(key(), corrupt);
    expect(loadSocialInbox(identity, memory.storage)).toMatchObject({
      ok: false,
      error: { code: "corrupt-storage" },
    });
    expect(
      appendSocialMessage(identity, telegram(), memory.storage),
    ).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
    expect(memory.values.get(key())).toBe(corrupt);
    expect(memory.storage.setItem).not.toHaveBeenCalled();
  });
  it("reports quota failure without losing the prior inbox or mutating the incoming message", () => {
    const memory = store();
    appendSocialMessage(identity, telegram(), memory.storage);
    const prior = memory.values.get(key()),
      incoming = telegram("new");
    memory.storage.setItem = () => {
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    };
    expect(
      appendSocialMessage(identity, incoming, memory.storage),
    ).toMatchObject({ ok: false, error: { code: "quota-exceeded" } });
    expect(memory.values.get(key())).toBe(prior);
    expect(incoming).toEqual(telegram("new"));
    expect(encodeTelegramMessages([telegram(), incoming]).ok).toBe(true);
  });
  it("never writes blindly when reading storage fails", () => {
    const memory = store();
    memory.storage.getItem = () => {
      throw new Error("denied");
    };
    expect(
      appendSocialMessage(identity, telegram(), memory.storage),
    ).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(memory.storage.setItem).not.toHaveBeenCalled();
  });
  it("reports unavailable default storage and supports injected browser storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadSocialInbox(identity)).toMatchObject({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    const memory = store();
    vi.stubGlobal("localStorage", memory.storage);
    expect(appendSocialMessage(identity, telegram()).ok).toBe(true);
    expect(loadSocialInbox(identity)).toEqual({
      ok: true,
      value: [telegram()],
    });
  });
  it("stops at its message cap without eviction and can export a volatile overflow message", () => {
    const memory = store(),
      full = Array.from({ length: SOCIAL_LIMITS.messages }, (_, i) =>
        telegram(String(i)),
      );
    expect(saveSocialInbox(identity, full, memory.storage).ok).toBe(true);
    const prior = memory.values.get(key());
    expect(
      appendSocialMessage(identity, telegram("overflow"), memory.storage),
    ).toMatchObject({ ok: false, error: { code: "inbox-full" } });
    expect(memory.values.get(key())).toBe(prior);
    expect(encodeTelegramMessages([...full, telegram("overflow")]).ok).toBe(
      true,
    );
  });
  it("clears only the explicitly expected saved messages and preserves other identities", () => {
    const memory = store(),
      other = { ...identity, citizen: 4 };
    saveSocialInbox(
      identity,
      [telegram("one"), telegram("two")],
      memory.storage,
    );
    saveSocialInbox(other, [telegram("other")], memory.storage);
    expect(
      clearSocialInbox(identity, new Set(["two", "one"]), memory.storage),
    ).toEqual({ ok: true, value: [] });
    expect(loadSocialInbox(identity, memory.storage)).toEqual({
      ok: true,
      value: [],
    });
    expect(loadSocialInbox(other, memory.storage)).toEqual({
      ok: true,
      value: [telegram("other")],
    });
  });
  it("refuses clearing any new unseen messages saved since the caller loaded", () => {
    const memory = store();
    appendSocialMessage(identity, telegram("one"), memory.storage);
    const expected = ["one"];
    appendSocialMessage(identity, telegram("unseen"), memory.storage);
    const prior = memory.values.get(key());
    expect(clearSocialInbox(identity, expected, memory.storage)).toMatchObject({
      ok: false,
      error: { code: "message-conflict" },
    });
    expect(memory.values.get(key())).toBe(prior);
  });
  it("allows acknowledged volatile IDs while only clearing already saved messages", () => {
    const memory = store();
    appendSocialMessage(identity, telegram("saved"), memory.storage);
    expect(
      clearSocialInbox(identity, ["saved", "exported-unsaved"], memory.storage),
    ).toEqual({ ok: true, value: [] });
    expect(loadSocialInbox(identity, memory.storage)).toEqual({
      ok: true,
      value: [],
    });
  });
  it("refuses clearing corrupt inboxes or invalid expected-ID lists", () => {
    const memory = store();
    memory.values.set(key(), "{broken");
    expect(clearSocialInbox(identity, [], memory.storage)).toMatchObject({
      ok: false,
      error: { code: "corrupt-storage" },
    });
    expect(clearSocialInbox(identity, ["one", "one"], memory.storage).ok).toBe(
      false,
    );
    expect(memory.values.get(key())).toBe("{broken");
    expect(memory.storage.setItem).not.toHaveBeenCalled();
  });
  it("reports failed clears without claiming messages were removed", () => {
    const memory = store();
    appendSocialMessage(identity, telegram(), memory.storage);
    const prior = memory.values.get(key());
    memory.storage.setItem = () => {
      throw new Error("denied");
    };
    expect(clearSocialInbox(identity, ["one"], memory.storage)).toMatchObject({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(memory.values.get(key())).toBe(prior);
  });
});

describe("validated readable telegram files", () => {
  it("round-trips outgoing submitted records and untrusted contact-request text without acting on it", () => {
    const request: TelegramMessage = {
      ...telegram(),
      text: "\n\x01(4)SocialTester",
      contactRequest: { citizen: 4, name: "SocialTester" },
    };
    const outgoing: TelegramMessage = {
      ...telegram("two"),
      direction: "outgoing",
      status: "submitted",
    };
    const json = encoded(identity, [request, outgoing]);
    expect(decodeSocialInbox(json)).toEqual({
      ok: true,
      value: {
        format: "wayfarer-inbox",
        version: 1,
        scope: identity,
        messages: [request, outgoing],
      },
    });
    const exported = encodeTelegramMessages([request, outgoing]);
    expect(exported.ok && JSON.parse(exported.value).messages).toEqual([
      request,
      outgoing,
    ]);
    request.contactRequest!.name = "Changed";
    expect(decodeSocialInbox(json).ok).toBe(true);
  });
  it.each(["null", "[]", '"hello"', "{malformed"])(
    "rejects malformed file %s",
    (input) => {
      expect(decodeSocialInbox(input).ok).toBe(false);
    },
  );
  it.each([
    { ...telegram(), status: "delivered" },
    { ...telegram(), direction: "outgoing" },
    { ...telegram(), id: "" },
    { ...telegram(), time: NaN },
    { ...telegram(), time: 0.5 },
    { ...telegram(), text: "x".repeat(1001) },
    { ...telegram(), credentials: "secret" },
    { ...telegram(), contactRequest: { citizen: 0, name: "No" } },
  ])("rejects invalid telegram %j", (entry) => {
    expect(encodeSocialInbox(identity, [entry as TelegramMessage]).ok).toBe(
      false,
    );
  });
  it("rejects duplicate IDs, sparse arrays, extra file fields and unsupported versions", () => {
    expect(encodeSocialInbox(identity, [telegram(), telegram()]).ok).toBe(
      false,
    );
    expect(encodeSocialInbox(identity, Array(1)).ok).toBe(false);
    const raw = JSON.parse(encoded());
    expect(
      decodeSocialInbox(JSON.stringify({ ...raw, password: "secret" })).ok,
    ).toBe(false);
    expect(
      decodeSocialInbox(JSON.stringify({ ...raw, version: 2 })),
    ).toMatchObject({ ok: false, error: { code: "unsupported-version" } });
  });
  it("bounds raw and encoded UTF-8 size as well as message count", () => {
    expect(
      decodeSocialInbox(" ".repeat(SOCIAL_LIMITS.fileBytes + 1)),
    ).toMatchObject({ ok: false, error: { code: "too-large" } });
    const large = Array.from({ length: 500 }, (_, i) => ({
      ...telegram(String(i)),
      text: "世".repeat(1000),
      from: "世".repeat(255),
      to: "世".repeat(255),
    }));
    expect(encodeSocialInbox(identity, large)).toMatchObject({
      ok: false,
      error: { code: "too-large" },
    });
    expect(
      encodeTelegramMessages(
        Array.from({ length: 1001 }, (_, i) => telegram(String(i))),
      ),
    ).toMatchObject({ ok: false, error: { code: "inbox-full" } });
  });
});
