import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestTerrainMutation } from "../src/renderer/terrain-mutations";
import type {
  ClientBridge,
  ClientCommand,
  ClientEvent,
} from "../src/shared/types";
import type { TerrainSetCommand } from "../src/shared/terrain-edit";

const command = (
  changes: Partial<TerrainSetCommand> = {},
): TerrainSetCommand => ({
  type: "terrain-set",
  requestId: "terrain-test",
  world: "Haven",
  session: 41,
  cellX: -65,
  cellZ: 64,
  heights: [0.29, -0.12],
  texture: 65535,
  previousHeights: [0, 0],
  previousTextures: [0, 0],
  ...changes,
});
type Result = Extract<ClientEvent, { type: "terrain-result" }>;
const result = (changes: Partial<Result> = {}): Result => ({
  type: "terrain-result",
  requestId: "terrain-test",
  world: "Haven",
  session: 41,
  cellX: -65,
  cellZ: 64,
  heights: [0.29, -0.12],
  textures: [65535, 65535],
  status: "verified",
  ...changes,
});
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const listeners = new Set<(event: ClientEvent) => void>(),
    unsubscribed = vi.fn();
  const bridge: ClientBridge = {
    mode: "preview",
    command: vi.fn(async (_command: ClientCommand) => {}),
    asset: vi.fn(),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribed();
      };
    }),
  };
  const emit = (event: ClientEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { bridge, listeners, unsubscribed, emit };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("terrain canonical result and IPC handoff", () => {
  it("subscribes before dispatch and waits for both an early canonical event and IPC", async () => {
    const view = setup(),
      ipc = deferred();
    vi.mocked(view.bridge.command).mockImplementation(() => {
      expect(view.listeners.size).toBe(1);
      view.emit(result());
      return ipc.promise;
    });
    const pending = requestTerrainMutation(view.bridge, command());
    const settled = vi.fn();
    void pending.then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(view.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    ipc.resolve();
    expect(await pending).toEqual({
      cellX: -65,
      cellZ: 64,
      heights: [0.29, -0.12],
      textures: [65535, 65535],
    });
    expect(view.listeners.size).toBe(0);
    expect(view.unsubscribed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for the canonical event after IPC completion", async () => {
    const view = setup(),
      settled = vi.fn();
    const pending = requestTerrainMutation(view.bridge, command());
    void pending.then(settled);
    await flush();
    expect(view.bridge.command).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    view.emit(result());
    await pending;
    expect(view.listeners.size).toBe(0);
  });
  it("accepts normalized world-name casing while retaining exact session and row coordinates", async () => {
    const view = setup();
    const pending = requestTerrainMutation(
      view.bridge,
      command({ world: " haven " }),
    );
    await flush();
    view.emit(result({ world: "HAVEN" }));
    expect(await pending).toMatchObject({ cellX: -65, cellZ: 64 });
  });
  it("copies canonical arrays so late producer changes cannot rewrite history", async () => {
    const view = setup(),
      event = result();
    const pending = requestTerrainMutation(view.bridge, command());
    await flush();
    view.emit(event);
    event.heights[0] = 999;
    event.textures[0] = 0;
    expect(await pending).toEqual({
      cellX: -65,
      cellZ: 64,
      heights: [0.29, -0.12],
      textures: [65535, 65535],
    });
  });
  it("copies the submitted command and arrays before the dispatch microtask", async () => {
    const view = setup(),
      input = command();
    const pending = requestTerrainMutation(view.bridge, input);
    input.heights[0] = 5;
    input.previousHeights[0] = 5;
    input.texture = 2;
    input.world = "Elsewhere";
    input.requestId = "changed";
    await flush();
    expect(view.bridge.command).toHaveBeenCalledWith(command());
    view.emit(result());
    await pending;
  });
  it("ignores unrelated/stale result IDs and ordinary events", async () => {
    const view = setup(),
      settled = vi.fn();
    const pending = requestTerrainMutation(view.bridge, command());
    void pending.then(settled);
    await flush();
    view.emit(
      result({ requestId: "old-request", world: "Other", status: "conflict" }),
    );
    view.emit({ type: "query-complete" });
    view.emit({ type: "status", phase: "online", message: "ready" });
    await flush();
    expect(settled).not.toHaveBeenCalled();
    view.emit(result());
    await pending;
  });
  it.each([
    ["world", { world: "Elsewhere" }],
    ["session", { session: 42 }],
    ["cell X", { cellX: -64 }],
    ["cell Z", { cellZ: 63 }],
    ["conflict", { status: "conflict" }],
    ["unknown status", { status: "submitted" }],
  ])(
    "rejects a matching request with incorrect %s",
    async (_label, changes) => {
      const view = setup();
      const pending = requestTerrainMutation(view.bridge, command());
      pending.catch(() => {});
      await flush();
      view.emit(result(changes as Partial<Result>));
      await expect(pending).rejects.toThrow(/Terrain|terrain/);
      expect(view.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(view.bridge.command).toHaveBeenCalledTimes(1);
    },
  );
});

describe("terrain result runtime validation", () => {
  it.each([
    ["null world", { world: null }],
    ["numeric world", { world: 42 }],
    ["missing world", { world: undefined }],
    ["fractional session", { session: 41.5 }],
    ["string session", { session: "41" }],
    ["nonfinite X", { cellX: NaN }],
    ["string Z", { cellZ: "64" }],
    ["missing heights", { heights: undefined }],
    ["null heights", { heights: null }],
    ["object heights", { heights: {} }],
    ["string heights", { heights: "ab" }],
    ["empty heights", { heights: [] }],
    ["short heights", { heights: [0.29] }],
    ["long heights", { heights: [0.29, -0.12, 0] }],
    ["NaN height", { heights: [NaN, -0.12] }],
    ["infinite height", { heights: [Infinity, -0.12] }],
    ["string height", { heights: [".29", -0.12] }],
    ["sub-centimetre height", { heights: [0.291, -0.12] }],
    ["out-of-range height", { heights: [21474836.48, -0.12] }],
    ["different verified height", { heights: [0.3, -0.12] }],
    ["missing textures", { textures: undefined }],
    ["null textures", { textures: null }],
    ["object textures", { textures: {} }],
    ["short textures", { textures: [65535] }],
    ["long textures", { textures: [65535, 65535, 65535] }],
    ["negative texture", { textures: [-1, 65535] }],
    ["oversized texture", { textures: [65536, 65535] }],
    ["fractional texture", { textures: [1.5, 65535] }],
    ["string texture", { textures: ["65535", 65535] }],
    ["different verified texture", { textures: [0, 65535] }],
  ])(
    "rejects %s without throwing out of the event listener",
    async (_label, changes) => {
      const view = setup();
      const pending = requestTerrainMutation(view.bridge, command());
      pending.catch(() => {});
      await flush();
      expect(() =>
        view.emit({ ...result(), ...changes } as unknown as ClientEvent),
      ).not.toThrow();
      await expect(pending).rejects.toThrow();
      expect(view.listeners.size).toBe(0);
      expect(view.unsubscribed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("rejects non-plain matching result objects", async () => {
    const view = setup();
    const pending = requestTerrainMutation(view.bridge, command());
    pending.catch(() => {});
    await flush();
    const event = Object.assign(new Date(), result());
    expect(() => view.emit(event)).not.toThrow();
    await expect(pending).rejects.toThrow("plain");
  });
  it("rejects malformed commands before subscribing or sending", async () => {
    const view = setup();
    await expect(
      requestTerrainMutation(view.bridge, command({ heights: [0.001, 0] })),
    ).rejects.toThrow();
    expect(view.bridge.subscribe).not.toHaveBeenCalled();
    expect(view.bridge.command).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("terrain lifecycle cancellation and cleanup", () => {
  it.each([
    "disconnected",
    "connecting",
    "authenticating",
    "connected",
    "entering",
  ] as const)(
    "cancels on %s while an early result waits for IPC",
    async (phase) => {
      const view = setup(),
        ipc = deferred();
      vi.mocked(view.bridge.command).mockReturnValue(ipc.promise);
      const pending = requestTerrainMutation(view.bridge, command());
      pending.catch(() => {});
      await flush();
      view.emit(result());
      view.emit({ type: "status", phase, message: phase });
      await expect(pending).rejects.toThrow("connection changed");
      ipc.resolve();
      await flush();
      expect(view.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not dispatch a queued IPC command after same-turn disconnect", async () => {
    const view = setup();
    const pending = requestTerrainMutation(view.bridge, command());
    pending.catch(() => {});
    view.emit({
      type: "status",
      phase: "disconnected",
      message: "Disconnected",
    });
    await expect(pending).rejects.toThrow("connection changed");
    expect(view.bridge.command).not.toHaveBeenCalled();
    expect(view.listeners.size).toBe(0);
  });
  it("does not dispatch after a malformed matching result cancels the same-turn request", async () => {
    const view = setup();
    const pending = requestTerrainMutation(view.bridge, command());
    pending.catch(() => {});
    view.emit(result({ heights: [] }));
    await expect(pending).rejects.toThrow();
    expect(view.bridge.command).not.toHaveBeenCalled();
  });
  it("cancels same-world re-entry even when the Universe session is unchanged", async () => {
    const view = setup(),
      ipc = deferred();
    vi.mocked(view.bridge.command).mockReturnValue(ipc.promise);
    const pending = requestTerrainMutation(view.bridge, command());
    pending.catch(() => {});
    await flush();
    view.emit(result());
    view.emit({ type: "status", phase: "entering", message: "Entering Haven" });
    view.emit({ type: "status", phase: "online", message: "Haven" });
    ipc.resolve();
    await expect(pending).rejects.toThrow("connection changed");
    expect(view.listeners.size).toBe(0);
    // The wire scope is only world + Universe session, not a world-entry epoch.
    // App.applyTerrain must additionally compare currentInspectorScope before
    // dispatch and after await; this helper cannot infer an unannounced re-entry.
  });
  it("times out missing readback with no retries and removes the listener", async () => {
    const view = setup();
    const pending = requestTerrainMutation(view.bridge, command(), 100);
    pending.catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).rejects.toThrow("uncertain");
    expect(view.bridge.command).toHaveBeenCalledTimes(1);
    expect(view.listeners.size).toBe(0);
    expect(view.unsubscribed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    view.emit(result());
    await flush();
    expect(view.bridge.command).toHaveBeenCalledTimes(1);
  });
  it("keeps the aggregate timeout alive after canonical result while IPC is unresolved", async () => {
    const view = setup(),
      ipc = deferred();
    vi.mocked(view.bridge.command).mockReturnValue(ipc.promise);
    const pending = requestTerrainMutation(view.bridge, command(), 100);
    pending.catch(() => {});
    await flush();
    view.emit(result());
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).rejects.toThrow("uncertain");
    ipc.reject(new Error("late IPC failure"));
    await flush();
    expect(view.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up an IPC rejection even after canonical data arrived", async () => {
    const view = setup(),
      ipc = deferred();
    vi.mocked(view.bridge.command).mockReturnValue(ipc.promise);
    const pending = requestTerrainMutation(view.bridge, command());
    pending.catch(() => {});
    await flush();
    view.emit(result());
    ipc.reject(new Error("IPC disconnected"));
    await expect(pending).rejects.toThrow("IPC disconnected");
    expect(view.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up a synchronous bridge dispatch failure", async () => {
    const view = setup();
    vi.mocked(view.bridge.command).mockImplementation(() => {
      throw new Error("bridge closed");
    });
    await expect(
      requestTerrainMutation(view.bridge, command()),
    ).rejects.toThrow("bridge closed");
    expect(view.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not dispatch when the result subscription fails", async () => {
    const view = setup();
    vi.mocked(view.bridge.subscribe).mockImplementation(() => {
      throw new Error("cannot subscribe");
    });
    await expect(
      requestTerrainMutation(view.bridge, command()),
    ).rejects.toThrow("cannot subscribe");
    expect(view.bridge.command).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors synchronous disconnect delivered during subscription setup", async () => {
    const view = setup();
    vi.mocked(view.bridge.subscribe).mockImplementation((listener) => {
      listener({
        type: "status",
        phase: "disconnected",
        message: "Disconnected",
      });
      return view.unsubscribed;
    });
    await expect(
      requestTerrainMutation(view.bridge, command()),
    ).rejects.toThrow("connection changed");
    expect(view.bridge.command).not.toHaveBeenCalled();
    expect(view.unsubscribed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not accumulate timers or listeners across repeated successful edits", async () => {
    const view = setup();
    for (let i = 0; i < 50; i++) {
      const requestId = `row-${i}`,
        pending = requestTerrainMutation(view.bridge, command({ requestId }));
      await flush();
      view.emit(result({ requestId }));
      await pending;
      expect(view.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(view.unsubscribed).toHaveBeenCalledTimes(50);
    expect(view.bridge.command).toHaveBeenCalledTimes(50);
  });
});
