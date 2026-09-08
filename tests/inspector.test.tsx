// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "../src/renderer/components/Inspector";
import type { WorldObject } from "../src/shared/types";

afterEach(cleanup);
const original: WorldObject = {
  id: 1,
  owner: 2,
  model: "column.rwx",
  description: "Original",
  action: "",
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
};
const props = () => ({
  canBuild: true,
  pending: false,
  onSave: vi.fn(),
  onDelete: vi.fn(),
  onDuplicate: vi.fn(),
  onClose: vi.fn(),
});

describe("unsaved building edits", () => {
  it("keeps a draft when an identical object is returned by a cell query", () => {
    const handlers = props();
    const view = render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "My unfinished text" },
    });
    view.rerender(<Inspector object={{ ...original }} {...handlers} />);
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("My unfinished text");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("keeps dirty fields on a remote change and requires an explicit conflict decision", () => {
    const handlers = props();
    const view = render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "My draft" },
    });
    view.rerender(<Inspector object={{ ...original, x: 5 }} {...handlers} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "unsaved edits are still here",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Apply changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(handlers.onSave).toHaveBeenCalledWith({
      ...original,
      x: 5,
      description: "My draft",
    });
  });
  it("can explicitly discard the draft and load the server version", () => {
    const handlers = props();
    const view = render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "My draft" },
    });
    view.rerender(
      <Inspector
        object={{ ...original, description: "Remote edit" }}
        {...handlers}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload object" }));
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Remote edit");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("recognizes the server acknowledgement of its own draft", () => {
    const handlers = props();
    const view = render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Saved edit" },
    });
    view.rerender(
      <Inspector
        object={{ ...original, description: "Saved edit" }}
        {...handlers}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Apply changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("does not treat refreshed derived cell metadata as a conflicting edit", () => {
    const handlers = props();
    const view = render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep this draft" } });
    view.rerender(<Inspector object={{ ...original, cellX: 0, cellZ: 0 }} {...handlers} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep this draft");
  });
  it("reports draft changes and blocks unload until edits are explicitly discarded", () => {
    const onDirtyChange = vi.fn();
    const view = render(<Inspector object={original} {...props()} onDirtyChange={onDirtyChange} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Not yet applied" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const dirty = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Original");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const discarded = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(discarded);
    expect(discarded.defaultPrevented).toBe(false);
    view.unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it("removes its unload handler and dirty registration when unmounted", () => {
    const onDirtyChange = vi.fn();
    const view = render(<Inspector object={original} {...props()} onDirtyChange={onDirtyChange} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Draft" } });
    view.unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it("keeps a draft recoverable after the selected object is remotely deleted", () => {
    const handlers = props(), onDirtyChange = vi.fn();
    const view = render(<Inspector object={original} {...handlers} onDirtyChange={onDirtyChange} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Recover this text" } });
    view.rerender(<Inspector object={null} {...handlers} onDirtyChange={onDirtyChange} />);
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Recover this text");
    expect(screen.getByRole("alert").textContent).toContain("no longer available");
    expect((screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(screen.getByText("Make something yours.")).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(handlers.onSave).not.toHaveBeenCalled();
  });
  it("disables inputs and rejects form submission while an operation is pending", () => {
    const handlers = props();
    const view = render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Draft" } });
    view.rerender(<Inspector object={original} {...handlers} pending />);
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Description").closest("form")!);
    expect(handlers.onSave).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Discard edits" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("adopts canonical server quantization only after explicit successful completion", async () => {
    let finish!: (accepted: boolean) => void;
    const handlers = { ...props(), onSave: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) };
    const onDirtyChange = vi.fn();
    const view = render(<Inspector object={original} {...handlers} onDirtyChange={onDirtyChange} />);
    fireEvent.change(screen.getByLabelText("Position X"), { target: { value: "3.456" } });
    fireEvent.submit(screen.getByLabelText("Description").closest("form")!);
    expect(handlers.onSave).toHaveBeenCalledWith({ ...original, x: 3.456 });
    // The canonical broadcast arrives before the bridge acknowledgement.
    view.rerender(<Inspector object={{ ...original, x: 3.46 }} {...handlers} onDirtyChange={onDirtyChange} pending />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finish(true); });
    view.rerender(<Inspector object={{ ...original, x: 3.46 }} {...handlers} onDirtyChange={onDirtyChange} />);
    expect((screen.getByLabelText("Position X") as HTMLInputElement).value).toBe("3.46");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it("preserves an explicitly rejected draft and prevents duplicate submissions before props update", async () => {
    let finish!: (accepted: boolean) => void;
    const handlers = { ...props(), onSave: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) };
    render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep if rejected" } });
    const form = screen.getByLabelText("Description").closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish(false); });
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep if rejected");
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("surfaces a rejected save promise without discarding the draft", async () => {
    const handlers = { ...props(), onSave: vi.fn(async () => { throw new Error("Connection lost"); }) };
    render(<Inspector object={original} {...handlers} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep if disconnected" } });
    await act(async () => { fireEvent.submit(screen.getByLabelText("Description").closest("form")!); });
    expect(screen.getByRole("alert").textContent).toContain("Connection lost");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep if disconnected");
  });
});
