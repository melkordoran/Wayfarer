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
import type {
  ClientCommand,
  ClientEvent,
  TelegramMessage,
} from "../src/shared/types";
import {
  loadSocialInbox,
  socialInboxKey,
} from "../src/renderer/social-storage";
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
  setGesture: vi.fn(() => 0),
}));
const bus = vi.hoisted(() => ({
  listeners: new Set<(event: ClientEvent) => void>(),
  command: vi.fn<(command: ClientCommand) => Promise<void>>(),
}));
vi.mock("../src/renderer/engine", () => ({
  WorldEngine: vi.fn(function () {
    return fake;
  }),
}));
vi.mock("../src/renderer/client", () => ({
  bridge: {
    mode: "preview",
    asset: vi.fn(),
    command: bus.command,
    subscribe: (listener: (event: ClientEvent) => void) => {
      bus.listeners.add(listener);
      return () => bus.listeners.delete(listener);
    },
  },
}));
import App from "../src/renderer/App";
const scope = { host: "127.0.0.1", port: 16670, tls: false, citizen: 2 };
const received: TelegramMessage = {
  id: "received-one",
  direction: "incoming",
  from: "Explorer",
  to: "Wayfarer",
  text: "A local fixture telegram",
  time: 1_783_900_000_000,
  status: "received",
};
function emit(event: ClientEvent) {
  for (const listener of bus.listeners) listener(event);
}
beforeEach(() => {
  localStorage.clear();
  bus.listeners.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: vi.fn(),
    configurable: true,
  });
  bus.command.mockImplementation(async (command) => {
    if (command.type === "connect") {
      emit({ type: "login", citizen: 2, session: 10, name: "Wayfarer" });
      emit({ type: "status", phase: "connected", message: "Connected" });
      emit({ type: "telegram-pending", pending: true });
    }
    if (command.type === "telegram-fetch") {
      emit({ type: "telegram", message: received });
      emit({ type: "telegram-pending", pending: false });
    }
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  bus.command.mockReset();
});
async function connectAndOpen() {
  fireEvent.click(
    screen.getByRole("button", { name: "Connect to a universe" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Enter universe" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(
    screen.getByRole("button", { name: /Contacts and telegrams/ }),
  );
  fireEvent.click(screen.getByRole("tab", { name: /Messages/ }));
}
describe("telegram collection and local durability integration", () => {
  it("does not fetch on notification, then persists one explicitly received telegram", async () => {
    render(<App />);
    await connectAndOpen();
    expect(bus.command.mock.calls.map(([c]) => c.type)).toEqual(["connect"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Receive one telegram" }),
    );
    await screen.findByText(received.text);
    expect(loadSocialInbox(scope)).toEqual({ ok: true, value: [received] });
    expect(
      bus.command.mock.calls.filter(([c]) => c.type === "telegram-fetch"),
    ).toHaveLength(1);
  });
  it("does not consume anything when the saved inbox is corrupt", async () => {
    const key = socialInboxKey(scope);
    if (!key.ok) throw new Error(key.error.message);
    localStorage.setItem(key.value, "{broken");
    render(<App />);
    await connectAndOpen();
    expect(
      (
        screen.getByRole("button", {
          name: "Receive one telegram",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(localStorage.getItem(key.value)).toBe("{broken");
    expect(bus.command.mock.calls.map(([c]) => c.type)).toEqual(["connect"]);
  });
  it("keeps an unsaved received message visible and blocks unload after quota failure", async () => {
    render(<App />);
    await connectAndOpen();
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key.includes("social-inbox"))
        throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      return real.call(this, key, value);
    });
    act(() => emit({ type: "telegram", message: received }));
    await screen.findByText(received.text);
    expect(
      (
        screen.getByRole("button", {
          name: "Receive one telegram",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Export messages",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("retains the local inbox for reading and export when the universe disconnects", async () => {
    render(<App />);
    await connectAndOpen();
    fireEvent.click(
      screen.getByRole("button", { name: "Receive one telegram" }),
    );
    await screen.findByText(received.text);
    act(() =>
      emit({ type: "status", phase: "disconnected", message: "Offline" }),
    );
    expect(screen.getByText(received.text)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Check for one telegram",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Export messages",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("reopens the last saved inbox offline without logging in or collecting messages", async () => {
    const view = render(<App />);
    await connectAndOpen();
    fireEvent.click(
      screen.getByRole("button", { name: "Receive one telegram" }),
    );
    await screen.findByText(received.text);
    view.unmount();
    bus.command.mockClear();
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Contacts and telegrams" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: /Messages/ }));
    expect(screen.getByText(received.text)).toBeTruthy();
    expect(bus.command).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Check for one telegram",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
