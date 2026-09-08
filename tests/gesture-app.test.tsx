// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand, ClientEvent } from "../src/shared/types";
import type { GesturePlaybackState } from "../src/renderer/engine";
const runtime = vi.hoisted(() => ({
  options: null as any,
  requestId: 0,
  listeners: new Set<(value: ClientEvent) => void>(),
}));
const catalog = {
  version: 3,
  warnings: [],
  entries: [0, 1].map((index) => ({
    index,
    name: `Original ${index}`,
    geometry: "original.rwx",
    autoLook: false,
    autoWalk: true,
    implicit: {},
    explicit: [
      { name: "Wave", sequence: "wave" },
      { name: "Bow", sequence: "bow" },
    ],
  })),
};
const fake = vi.hoisted(() => ({
  setWorld: vi.fn(),
  updateWorld: vi.fn(),
  setObjects: vi.fn(),
  setTerrain: vi.fn(),
  teleport: vi.fn(),
  dispose: vi.fn(),
  setBuildMode: vi.fn(),
  setSelection: vi.fn(),
  setTransformMode: vi.fn(),
  setTransformSnap: vi.fn(),
  setTransformEnabled: vi.fn(),
  setTimeOfDay: vi.fn(),
  setWireframe: vi.fn(),
  setCameraMode: vi.fn(),
  setAvatarType: vi.fn(),
  setGesture: vi.fn(),
  getPosition: vi.fn(() => ({ x: 0, y: 0, z: 0, yaw: 0 })),
}));
const command = vi.hoisted(() =>
  vi.fn<(command: ClientCommand) => Promise<void>>(),
);
vi.mock("../src/renderer/engine", () => ({
  WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) {
    runtime.options = options;
    return fake;
  }),
}));
vi.mock("../src/renderer/client", () => ({
  bridge: {
    mode: "preview",
    asset: vi.fn(),
    command,
    subscribe: (listener: (value: ClientEvent) => void) => {
      runtime.listeners.add(listener);
      return () => runtime.listeners.delete(listener);
    },
  },
}));
import App from "../src/renderer/App";
import { createDemoWorld } from "../src/renderer/engine/demo";
function emit(value: ClientEvent) {
  runtime.listeners.forEach((listener) => listener(value));
}
function playback(value: GesturePlaybackState) {
  act(() => runtime.options.onGestureState(value));
}
const haven = (objectPath = "https://assets.example/") => ({
  ...createDemoWorld().settings,
  name: "Haven",
  title: "Haven",
  objectPath,
  demo: false,
});
async function dispatch(value: ClientCommand) {
  if (value.type === "connect") {
    emit({ type: "login", name: "Explorer", citizen: 3, session: 42 });
    emit({ type: "status", phase: "entering", message: "Entering" });
    emit({ type: "world", settings: haven() });
    // Initial world entry publishes the type actually submitted by the adapter,
    // even when it is unchanged from its initial zero. Offline UI state is not it.
    emit({ type: "local-avatar", avatar: 0, gesture: 0, source: "submitted" });
    emit({ type: "status", phase: "online", message: "Online" });
  } else if (value.type === "avatar-select") {
    emit({
      type: "local-avatar",
      avatar: value.avatar,
      gesture: 0,
      source: "submitted",
    });
  }
}
beforeEach(() => {
  localStorage.clear();
  runtime.listeners.clear();
  runtime.requestId = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: vi.fn(),
    configurable: true,
  });
  fake.setWorld.mockImplementation(() =>
    runtime.options.onAvatarCatalog(catalog),
  );
  fake.setGesture.mockImplementation((gesture: number) => {
    const requestId = ++runtime.requestId;
    runtime.options.onGestureState({
      requestId,
      gesture,
      phase: gesture ? "loading" : "idle",
    });
    return requestId;
  });
  command.mockImplementation(dispatch);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
