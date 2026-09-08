import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestBuildMutation } from "../src/renderer/build-mutations";
import type { BuildChange } from "../src/renderer/build-history";
import type { ClientBridge, ClientCommand, ClientEvent, WorldObject } from "../src/shared/types";

type MutationCommand = Extract<ClientCommand, { type: "object-add" | "object-change" | "object-delete" }>;
type Result = Extract<ClientEvent, { type: "object-result" }>;
const object = (id = 7, x = 0): WorldObject => ({ id, x, owner: 2, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, model: "cube.rwx", description: "identical", action: "" });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const listeners = new Set<(event: ClientEvent) => void>();
  const requests: { command: MutationCommand; ack: ReturnType<typeof deferred<void>> }[] = [];
  const unsubscribe = vi.fn((listener: (event: ClientEvent) => void) => { listeners.delete(listener); });
  const bridge: ClientBridge = {
    mode: "preview",
    command: vi.fn((command: ClientCommand) => {
      // This is the critical pre-dispatch subscription boundary.
      expect(listeners.size).toBeGreaterThan(0);
      const ack = deferred<void>();
      requests.push({ command: command as MutationCommand, ack });
      return ack.promise;
    }),
    subscribe: vi.fn(listener => { listeners.add(listener); return () => unsubscribe(listener); }),
    asset: vi.fn(async () => ({ bytes: new Uint8Array(), contentType: "application/octet-stream" })),
  };
  const emit = (event: ClientEvent) => { for (const listener of [...listeners]) listener(event); };
  const result = (index = 0, id = 101): Result => {
    const command = requests[index].command;
    const operation = command.type === "object-add" ? "add" : command.type === "object-change" ? "change" : "delete";
    return { type: "object-result", requestId: command.requestId!, operation, id,
      ...(operation === "delete" ? {} : { object: { ...command.object, id, x: 3.46, model: "canonical.rwx" } }) };
  };
  return { bridge, listeners, requests, unsubscribe, emit, result };
}

