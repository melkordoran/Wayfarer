// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldDetailsDialog, displayObjectPath } from "../src/renderer/components/WorldDetailsDialog";
import { createDemoWorld } from "../src/renderer/engine/demo";
afterEach(cleanup);
const settings = { ...createDemoWorld().settings, demo: false, canSpeak: false, caretaker: true, allowFlying: false, canFly: true, objectPath: "https://hidden-user:hidden-password@objects.example/world/?token=secret#private", fogEnabled: false, waterColor: "#123456", waterOpacity: 128 / 255, rawAttributes: { 74: "do-not-show-object-password" } };
function show(props: Partial<Parameters<typeof WorldDetailsDialog>[0]> = {}) { return render(<WorldDetailsDialog settings={settings} studio={false} environmentMode="world" onFollowWorld={vi.fn()} onClose={vi.fn()} {...props} />); }
describe("read-only world details", () => {
  it("hides credential/query/fragment data and never renders raw attributes or live links", () => {
    const { container } = show();
    expect(screen.getByText(/https:\/\/objects.example\/world\//)).toBeTruthy();
    for (const secret of ["hidden-user", "hidden-password", "secret", "#private", "do-not-show-object-password"]) expect(container.textContent).not.toContain(secret);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("input,select,textarea")).toHaveLength(0);
  });
  it("shows attributes separately from effective capabilities and local override", () => {
    const follow = vi.fn(); show({ environmentMode: "night", onFollowWorld: follow });
    expect(screen.getByText("Local lighting override active")).toBeTruthy();
    expect(screen.getByText("World flying rule").nextElementSibling?.textContent).toBe("No");
    expect(screen.getByText("You can fly").nextElementSibling?.textContent).toBe("Yes");
    expect(screen.getByText("Owner").nextElementSibling?.textContent).toBe("Not provided");
    expect(screen.getByText("Fog enabled").nextElementSibling?.textContent).toBe("No");
    expect(screen.getByText("Opacity").nextElementSibling?.textContent).toBe("50.196%");
    fireEvent.click(screen.getByRole("button", { name: "Follow world" })); expect(follow).toHaveBeenCalledTimes(1);
  });
  it("does not offer a server-lighting action in the studio", () => {
    show({ studio: true, environmentMode: "sunset" });
    expect(screen.getByText("Your local studio look")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Follow world" })).toBeNull();
    expect(screen.getByText("Original bundled studio assets")).toBeTruthy();
  });
  it("labels retained attributes as stale after leaving the world", () => {
    show({ online: false }); expect(screen.getByText(/last received attributes · not connected/)).toBeTruthy();
  });
  it("distinguishes no-world state and closes without a mutation", () => {
    const close = vi.fn(); show({ settings: null, onClose: close });
    expect(screen.getByText("No world attributes are available yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" })); expect(close).toHaveBeenCalledOnce();
  });
  it("renders welcome text inertly and caps displayed warning count", () => {
    const { container } = show({ settings: { ...settings, welcome: '<img src=x onerror="alert(1)">', environmentWarnings: Array.from({ length: 40 }, (_, index) => `Attribute note ${index}`) } });
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
    expect(container.querySelector("img")).toBeNull(); expect(container.querySelectorAll("li")).toHaveLength(32);
  });
  it.each(["javascript:alert(1)", "file:///private/data", "unparseable", ""])("does not expose an unsafe or malformed object path %s", path => {
    const value = displayObjectPath(path); expect(value).not.toContain("private/data"); expect(value).not.toContain("alert(1)"); expect(value).not.toContain("unparseable");
  });
});
