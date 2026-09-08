// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const fake = vi.hoisted(() => ({
  setWorld: vi.fn(),
  setObjects: vi.fn(),
  setTerrain: vi.fn(),
  teleport: vi.fn(),
  dispose: vi.fn(),
  setBuildMode: vi.fn(),
  setSelected: vi.fn(),
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
vi.mock("../src/renderer/engine", () => ({
  WorldEngine: vi.fn(function () {
    return fake;
  }),
}));
vi.mock("../src/renderer/client", () => ({
  bridge: {
    mode: "preview",
    subscribe: () => () => {},
    command: vi.fn(),
    asset: vi.fn(),
  },
}));
import App from "../src/renderer/App";
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: vi.fn(),
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("offline studio navigation", () => {
  it("does not rebuild or erase a studio when its existing card or brand is clicked", () => {
    render(<App />);
    const builds = fake.setObjects.mock.calls.length;
    expect(builds).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "wayfarer." }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /The Commons A little room to imagine/,
      }),
    );
    expect(fake.setObjects).toHaveBeenCalledTimes(builds);
    expect(fake.teleport.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
