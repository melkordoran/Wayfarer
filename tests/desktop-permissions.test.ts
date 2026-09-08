import { describe, expect, it } from "vitest";
import { allowViewportPermission } from "../src/main/security";

describe("desktop permission boundary", () => {
  const entry = "file:///application/dist/index.html";
  it.each(["pointerLock", "fullscreen"])(
    "allows first-party %s",
    (permission) => {
      expect(allowViewportPermission(permission, entry, entry, true)).toBe(
        true,
      );
      expect(
        allowViewportPermission(permission, entry + "#world", entry, true),
      ).toBe(true);
      expect(
        allowViewportPermission(
          permission,
          "https://untrusted.invalid/",
          entry,
          true,
        ),
      ).toBe(false);
      expect(allowViewportPermission(permission, entry, entry, false)).toBe(
        false,
      );
    },
  );
  it.each([
    "media",
    "geolocation",
    "clipboard-read",
    "notifications",
    "openExternal",
    "automatic-fullscreen",
  ])("denies unrelated %s", (permission) => {
    expect(allowViewportPermission(permission, entry, entry, true)).toBe(false);
  });
});
