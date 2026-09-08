import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberConnection,
  savedConnection,
  savedPlaces,
  readStored,
  coordinates,
  savedPreferences,
} from "../src/renderer/storage";

let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("local preferences and places", () => {
  it("defaults connected worlds to authored lighting while retaining the original studio look", () => {
    expect(savedPreferences()).toEqual({ time: "sunset", worldTime: "world", reticle: true, compact: false });
    saved.set("wayfarer:preferences", JSON.stringify({ time: "night", reticle: false, compact: true }));
    expect(savedPreferences()).toEqual({ time: "night", worldTime: "world", reticle: false, compact: true });
  });
  it.each(["world", "day", "sunset", "night"])("preserves explicit world display preference %s independently", worldTime => {
    saved.set("wayfarer:preferences", JSON.stringify({ time: "day", worldTime }));
    expect(savedPreferences()).toMatchObject({ time: "day", worldTime });
  });
  it.each([null, [], { time: "world", worldTime: "automatic" }, { time: 42, worldTime: {} }])("uses safe distinct defaults for malformed display preferences %j", value => {
    saved.set("wayfarer:preferences", JSON.stringify(value));
    expect(savedPreferences()).toMatchObject({ time: "sunset", worldTime: "world" });
  });
  it("never persists citizen passwords or tourist email addresses", () => {
    rememberConnection({
      host: "127.0.0.1",
      port: 16670,
      username: "Visitor",
      password: "not-for-storage",
      email: "private@example.invalid",
      tls: false,
      tourist: true,
    });
    const value = saved.get("wayfarer:connection")!;
    expect(value).not.toContain("not-for-storage");
    expect(value).not.toContain("private@");
    expect(savedConnection().password).toBe("");
  });
  it.each(["null", "[]", '"bad"', "malformed"])(
    "recovers from malformed stored connection %s",
    (value) => {
      saved.set("wayfarer:connection", value);
      expect(savedConnection().host).toBe("127.0.0.1");
    },
  );
  it("rejects invalid bookmark positions and handles unavailable storage", () => {
    saved.set(
      "wayfarer:places",
      JSON.stringify([
        { id: "bad", name: "bad", world: "Haven", position: { x: "NaN" } },
      ]),
    );
    expect(savedPlaces()).toEqual([]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(readStored("any", {})).toEqual({});
  });
  it("formats metre positions in AW 10m coordinates", () => {
    expect(coordinates({ x: -25, y: 15, z: 100, yaw: 0 })).toBe(
      "10.0N 2.5E 1.5a",
    );
  });
});