async function connect() {
  fireEvent.click(
    screen.getByRole("button", { name: "Connect to a universe" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Enter universe" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
async function play(name = "Wave") {
  fireEvent.click(screen.getByRole("button", { name: "Avatar gestures" }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return runtime.requestId;
}
const gestureCommands = () =>
  command.mock.calls
    .map(([value]) => value)
    .filter((value) => value.type === "gesture");
const selectedAvatar = (index: number) =>
  screen.getByTitle(`Choose Original ${index}, avatar ${index}`);
function openAvatars() {
  fireEvent.click(screen.getByTitle("Change avatar"));
}
async function closeAvatars() {
  fireEvent.click(screen.getByRole("button", { name: "That’s me" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
describe("gesture playback and scoped protocol handoff", () => {
  it('submits an explicit X catalog motion at its existing ordinal and clears it after playback', async () => {
    render(<App />); await connect();
    act(() => runtime.options.onAvatarCatalog({ ...catalog, entries: catalog.entries.map(entry => ({ ...entry, explicit: [...entry.explicit, { name: 'X Salute', sequence: 'salute.x' }] })) }));
    const requestId = await play('X Salute');
    expect(gestureCommands()).toEqual([{ type: 'gesture', gesture: 3, avatar: 0, world: 'Haven', session: 42 }]);
    expect(fake.setGesture).toHaveBeenLastCalledWith(3);
    playback({ requestId, gesture: 3, phase: 'playing' });
    playback({ requestId, gesture: 3, phase: 'idle', reason: 'completed' });
    await waitFor(() => expect(gestureCommands()).toHaveLength(2));
    expect(gestureCommands()[1]).toMatchObject({ gesture: 0, avatar: 0, world: 'Haven', session: 42 });
  });
  it("plays and stops original studio motion without a bridge command", async () => {
    render(<App />);
    const requestId = await play();
    expect(fake.setGesture).toHaveBeenLastCalledWith(1);
    expect(fake.setCameraMode).toHaveBeenCalledWith("third-person");
    playback({ requestId, gesture: 1, phase: "playing" });
    expect(screen.getByText("Playing locally")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    expect(fake.setGesture).toHaveBeenLastCalledWith(0);
    expect(command).not.toHaveBeenCalled();
  });
  it("sends the guarded index, then clears on matching local completion", async () => {
    render(<App />);
    await connect();
    const requestId = await play("Bow");
    expect(gestureCommands()).toEqual([
      { type: "gesture", gesture: 2, avatar: 0, world: "Haven", session: 42 },
    ]);
    playback({ requestId, gesture: 2, phase: "idle", reason: "completed" });
    await waitFor(() => expect(gestureCommands()).toHaveLength(2));
    expect(gestureCommands()[1]).toMatchObject({
      gesture: 0,
      avatar: 0,
      world: "Haven",
      session: 42,
    });
  });
  it("ignores an older playback completion after a new gesture starts", async () => {
    render(<App />);
    await connect();
    const old = await play();
    const current = await play("Bow");
    playback({
      requestId: old,
      gesture: 1,
      phase: "idle",
      reason: "completed",
    });
    expect(gestureCommands().map((value) => value.gesture)).toEqual([1, 2]);
    playback({
      requestId: current,
      gesture: 2,
      phase: "idle",
      reason: "completed",
    });
    await waitFor(() =>
      expect(gestureCommands().map((value) => value.gesture)).toEqual([
        1, 2, 0,
      ]),
    );
  });
  it("does not start local playback after failed command dispatch", async () => {
    render(<App />);
    await connect();
    command.mockRejectedValueOnce(new Error("Socket unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Avatar gestures" }));
    fireEvent.click(screen.getByRole("button", { name: /^Wave/ }));
    await screen.findByText("Socket unavailable");
    expect(fake.setGesture.mock.calls.some(([index]) => index > 0)).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry clear" })).toBeTruthy();
  });
  it("offers retry after a failed neutral-state send, without replaying motion", async () => {
    render(<App />);
    await connect();
    const requestId = await play();
    command.mockRejectedValueOnce(new Error("Write failed"));
    playback({ requestId, gesture: 1, phase: "idle", reason: "completed" });
    const retry = await screen.findByRole("button", { name: "Retry clear" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry clear" })).toBeNull(),
    );
    expect(gestureCommands().map((value) => value.gesture)).toEqual([1, 0, 0]);
    expect(
      fake.setGesture.mock.calls.filter(([index]) => index > 0),
    ).toHaveLength(1);
  });
  it("does not clear an old request after disconnect", async () => {
    render(<App />);
    await connect();
    const requestId = await play();
    act(() =>
      emit({
        type: "status",
        phase: "connected",
        message: "World disconnected",
      }),
    );
    playback({ requestId, gesture: 1, phase: "idle", reason: "completed" });
    expect(gestureCommands().map((value) => value.gesture)).toEqual([1]);
  });
  it("does not start delayed playback after the World changes", async () => {
    render(<App />);
    await connect();
    let finish!: () => void;
    command.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Avatar gestures" }));
    fireEvent.click(screen.getByRole("button", { name: /^Wave/ }));
    act(() =>
      emit({
        type: "world",
        settings: {
          ...createDemoWorld().settings,
          name: "Elsewhere",
          demo: false,
        },
      }),
    );
    await act(async () => finish());
    expect(fake.setGesture.mock.calls.some(([index]) => index > 0)).toBe(false);
  });
  it("retains neutral recovery when replacing an active gesture fails, without replaying either motion", async () => {
    render(<App />);
    await connect();
    const requestId = await play();
    playback({ requestId, gesture: 1, phase: "playing" });
    command.mockRejectedValueOnce(new Error("Replacement dispatch failed"));
    fireEvent.click(screen.getByRole("button", { name: "Avatar gestures" }));
    fireEvent.click(screen.getByRole("button", { name: /^Bow/ }));
    await screen.findByText("Replacement dispatch failed");
    expect(gestureCommands().map((value) => value.gesture)).toEqual([1, 2]);
    expect(
      fake.setGesture.mock.calls
        .filter(([index]) => index > 0)
        .map(([index]) => index),
    ).toEqual([1]);
    expect(fake.setGesture).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("button", { name: "Retry clear" })).toBeTruthy();

    // The failed attempt may have reached the wire, so another positive gesture
    // must not be sent until the user deliberately clears the uncertain state.
    fireEvent.click(screen.getByRole("button", { name: /^Bow/ }));
    await screen.findByText(
      "Retry clearing the previous gesture state before starting another motion.",
    );
    expect(gestureCommands()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry clear" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry clear" })).toBeNull(),
    );
    expect(gestureCommands()).toEqual([
      { type: "gesture", gesture: 1, avatar: 0, world: "Haven", session: 42 },
      { type: "gesture", gesture: 2, avatar: 0, world: "Haven", session: 42 },
      { type: "gesture", gesture: 0, avatar: 0, world: "Haven", session: 42 },
    ]);
    expect(
      fake.setGesture.mock.calls.filter(([index]) => index > 0),
    ).toHaveLength(1);
    playback({ requestId, gesture: 1, phase: "idle", reason: "completed" });
    expect(gestureCommands()).toHaveLength(3);
  });

  it("adopts the entered network avatar after an offline choice before submitting a gesture", async () => {
    render(<App />);
    openAvatars();
    fireEvent.click(selectedAvatar(1));
    await waitFor(() =>
      expect(selectedAvatar(1).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(fake.setAvatarType).toHaveBeenLastCalledWith(1);
    expect(command).not.toHaveBeenCalled();
    await closeAvatars();
    await connect();
    await waitFor(() => expect(fake.setAvatarType).toHaveBeenLastCalledWith(0));
    openAvatars();
    expect(selectedAvatar(0).getAttribute("aria-pressed")).toBe("true");
    expect(selectedAvatar(1).getAttribute("aria-pressed")).toBe("false");
    await closeAvatars();
    await play("Bow");
    expect(gestureCommands()).toEqual([
      { type: "gesture", gesture: 2, avatar: 0, world: "Haven", session: 42 },
    ]);
    expect(
      command.mock.calls.some(([value]) => value.type === "avatar-select"),
    ).toBe(false);
  });

  it("clears a delayed old object-path gesture without playing its ordinal in the replacement catalog", async () => {
    render(<App />);
    await connect();
    let finish!: () => void;
    command.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Avatar gestures" }));
    fireEvent.click(screen.getByRole("button", { name: /^Wave/ }));
    expect(gestureCommands()).toHaveLength(1);
    act(() => {
      emit({ type: "world", settings: haven("https://replacement.example/") });
      runtime.options.onAvatarCatalog({
        ...catalog,
        entries: catalog.entries.map((entry) => ({
          ...entry,
          explicit: [{ name: "Different first motion", sequence: "different" }],
        })),
      });
    });
    await act(async () => finish());
    await waitFor(() => expect(gestureCommands()).toHaveLength(2));
    expect(gestureCommands().map((value) => value.gesture)).toEqual([1, 0]);
    expect(gestureCommands()[1]).toMatchObject({
      avatar: 0,
      world: "Haven",
      session: 42,
    });
    expect(fake.setGesture.mock.calls.some(([index]) => index > 0)).toBe(false);
    expect(
      screen.getByRole("button", { name: /^Different first motion/ }),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry clear" })).toBeNull();
  });

  it("preserves the old selected avatar and neutral recovery when online selection fails", async () => {
    render(<App />);
    await connect();
    const requestId = await play();
    command.mockRejectedValueOnce(new Error("Neutral write failed"));
    playback({ requestId, gesture: 1, phase: "idle", reason: "completed" });
    const retry = await screen.findByRole("button", { name: "Retry clear" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    openAvatars();
    command.mockRejectedValueOnce(new Error("Avatar selection failed"));
    fireEvent.click(selectedAvatar(1));
    await screen.findByText("Avatar selection failed");
    expect(selectedAvatar(0).getAttribute("aria-pressed")).toBe("true");
    expect(selectedAvatar(1).getAttribute("aria-pressed")).toBe("false");
    expect(fake.setAvatarType).toHaveBeenLastCalledWith(0);
    expect(command).toHaveBeenLastCalledWith({
      type: "avatar-select",
      avatar: 1,
      world: "Haven",
      session: 42,
    });
    expect(screen.getByRole("button", { name: "Retry clear" })).toBeTruthy();
    await closeAvatars();
    fireEvent.click(screen.getByRole("button", { name: "Retry clear" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry clear" })).toBeNull(),
    );
    expect(gestureCommands().at(-1)).toEqual({
      type: "gesture",
      gesture: 0,
      avatar: 0,
      world: "Haven",
      session: 42,
    });
    expect(
      fake.setGesture.mock.calls.filter(([index]) => index > 0),
    ).toHaveLength(1);
  });

  it("adopts an online avatar selection only after successful scoped dispatch", async () => {
    render(<App />);
    await connect();
    let finish!: () => void;
    command.mockImplementationOnce(async (value) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await dispatch(value);
    });
    openAvatars();
    fireEvent.click(selectedAvatar(1));
    expect(selectedAvatar(0).getAttribute("aria-pressed")).toBe("true");
    expect(fake.setAvatarType).toHaveBeenLastCalledWith(0);
    expect(command).toHaveBeenLastCalledWith({
      type: "avatar-select",
      avatar: 1,
      world: "Haven",
      session: 42,
    });
    await act(async () => finish());
    await waitFor(() =>
      expect(selectedAvatar(1).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(fake.setAvatarType).toHaveBeenLastCalledWith(1);
    await closeAvatars();
    await play();
    expect(gestureCommands()).toEqual([
      { type: "gesture", gesture: 1, avatar: 1, world: "Haven", session: 42 },
    ]);
  });
});
