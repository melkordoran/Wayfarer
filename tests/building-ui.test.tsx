// @vitest-environment jsdom
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { WorldObject } from "../src/shared/types";
import {
  STORAGE_KEY,
  decodeStudioProject,
  makeStudioProject,
  saveStudioProject,
} from "../src/renderer/studio-project";
const runtime = vi.hoisted(() => ({
  options: null as any,
  position: { x: 0, y: 1.7, z: -22, yaw: 0 },
  objects: new Map<number, any>(),
}));
const fake = vi.hoisted(() => ({
  setWorld: vi.fn(),
  updateWorld: vi.fn(),
  setTerrain: vi.fn(),
  dispose: vi.fn(),
  setBuildMode: vi.fn(),
  setSelected: vi.fn(),
  setSelection: vi.fn(),
  setTransformMode: vi.fn(),
  setTransformSpace: vi.fn(),
  setTransformSnap: vi.fn(),
  setTransformEnabled: vi.fn(),
  setTimeOfDay: vi.fn(),
  setWireframe: vi.fn(),
  setCameraMode: vi.fn(),
  setAvatarType: vi.fn(),
  setGesture: vi.fn(() => 0),
  setObjects: vi.fn((objects: any[], replace?: boolean) => {
    if (replace) runtime.objects.clear();
    objects.forEach((o) => runtime.objects.set(o.id, o));
  }),
  deleteObject: vi.fn((id: number) => runtime.objects.delete(id)),
  teleport: vi.fn((position: any) => {
    runtime.position = position;
  }),
  getPosition: vi.fn(() => runtime.position),
}));
vi.mock("../src/renderer/engine", () => ({
  WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) {
    runtime.options = options;
    return fake;
  }),
}));
const command = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/renderer/client", () => ({
  bridge: {
    mode: "preview",
    subscribe: () => () => {},
    command,
    asset: vi.fn(),
  },
}));
import App from "../src/renderer/App";
import { loadModelLibrary } from "../src/renderer/model-library";
beforeEach(() => {
  localStorage.clear();
  runtime.objects.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: vi.fn(),
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
async function addCube() {
  fireEvent.click(screen.getByRole("button", { name: "Create something" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to world" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByLabelText("Description");
  return [...runtime.objects.values()].at(-1) as WorldObject;
}
describe("building and saved studio workflows", () => {
  it.each([null, [], "local", { space: "camera" }, { space: 1 }, { space: true }, { space: ["local"] }, { translation: 0.25, rotation: 45 }])("defaults invalid or legacy axis preferences safely %#", stored => {
    localStorage.setItem("wayfarer:building-tools", JSON.stringify(stored));
    render(<App />);
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("world");
    expect(JSON.parse(localStorage.getItem("wayfarer:building-tools")!).space).toBe("world");
  });
  it("restores local axes without losing independent snapping preferences", () => {
    localStorage.setItem("wayfarer:building-tools", JSON.stringify({ space: "local", translation: 0.1, rotation: 90 }));
    render(<App />);
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("local");
    expect(fake.setTransformSnap).toHaveBeenLastCalledWith({ translation: 0.1, rotation: Math.PI / 2 });
  });
  it("switches reference frames without mutating objects or changing the primary selection", () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /^Build$/ }));
    const originals = [...runtime.objects.values()] as WorldObject[];
    act(() => { runtime.options.onSelect(originals[0]); runtime.options.onSelect(originals[1], { additive: true }); });
    fireEvent.click(screen.getByRole("button", { name: "Move tool" }));
    fireEvent.change(screen.getByLabelText("Transform axes"), { target: { value: "local" } });
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("local");
    expect(fake.setSelection).toHaveBeenLastCalledWith([originals[0].id, originals[1].id], originals[1].id);
    expect(screen.getByText(/Primary object's axes · Relative snap/)).toBeTruthy();
    expect(screen.getByLabelText("Transform axes").getAttribute("aria-describedby")).toBe("transform-space-help");
    expect(document.getElementById("transform-space-help")?.textContent).toContain("Shared centre");
    expect([...runtime.objects.values()]).toEqual(originals); expect(command).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Undo build" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Transform axes"), { target: { value: "world" } });
    expect(screen.getByText(/World axes · World-grid snap/)).toBeTruthy();
    expect([...runtime.objects.values()]).toEqual(originals);
  });
  it("keeps axis selection keyboard-native and rejects unsupported injected options", () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /^Build$/ }));
    const originalCount = runtime.objects.size, first = [...runtime.objects.values()][0];
    act(() => runtime.options.onSelect(first));
    const axes = screen.getByRole("combobox", { name: "Transform axes" }); axes.focus();
    fireEvent.keyDown(axes, { key: "d", ctrlKey: true });
    fireEvent.keyDown(axes, { key: "b" });
    expect(runtime.objects.size).toBe(originalCount); expect(screen.getByRole("combobox", { name: "Transform axes" })).toBeTruthy();
    fireEvent.change(axes, { target: { value: "camera" } });
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("world");
    expect(JSON.parse(localStorage.getItem("wayfarer:building-tools")!).space).toBe("world");
  });
  it("guards a programmatic axis change while an inspector draft is present", async () => {
    render(<App />); await addCube();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep this draft" } });
    fireEvent.change(screen.getByLabelText("Transform axes"), { target: { value: "local" } });
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("world");
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Keep this draft");
    expect(screen.getByText("Apply or discard your inspector edits first.")).toBeTruthy();
  });
  it("keeps an incomplete numeric draft out of gizmos, saved objects and history", async () => {
    const user = userEvent.setup(); render(<App />); const added = await addCube();
    fireEvent.click(screen.getByRole("button", { name: "Move tool" }));
    fireEvent.change(screen.getByLabelText("Transform axes"), { target: { value: "local" } });
    const position = screen.getByLabelText("Position X") as HTMLInputElement;
    await user.clear(position); await user.type(position, "-");
    expect(position.value).toBe("-");
    expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(false);
    expect((screen.getByLabelText("Transform axes") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(runtime.objects.get(added.id)).toEqual(added);
    await user.type(position, "0.125");
    expect(position.value).toBe("-0.125");
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(runtime.objects.get(added.id)?.x).toBe(-0.125));
    await waitFor(() => expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(true));
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("local");
    await user.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() => expect(runtime.objects.get(added.id)).toEqual(added));
  });
  it("gates local handles while a group offset is incomplete and applies a signed fractional batch", async () => {
    const user = userEvent.setup(); render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Build$/ }));
    const before = [...runtime.objects.values()].slice(0, 2) as WorldObject[];
    act(() => { runtime.options.onSelect(before[0]); runtime.options.onSelect(before[1], { additive: true }); });
    fireEvent.click(screen.getByRole("button", { name: "Move tool" }));
    fireEvent.change(screen.getByLabelText("Transform axes"), { target: { value: "local" } });
    const offset = screen.getByLabelText("Move selection X") as HTMLInputElement;
    await user.clear(offset); await user.type(offset, "-");
    expect(offset.value).toBe("-");
    expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(false);
    expect((screen.getByRole("button", { name: "Apply to selection" }) as HTMLButtonElement).disabled).toBe(true);
    before.forEach(object => expect(runtime.objects.get(object.id)).toEqual(object));
    await user.type(offset, "0.125");
    await user.click(screen.getByRole("button", { name: "Apply to selection" }));
    await waitFor(() => before.forEach(object => expect(runtime.objects.get(object.id)?.x).toBe(object.x - 0.125)));
    await waitFor(() => expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() => before.forEach(object => expect(runtime.objects.get(object.id)).toEqual(object)));
  });
  it("records an accepted model before the full-app picker closes", async () => {
    render(<App />);
    await addCube();
    expect(loadModelLibrary({ kind: "studio" })).toEqual({
      ok: true,
      value: { favorites: [], recent: ["wayfarer:cube"] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add object" }));
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    expect(
      screen.getByRole("button", { name: /Cube.*wayfarer:cube/ }),
    ).toBeTruthy();
  });
  it("applies gizmo batches through canonical history and persists snapping preferences", async () => {
    const view = render(<App />);
    const added = await addCube();
    fireEvent.click(screen.getByRole("button", { name: "Move tool" }));
    expect(fake.setTransformMode).toHaveBeenLastCalledWith("translate");
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("world");
    fireEvent.change(screen.getByLabelText("Transform axes"), { target: { value: "local" } });
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("local");
    fireEvent.change(screen.getByLabelText("Translation snap"), {
      target: { value: "0.25" },
    });
    fireEvent.change(screen.getByLabelText("Rotation snap"), {
      target: { value: "45" },
    });
    expect(fake.setTransformSnap).toHaveBeenLastCalledWith({
      translation: 0.25,
      rotation: Math.PI / 4,
    });
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await runtime.options.onTransform([
        { before: added, after: { ...added, x: added.x + 0.75 } },
      ]);
    });
    expect(accepted).toBe(true);
    expect(runtime.objects.get(added.id)?.x).toBe(added.x + 0.75);
    fireEvent.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() => expect(runtime.objects.get(added.id)?.x).toBe(added.x));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Redo build",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo build" }));
    await waitFor(() =>
      expect(runtime.objects.get(added.id)?.x).toBe(added.x + 0.75),
    );
    view.unmount();
    render(<App />);
    expect(fake.setTransformSpace).toHaveBeenLastCalledWith("local");
    expect(fake.setTransformSnap).toHaveBeenLastCalledWith({
      translation: 0.25,
      rotation: Math.PI / 4,
    });
  });
  it("disables gizmos for drafts and dialogs, and rejects stale drag snapshots", async () => {
    render(<App />);
    const added = await addCube();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Still editing" },
    });
    expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(false);
    expect((screen.getByLabelText("Transform axes") as HTMLSelectElement).disabled).toBe(true);
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await runtime.options.onTransform([
        { before: added, after: { ...added, x: added.x + 1 } },
      ]);
    });
    expect(accepted).toBe(false);
    expect(runtime.objects.get(added.id)?.x).toBe(added.x);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(true);
    expect((screen.getByLabelText("Transform axes") as HTMLSelectElement).disabled).toBe(false);
    await act(async () => {
      accepted = await runtime.options.onTransform([
        {
          before: { ...added, description: "Stale" },
          after: { ...added, x: added.x + 1 },
        },
      ]);
    });
    expect(accepted).toBe(false);
    expect(runtime.objects.get(added.id)?.x).toBe(added.x);
    fireEvent.click(screen.getByRole("button", { name: "Add object" }));
    expect(fake.setTransformEnabled).toHaveBeenLastCalledWith(false);
    await act(async () => {
      accepted = await runtime.options.onTransform([
        { before: added, after: { ...added, x: added.x + 1 } },
      ]);
    });
    expect(accepted).toBe(false);
  });
  it("creates, edits, undoes, redoes and restores a deleted local object", async () => {
    render(<App />);
    const count = runtime.objects.size;
    const added = await addCube();
    expect(runtime.objects.size).toBe(count + 1);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Saved building" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() =>
      expect(runtime.objects.get(added.id)?.description).toBe("Saved building"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() =>
      expect(runtime.objects.get(added.id)?.description).toBe(""),
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo build" }));
    await waitFor(() =>
      expect(runtime.objects.get(added.id)?.description).toBe("Saved building"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete object$/ }));
    await waitFor(() => expect(runtime.objects.size).toBe(count));
    fireEvent.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() => expect(runtime.objects.size).toBe(count + 1));
    expect([...runtime.objects.values()].at(-1)?.description).toBe(
      "Saved building",
    );
  });
  it("preserves accepted edits through unmount/remount and allocates fresh IDs", async () => {
    const view = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    const added = await addCube();
    view.unmount();
    const saved = decodeStudioProject(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.ok && saved.value.objects.some((o) => o.id === added.id)).toBe(
      true,
    );
    render(<App />);
    expect(runtime.objects.has(added.id)).toBe(true);
    const next = await addCube();
    expect(next.id).toBeGreaterThan(added.id);
    expect(runtime.objects.has(added.id)).toBe(true);
  });
  it("Shift-selects, transforms, duplicates and undoes a group", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Build$/ }));
    const first = [...runtime.objects.values()].slice(0, 2) as WorldObject[];
    act(() => {
      runtime.options.onSelect(first[0]);
      runtime.options.onSelect(first[1], { additive: true });
    });
    expect(screen.getByText("2 objects selected")).toBeTruthy();
    expect(fake.setSelection).toHaveBeenLastCalledWith(
      first.map((o) => o.id),
      first[1].id,
    );
    fireEvent.change(screen.getByLabelText("Move selection X"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to selection" }));
    await waitFor(() =>
      expect(runtime.objects.get(first[1].id)?.x).toBe(first[1].x + 3),
    );
    const count = runtime.objects.size;
    fireEvent.click(screen.getByRole("button", { name: "Duplicate all" }));
    await waitFor(() => expect(runtime.objects.size).toBe(count + 2));
    fireEvent.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() => expect(runtime.objects.size).toBe(count));
    fireEvent.click(screen.getByRole("button", { name: "Undo build" }));
    await waitFor(() =>
      expect(runtime.objects.get(first[0].id)?.x).toBe(first[0].x),
    );
  });
  it("does not apply build undo while editing a text field", async () => {
    render(<App />);
    const added = await addCube();
    fireEvent.keyDown(screen.getByLabelText("Description"), {
      key: "z",
      ctrlKey: true,
    });
    expect(runtime.objects.has(added.id)).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Interactive 3D world"), {
      key: "z",
      ctrlKey: true,
    });
    await waitFor(() => expect(runtime.objects.has(added.id)).toBe(false));
  });
  it("preserves an inspector draft across selection, build-toggle, undo and connection attempts", async () => {
    render(<App />);
    const added = await addCube();
    const other = [...runtime.objects.values()].find(
      (object) => object.id !== added.id,
    )!;
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Unapplied draft" },
    });
    act(() => runtime.options.onSelect(other));
    expect(fake.setSelection).toHaveBeenLastCalledWith([added.id], added.id);
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Unapplied draft");
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.getByLabelText("Description")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Interactive 3D world"), {
      key: "b",
    });
    expect(screen.getByLabelText("Description")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo build" }));
    expect(runtime.objects.has(added.id)).toBe(true);
    const unload = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(unload);
    });
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to a universe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enter universe" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "inspector edits",
      ),
    );
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    act(() => runtime.options.onSelect(other));
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe(other.description);
  });
  it("keeps corrupt saved bytes and blocks leaving an unsaved fallback studio", async () => {
    localStorage.setItem(STORAGE_KEY, "{broken");
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to a universe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enter universe" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be saved",
      ),
    );
    expect(command).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{broken");
  });
  it("loads an intentionally empty saved project and confirms before restoring the seed", async () => {
    const project = makeStudioProject("Empty atelier", [], {
      x: 1,
      y: 0,
      z: -5,
      yaw: 0,
    });
    if (!project.ok) throw new Error(project.error.message);
    saveStudioProject(project.value);
    render(<App />);
    expect(runtime.objects.size).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /^Project$/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore original studio…" }),
    );
    expect(runtime.objects.size).toBe(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Keep current studio" }),
    );
    expect(runtime.objects.size).toBe(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Restore original studio…" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Restore original studio$/ }),
    );
    expect(runtime.objects.size).toBe(57);
  });
  it("prevents unload if the studio cannot be saved", () => {
    localStorage.setItem(STORAGE_KEY, "{broken");
    render(<App />);
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{broken");
  });
  it("allocates safely after importing the maximum uint32 object ID", async () => {
    const original: WorldObject = {
      id: 0xffffffff,
      owner: 0,
      model: "wayfarer:cube",
      description: "Imported",
      action: "",
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
    };
    const project = makeStudioProject("High IDs", [original], {
      x: 0,
      y: 1.7,
      z: -5,
      yaw: 0,
    });
    if (!project.ok) throw new Error(project.error.message);
    saveStudioProject(project.value);
    render(<App />);
    const added = await addCube();
    expect(added.id).toBe(1);
    expect(runtime.objects.has(0xffffffff)).toBe(true);
  });
});
