// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectionInspector } from "../src/renderer/components/SelectionInspector";
import type { WorldObject } from "../src/shared/types";

afterEach(cleanup);
const objects: WorldObject[] = [1, 2].map(id => ({ id, owner: 2, model: "column.rwx", description: "", action: "", x: id, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }));
const props = () => ({ objects, pending: false, canBuild: true, onSave: vi.fn(async () => true), onDuplicate: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(), onDirtyChange: vi.fn() });
const input = () => screen.getByLabelText("Move selection X") as HTMLInputElement;
const setOffset = (value = "3") => fireEvent.change(input(), { target: { value } });
const submit = () => fireEvent.submit(input().closest("form")!);

describe("selection transform draft durability", () => {
  it("tracks unapplied offsets and guards unload until discard", () => {
    const handlers = props();
    render(<SelectionInspector {...handlers} />);
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(false);
    setOffset();
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(true);
    const dirty = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(input().value).toBe("0");
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(false);
    const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
  it("retains offsets until the complete batch is explicitly accepted", async () => {
    let finish!: (accepted: boolean) => void;
    const handlers = { ...props(), onSave: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) };
    render(<SelectionInspector {...handlers} />);
    setOffset(); submit();
    expect(input().value).toBe("3");
    expect(input().disabled).toBe(true);
    expect(handlers.onSave).toHaveBeenCalledWith(objects.map(object => ({ ...object, x: object.x + 3 })));
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finish(true); });
    expect(input().value).toBe("0");
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it("retains rejected offsets and requires review before any retry of a possibly partial batch", async () => {
    const handlers = { ...props(), onSave: vi.fn(async () => false) };
    render(<SelectionInspector {...handlers} />);
    setOffset(); await act(async () => { submit(); });
    expect(input().value).toBe("3");
    expect(screen.getByRole("alert").textContent).toContain("Some changes may already be applied");
    expect((screen.getByRole("button", { name: "Apply to selection" }) as HTMLButtonElement).disabled).toBe(true);
    submit(); expect(handlers.onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "I reviewed the selection; allow retry" }));
    expect((screen.getByRole("button", { name: "Apply to selection" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input().value).toBe("0");
  });
  it("contains a rejected save promise without losing offsets", async () => {
    const handlers = { ...props(), onSave: vi.fn(async () => { throw new Error("No build rights"); }) };
    render(<SelectionInspector {...handlers} />);
    setOffset(); await act(async () => { submit(); });
    expect(screen.getAllByRole("alert").map(alert => alert.textContent).join(" ")).toContain("No build rights");
    expect(input().value).toBe("3");
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(true);
  });
  it("prevents pending and duplicate submissions, including before parent props update", async () => {
    let finish!: (accepted: boolean) => void;
    const handlers = { ...props(), onSave: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) };
    const view = render(<SelectionInspector {...handlers} />);
    setOffset();
    view.rerender(<SelectionInspector {...handlers} pending />);
    submit(); expect(handlers.onSave).not.toHaveBeenCalled();
    view.rerender(<SelectionInspector {...handlers} />);
    submit(); submit(); expect(handlers.onSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
  });
  it("does not submit a zero transform or duplicate/delete while offsets are unapplied", () => {
    const handlers = props();
    render(<SelectionInspector {...handlers} />);
    submit(); expect(handlers.onSave).not.toHaveBeenCalled();
    setOffset();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate all" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(handlers.onDuplicate).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });
  it("cleans up dirty registration and unload listeners on unmount", () => {
    const handlers = props();
    const view = render(<SelectionInspector {...handlers} />);
    setOffset(); view.unmount();
    expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(false);
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
