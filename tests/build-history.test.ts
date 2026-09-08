import { describe, expect, it } from "vitest";
import { BuildHistory, sameBuildObject, transformSelection, type BuildAdapter, type BuildChange } from "../src/renderer/build-history";
import type { WorldObject } from "../src/shared/types";
const object = (id = 1, x = 0): WorldObject => ({ id, x, owner: 2, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, model: "cube.rwx", description: "", action: "" });
function fixture(initial: WorldObject[] = [object()]) {
  const objects = new Map(initial.map(o => [o.id, { ...o }]));
  let id = 100;
  const calls: BuildChange[] = [];
  const adapter: BuildAdapter = { read: key => objects.get(key), apply: async change => {
    calls.push(change);
    const after = change.after ? { ...change.after, id: change.before?.id ?? ++id, x: Math.round(change.after.x * 100) / 100 } : null;
    if (change.before) objects.delete(change.before.id);
    if (after) objects.set(after.id, after);
    return { before: change.before, after };
  } };
  return { objects, adapter, calls, history: new BuildHistory() };
}
describe("server-authoritative building history", () => {
  it("undoes and redoes a canonical edit rather than unrounded client values", async () => {
    const f = fixture();
    await f.history.execute("Move", [{ before: object(), after: object(1, 3.456) }], f.adapter);
    expect(f.objects.get(1)?.x).toBe(3.46);
    await f.history.undo(f.adapter); expect(f.objects.get(1)?.x).toBe(0);
    await f.history.redo(f.adapter); expect(f.objects.get(1)?.x).toBe(3.46);
  });
  it("replays create/delete with newly allocated server IDs", async () => {
    const f = fixture([]);
    await f.history.execute("Create", [{ before: null, after: object(0) }], f.adapter);
    expect(f.objects.has(101)).toBe(true);
    await f.history.undo(f.adapter); expect(f.objects.size).toBe(0);
    await f.history.redo(f.adapter); expect(f.objects.has(102)).toBe(true);
    await f.history.undo(f.adapter); expect(f.objects.size).toBe(0);
  });
  it("rebases older edits after a deleted object is restored under a new ID", async () => {
    const f = fixture();
    await f.history.execute("Move", [{ before: object(), after: object(1, 3) }], f.adapter);
    await f.history.execute("Delete", [{ before: object(1, 3), after: null }], f.adapter);
    await f.history.undo(f.adapter); expect(f.objects.get(101)?.x).toBe(3);
    await f.history.undo(f.adapter); expect(f.objects.get(101)?.x).toBe(0);
    await f.history.redo(f.adapter); expect(f.objects.get(101)?.x).toBe(3);
    await f.history.redo(f.adapter); expect(f.objects.size).toBe(0);
  });
  it("preflights every object and does not overwrite remote edits", async () => {
    const f = fixture([object(1), object(2)]);
    await f.history.execute("Move both", [1, 2].map(id => ({ before: object(id), after: object(id, 3) })), f.adapter);
    f.objects.set(1, object(1, 4));
    const count = f.calls.length;
    const result = await f.history.undo(f.adapter);
    expect(result.error).toContain("changed since this edit");
    expect(f.calls.length).toBe(count);
    expect(f.objects.get(2)?.x).toBe(3);
  });
  it("retains undo for a partially accepted compound edit", async () => {
    const f = fixture([object(1), object(2)]);
    const apply = f.adapter.apply;
    f.adapter.apply = async c => { if (c.before?.id === 2) throw new Error("Permission denied"); return apply(c); };
    const result = await f.history.execute("Move both", [1, 2].map(id => ({ before: object(id), after: object(id, 3) })), f.adapter);
    expect(result.error).toContain("1 of 2");
    expect(f.history.size.undo).toBe(1);
    await f.history.undo(f.adapter); expect(f.objects.get(1)?.x).toBe(0);
  });
  it("keeps remaining undo steps and redo for a partially accepted undo", async () => {
    const f = fixture([object(1), object(2)]);
    await f.history.execute("Move both", [1, 2].map(id => ({ before: object(id), after: object(id, 3) })), f.adapter);
    const apply = f.adapter.apply;
    f.adapter.apply = async c => { if (c.before?.id === 1) throw new Error("Permission denied"); return apply(c); };
    expect((await f.history.undo(f.adapter)).error).toContain("1 of 2");
    expect(f.history.size).toEqual({ undo: 1, redo: 1 });
    await f.history.redo(f.adapter); expect(f.objects.get(2)?.x).toBe(3);
    f.adapter.apply = apply;
    await f.history.undo(f.adapter); await f.history.undo(f.adapter);
    expect([...f.objects.values()].map(o => o.x)).toEqual([0, 0]);
  });
  it("does not erase redo when an entirely rejected new action is attempted", async () => {
    const f = fixture();
    await f.history.execute("Move", [{ before: object(), after: object(1, 3) }], f.adapter);
    await f.history.undo(f.adapter);
    f.adapter.apply = async () => { throw new Error("No"); };
    await f.history.execute("Move", [{ before: object(), after: object(1, 8) }], f.adapter);
    expect(f.history.size.redo).toBe(1);
  });
  it("does not record into a new world after reset during a request", async () => {
    const f = fixture(); let resolve!: (c: BuildChange) => void;
    f.adapter.apply = () => new Promise(done => { resolve = done; });
    const pending = f.history.execute("Move", [{ before: object(), after: object(1, 3) }], f.adapter);
    f.history.reset(); resolve({ before: object(), after: object(1, 3) });
    expect((await pending).cancelled).toBe(true);
    expect(f.history.size).toEqual({ undo: 0, redo: 0 });
  });
  it("rejects overlapping operations", async () => {
    const f = fixture(); let resolve!: (c: BuildChange) => void;
    f.adapter.apply = () => new Promise(done => { resolve = done; });
    const pending = f.history.execute("Move", [{ before: object(), after: object(1, 3) }], f.adapter);
    expect((await f.history.undo(f.adapter)).error).toContain("already");
    resolve({ before: object(), after: object(1, 3) }); await pending;
  });
  it("caps transaction depth and memory", async () => {
    const f = fixture(); const history = new BuildHistory(2);
    for (let x = 1; x <= 4; x++) await history.execute("Move", [{ before: object(1, x - 1), after: object(1, x) }], f.adapter);
    expect(history.size.undo).toBe(2);
    const tiny = new BuildHistory(10, 20);
    await tiny.execute("Move", [{ before: object(1, 4), after: object(1, 5) }], f.adapter);
    expect(tiny.size.undo).toBe(0);
  });
  it("ignores derived cell metadata but not ownership or action differences", () => {
    expect(sameBuildObject(object(), { ...object(), cellX: 3 })).toBe(true);
    expect(sameBuildObject(object(), { ...object(), owner: 3 })).toBe(false);
    expect(sameBuildObject(object(), { ...object(), action: "create solid off" })).toBe(false);
  });
  it("does not retain caller-owned references", async () => {
    const f = fixture(); const changed = object(1, 3);
    await f.history.execute("Move", [{ before: object(), after: changed }], f.adapter);
    changed.x = 100;
    expect((await f.history.undo(f.adapter)).error).toBeUndefined();
  });
  it("rejects ambiguous duplicate edits and empty mutations", async () => {
    const f = fixture();
    expect((await f.history.execute("Bad", [{ before: object(), after: null }, { before: object(), after: null }], f.adapter)).error).toContain("duplicate");
    expect((await f.history.execute("Bad", [{ before: null, after: null }], f.adapter)).error).toContain("Invalid");
  });
});
describe("selection transforms", () => {
  it("rotates around the group centre using AW metre/radian axes", () => {
    const result = transformSelection([object(1, -1), object(2, 1)], { x: 5, y: 2, z: 3, yaw: Math.PI / 2 });
    expect(result[0].x).toBeCloseTo(5); expect(result[0].z).toBeCloseTo(4);
    expect(result[1].z).toBeCloseTo(2); expect(result[1].y).toBe(2);
    expect(result[0].yaw).toBeCloseTo(Math.PI / 2);
  });
  it("rejects nonfinite transforms and oversized selection", () => {
    expect(() => transformSelection([object()], { x: NaN, y: 0, z: 0, yaw: 0 })).toThrow();
    expect(() => transformSelection(Array(257).fill(object()), { x: 0, y: 0, z: 0, yaw: 0 })).toThrow();
  });
});
