// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand, ClientEvent } from "../src/shared/types";
import { createDemoWorld } from "../src/renderer/engine/demo";
const runtime = vi.hoisted(() => ({ options: null as any, listeners: new Set<(event: ClientEvent) => void>() }));
const fake = vi.hoisted(() => ({ setWorld: vi.fn(), updateWorld: vi.fn(), setObjects: vi.fn(), setTerrain: vi.fn(), teleport: vi.fn(), dispose: vi.fn(), setBuildMode: vi.fn(), setSelection: vi.fn(), setTransformMode: vi.fn(), setTransformSnap: vi.fn(), setTransformEnabled: vi.fn(), setTimeOfDay: vi.fn(), setWireframe: vi.fn(), setCameraMode: vi.fn(), setAvatarType: vi.fn(), setGesture: vi.fn(() => 0), setFlying: vi.fn() }));
const command = vi.hoisted(() => vi.fn<(value: ClientCommand) => Promise<void>>());
vi.mock("../src/renderer/engine", () => ({ WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) { runtime.options = options; return fake; }) }));
vi.mock("../src/renderer/client", () => ({ bridge: { mode: "preview", asset: vi.fn(), command, subscribe: (listener: (event: ClientEvent) => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } } }));
import App from "../src/renderer/App";
function emit(event: ClientEvent) { runtime.listeners.forEach(listener => listener(event)); }
const world = { ...createDemoWorld().settings, name: "Haven", title: "Haven", objectPath: "https://assets.example/", demo: false, canFly: false, allowFlying: false, fogEnabled: false };
beforeEach(() => {
  localStorage.clear(); runtime.listeners.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), configurable: true });
  command.mockImplementation(async value => {
    if (value.type === "connect") {
      emit({ type: "login", citizen: 3, session: 42, name: "Explorer" });
      emit({ type: "status", phase: "entering", message: "Entering" });
      emit({ type: "world", settings: world });
      emit({ type: "status", phase: "online", message: "Online" });
    }
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function connect() {
  fireEvent.click(screen.getByRole("button", { name: "Connect to a universe" }));
  fireEvent.click(screen.getByRole("button", { name: "Enter universe" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
describe("world-authored display integration", () => {
  it("migrates the old studio preset without overriding the connected world", async () => {
    localStorage.setItem("wayfarer:preferences", JSON.stringify({ time: "night" }));
    render(<App />); expect(fake.setTimeOfDay).toHaveBeenLastCalledWith("night");
    await connect(); expect(fake.setTimeOfDay).toHaveBeenLastCalledWith("world");
    expect(screen.getByRole("button", { name: "World lighting" })).toBeTruthy();
  });
  it("shows and clears an explicit local override without sending server settings", async () => {
    render(<App />); await connect();
    fireEvent.click(screen.getByRole("button", { name: "World lighting" }));
    expect(fake.setTimeOfDay).toHaveBeenLastCalledWith("day");
    expect(screen.getByRole("button", { name: /Daylight · local/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "World details" }));
    fireEvent.click(screen.getByRole("button", { name: "Follow world" }));
    expect(fake.setTimeOfDay).toHaveBeenLastCalledWith("world");
    expect(screen.getByText("Following world lighting")).toBeTruthy();
    expect(command.mock.calls.map(([value]) => value.type)).toEqual(["connect"]);
  });
  it("keeps studio and connected-world choices separate across return to studio", async () => {
    render(<App />); expect(fake.setTimeOfDay).toHaveBeenLastCalledWith("sunset"); await connect();
    fireEvent.click(screen.getByRole("button", { name: "World lighting" }));
    fireEvent.click(screen.getByRole("button", { name: "wayfarer." }));
    await waitFor(() => expect(fake.setTimeOfDay).toHaveBeenLastCalledWith("sunset"));
    expect(JSON.parse(localStorage.getItem("wayfarer:preferences")!)).toMatchObject({ time: "sunset", worldTime: "day" });
  });
  it("keeps current scenery on same-world attribute updates and reflects revoked flight", async () => {
    render(<App />); await connect(); const worldCalls = fake.setWorld.mock.calls.length;
    const disabled = screen.getByRole("button", { name: "Flying is disabled in this world" }); expect(disabled.hasAttribute("disabled")).toBe(true);
    act(() => emit({ type: "world", settings: { ...world, caretaker: true, canFly: true, fogEnabled: true, fogMax: 300 } }));
    expect(fake.setWorld).toHaveBeenCalledTimes(worldCalls); expect(fake.updateWorld).toHaveBeenCalledWith(expect.objectContaining({ canFly: true, fogMax: 300 }));
    fireEvent.click(screen.getByRole("button", { name: "Start flying (F)" })); expect(fake.setFlying).toHaveBeenCalledWith(true);
    act(() => runtime.options.onAction({ type: "flight-denied", value: "This world has disabled flying." }));
    expect(screen.getByText("This world has disabled flying.")).toBeTruthy();
  });
});