function observe(promise: Promise<BuildChange>) {
  const state: { settled: boolean; value?: BuildChange; error?: Error } = { settled: false };
  // Observe rejections immediately, including while advancing fake clocks.
  void promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const add = (): BuildChange => ({ before: null, after: object(0, 3.456) });
const edit = (): BuildChange => ({ before: object(), after: object(7, 3.456) });
const expectClean = (f: ReturnType<typeof fixture>, count = 1) => {
  expect(f.listeners.size).toBe(0);
  expect(f.unsubscribe).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("renderer correlated build mutation gateway", () => {
  it.each([
    ["add", "result-first"], ["add", "ack-first"],
    ["change", "result-first"], ["change", "ack-first"],
    ["delete", "result-first"], ["delete", "ack-first"],
  ] as const)("waits for both %s confirmation and acknowledgement (%s)", async (operation, order) => {
    const f = fixture();
    const change = operation === "add" ? add() : operation === "change" ? edit() : { before: object(), after: null };
    const pending = requestBuildMutation(f.bridge, change);
    const state = observe(pending);
    await flush();
    const request = f.requests[0];
    expect(request.command.type).toBe(`object-${operation}`);
    expect(request.command.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    if (operation === "change") expect(request.command).toMatchObject({ previous: change.before });
    const result = f.result(0, operation === "add" ? 101 : 7);
    if (order === "result-first") f.emit(result); else request.ack.resolve();
    await flush();
    expect(state.settled).toBe(false);
    expect(f.listeners.size).toBe(1);
    if (order === "result-first") request.ack.resolve(); else f.emit(result);
    const confirmed = await pending;
    expect(confirmed).toEqual({ before: change.before, after: result.object ?? null });
    if (confirmed.before) expect(confirmed.before).not.toBe(change.before);
    if (confirmed.after) expect(confirmed.after).not.toBe(result.object);
    expectClean(f);
  });

  it("captures a correlated result emitted synchronously during command dispatch", async () => {
    const f = fixture();
    vi.mocked(f.bridge.command).mockImplementation(async command => {
      const mutation = command as MutationCommand;
      expect(f.listeners.size).toBe(1);
      f.emit({ type: "object-result", operation: "add", requestId: mutation.requestId!, id: 101, object: object(101, 3.46) });
    });
    await expect(requestBuildMutation(f.bridge, add())).resolves.toMatchObject({ after: { id: 101, x: 3.46 } });
    expectClean(f);
  });

  it("keeps geometrically identical concurrent commands independently correlated", async () => {
    const f = fixture();
    const first = requestBuildMutation(f.bridge, add()), second = requestBuildMutation(f.bridge, add());
    const firstState = observe(first), secondState = observe(second);
    await flush();
    expect(f.requests[0].command.object).toEqual(f.requests[1].command.object);
    expect(f.requests[0].command.requestId).not.toBe(f.requests[1].command.requestId);
    f.requests[0].ack.resolve(); f.requests[1].ack.resolve();
    f.emit(f.result(1, 102));
    expect((await second).after?.id).toBe(102);
    expect(secondState.settled).toBe(true);
    expect(firstState.settled).toBe(false);
    expect(f.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    f.emit(f.result(0, 101));
    expect((await first).after?.id).toBe(101);
    expectClean(f, 2);
  });

  it("ignores unrelated broadcasts, acknowledgements, nonterminal status and errors", async () => {
    const f = fixture();
    const pending = requestBuildMutation(f.bridge, add()), state = observe(pending);
    await flush();
    f.requests[0].ack.resolve();
    f.emit({ type: "objects", objects: [object(101, 3.456)] });
    f.emit({ type: "object-delete", id: 7 });
    f.emit({ ...f.result(), requestId: "someone-elses-command" });
    f.emit({ type: "status", phase: "online", message: "Still connected" });
    f.emit({ type: "error", message: "An unrelated chat failed" });
    f.emit({ type: "query-complete" });
    await flush();
    expect(state.settled).toBe(false);
    f.emit(f.result());
    await pending;
    expectClean(f);
  });

  it.each([false, true])("cleans up when command rejects (result already arrived: %s)", async resultFirst => {
    const f = fixture();
    const pending = requestBuildMutation(f.bridge, add());
    observe(pending);
    await flush();
    if (resultFirst) f.emit(f.result());
    f.requests[0].ack.reject(new Error("No build rights"));
    await expect(pending).rejects.toThrow("No build rights");
    expectClean(f);
    // A late response must not revive the request or re-add its listener.
    f.emit(f.result());
    await vi.advanceTimersByTimeAsync(40_000);
    expectClean(f);
  });

  it("cleans up a synchronously throwing command implementation", async () => {
    const f = fixture();
    vi.mocked(f.bridge.command).mockImplementation(() => { throw new Error("IPC is unavailable"); });
    await expect(requestBuildMutation(f.bridge, edit())).rejects.toThrow("IPC is unavailable");
    expectClean(f);
    await vi.advanceTimersByTimeAsync(40_000);
  });

  it.each([false, true])("times out missing canonical result (command acknowledged: %s)", async acknowledged => {
    const f = fixture();
    const pending = requestBuildMutation(f.bridge, add(), 50), state = observe(pending);
    await flush();
    if (acknowledged) f.requests[0].ack.resolve();
    await vi.advanceTimersByTimeAsync(49);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.error?.message).toContain("do not assume the operation failed");
    expectClean(f);
    f.requests[0].ack.reject(new Error("Late transport rejection"));
    f.emit(f.result());
    await flush();
  });

  it("bounds the whole request even when a result arrives but its command acknowledgement stalls", async () => {
    const f = fixture();
    const pending = requestBuildMutation(f.bridge, add(), 50), state = observe(pending);
    await flush();
    f.emit(f.result());
    await vi.advanceTimersByTimeAsync(50);
    expect(state.error?.message).toContain("do not assume the operation failed");
    expectClean(f);
    f.requests[0].ack.resolve();
    await flush();
    expect(state.value).toBeUndefined();
  });

  it.each([
    ["disconnected", false], ["entering", false],
    ["disconnected", true], ["entering", true],
    ["connected", false], ["connected", true],
    ["connecting", false], ["authenticating", false],
  ] as const)("invalidates a pending mutation on %s (result already arrived: %s)", async (phase, resultFirst) => {
    const f = fixture();
    const pending = requestBuildMutation(f.bridge, edit()), state = observe(pending);
    await flush();
    if (resultFirst) f.emit(f.result(0, 7));
    // A dropped world socket uses "connected": the universe is still online.
    f.emit({ type: "status", phase, message: phase === "connected" ? "World disconnected" : "World connection changed" });
    await flush();
    expect(state.error?.message).toContain("world connection changed");
    expectClean(f);
    f.requests[0].ack.resolve();
    f.emit(f.result(0, 7));
    await flush();
    expect(state.value).toBeUndefined();
  });

  it.each(["operation", "missing-object"] as const)("rejects an inconsistent correlated result: %s", async invalid => {
    const f = fixture();
    const pending = requestBuildMutation(f.bridge, add());
    observe(pending);
    await flush();
    const result = f.result();
    if (invalid === "operation") result.operation = "delete"; else delete result.object;
    f.emit(result);
    await expect(pending).rejects.toThrow("inconsistent build result");
    expectClean(f);
    f.requests[0].ack.resolve();
  });

  it("rejects empty or invalid mutations before allocating any resources or dispatching", async () => {
    const f = fixture();
    await expect(requestBuildMutation(f.bridge, { before: null, after: null })).rejects.toThrow("no object");
    await expect(requestBuildMutation(f.bridge, { before: null, after: { ...object(), x: NaN } })).rejects.toThrow("Invalid x");
    expect(f.bridge.subscribe).not.toHaveBeenCalled();
    expect(f.bridge.command).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
