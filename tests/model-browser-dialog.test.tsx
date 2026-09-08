// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorldObject } from "../src/shared/types";
import {
  loadModelLibrary,
  modelLibraryKey,
  rememberModel,
  setModelFavorite,
  type ModelLibraryScope,
} from "../src/renderer/model-library";
const previews = vi.hoisted(() => ({
  request: vi.fn(),
  mount: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../src/renderer/components/ModelPreview", () => ({
  ModelPreview: ({
    model,
    objectPath,
    requestId,
  }: {
    model: string;
    objectPath: string;
    requestId?: number;
  }) => {
    useEffect(() => {
      previews.mount();
      return () => {
        previews.dispose();
      };
    }, []);
    useEffect(() => {
      previews.request({ model, objectPath, requestId });
    }, [model, objectPath, requestId]);
    return <div data-testid="model-preview">Preview: {model}</div>;
  },
}));
import {
  ModelBrowserDialog,
  type ModelBrowserDialogProps,
} from "../src/renderer/components/ModelBrowserDialog";
const world: Extract<ModelLibraryScope, { kind: "world" }> = {
  kind: "world",
  host: "universe.example",
  port: 6670,
  tls: true,
  world: "MyWorld",
  objectPath: "https://assets.example/",
};
const other: ModelLibraryScope = { ...world, host: "other.example" };
const studio: ModelLibraryScope = { kind: "studio" };
function object(model = "column.rwx", id = 1): WorldObject {
  return {
    id,
    model,
    owner: 2,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    description: "",
    action: "",
  };
}
function props(
  overrides: Partial<ModelBrowserDialogProps> = {},
): ModelBrowserDialogProps {
  return {
    studio: false,
    objects: [object()],
    scope: world,
    objectPath: world.objectPath,
    canBuild: true,
    pending: false,
    asset: vi.fn(async () => ({
      bytes: new Uint8Array(),
      contentType: "text/plain",
    })),
    onAdd: vi.fn(async () => true),
    onClose: vi.fn(),
    onNotice: vi.fn(),
    ...overrides,
  };
}
function button(name: string | RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
function input(value: string) {
  fireEvent.change(screen.getByLabelText("Model name"), { target: { value } });
}
function tab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}
function state(scope = world) {
  const loaded = loadModelLibrary(scope);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}
beforeEach(() => {
  localStorage.clear();
  previews.request.mockClear();
  previews.mount.mockClear();
  previews.dispose.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("loaded model catalog UI", () => {
  it("does not invent Haven fixture or studio models in an empty arbitrary network world", () => {
    const handlers = props({ objects: [] });
    render(<ModelBrowserDialog {...handlers} />);
    expect(screen.getByText(/No model references are loaded yet/)).toBeTruthy();
    expect(screen.queryByText("column.rwx")).toBeNull();
    expect(screen.queryByText("wayfarer:cube")).toBeNull();
    expect(screen.getByRole("tab", { name: "In this world" })).toBeTruthy();
    expect(button("Add to world").disabled).toBe(true);
    expect(handlers.asset).not.toHaveBeenCalled();
  });
  it("lists the implemented original pieces in the studio without fetching them automatically", () => {
    render(
      <ModelBrowserDialog
        {...props({ studio: true, scope: studio, objects: [], objectPath: "" })}
      />,
    );
    expect(screen.getByText("wayfarer:cube")).toBeTruthy();
    expect(screen.getByText("wayfarer:planter")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Original & used" })).toBeTruthy();
    expect(previews.request).not.toHaveBeenCalled();
  });
  it("searches actual normalized loaded names and reports usage and malformed omissions", () => {
    render(
      <ModelBrowserDialog
        {...props({
          objects: [
            object("oak_bench"),
            object("oak_bench.zip", 2),
            object("tree.rwx", 3),
            object("../invalid", 4),
          ],
        })}
      />,
    );
    expect(screen.getByText("2 used")).toBeTruthy();
    expect(screen.getByText(/1 unsafe references omitted/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search models"), {
      target: { value: "OAK BENCH" },
    });
    expect(screen.getByText("oak_bench")).toBeTruthy();
    expect(screen.queryByText("tree.rwx")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search models"), {
      target: { value: "absent" },
    });
    expect(screen.getByText("No matching models.")).toBeTruthy();
  });
  it("shows only the current world favorites and recent models", () => {
    setModelFavorite(world, "local-favorite", true);
    rememberModel(world, "local-recent");
    setModelFavorite(other, "foreign-favorite", true);
    rememberModel(other, "foreign-recent");
    render(<ModelBrowserDialog {...props()} />);
    tab("Favorites");
    expect(screen.getByText("local-favorite")).toBeTruthy();
    expect(screen.queryByText("foreign-favorite")).toBeNull();
    tab("Recent");
    expect(screen.getByText("local-recent")).toBeTruthy();
    expect(screen.queryByText("foreign-recent")).toBeNull();
  });
  it("resets library and preview consent when the same component receives another universe scope", () => {
    setModelFavorite(world, "first-secret", true);
    setModelFavorite(other, "second-secret", true);
    const handlers = props(),
      view = render(<ModelBrowserDialog {...handlers} />);
    fireEvent.click(button("Preview model"));
    expect(previews.request).toHaveBeenCalledTimes(1);
    tab("Favorites");
    expect(screen.getByText("first-secret")).toBeTruthy();
    view.rerender(<ModelBrowserDialog {...handlers} scope={other} />);
    expect(screen.queryByTestId("model-preview")).toBeNull();
    expect(previews.request).toHaveBeenCalledTimes(1);
    expect(previews.dispose).toHaveBeenCalledTimes(1);
    tab("Favorites");
    expect(screen.queryByText("first-secret")).toBeNull();
    expect(screen.getByText("second-secret")).toBeTruthy();
  });
  it("toggles an explicit favorite without adding an object or recording a recent add", () => {
    const handlers = props();
    render(<ModelBrowserDialog {...handlers} />);
    fireEvent.click(button("Add model to favorites"));
    expect(state()).toEqual({ favorites: ["column.rwx"], recent: [] });
    fireEvent.click(button("Remove model from favorites"));
    expect(state().favorites).toEqual([]);
    expect(handlers.onAdd).not.toHaveBeenCalled();
    expect(previews.request).not.toHaveBeenCalled();
  });
});

describe("model preview consent and add acknowledgements", () => {
  it("keeps an explicit DirectX name through preview and acknowledged placement", async () => {
    const handlers = props();
    render(<ModelBrowserDialog {...handlers} />);
    input("Original.X");
    expect(handlers.asset).not.toHaveBeenCalled();
    fireEvent.click(button("Preview model"));
    expect(previews.request).toHaveBeenLastCalledWith({
      model: "Original.x",
      objectPath: world.objectPath,
      requestId: 1,
    });
    fireEvent.click(button("Add to world"));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledOnce());
    expect(handlers.onAdd).toHaveBeenCalledWith("Original.x");
    expect(state().recent).toEqual(["Original.x"]);
  });
  it("loads no preview on selection and reuses one preview mount for explicit refreshes", () => {
    const handlers = props();
    render(<ModelBrowserDialog {...handlers} />);
    input("tree.zip");
    expect(previews.request).not.toHaveBeenCalled();
    expect(handlers.asset).not.toHaveBeenCalled();
    fireEvent.click(button("Preview model"));
    expect(previews.request).toHaveBeenLastCalledWith({
      model: "tree",
      objectPath: world.objectPath,
      requestId: 1,
    });
    input("bench");
    expect(previews.request).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Preview shows tree/)).toBeTruthy();
    fireEvent.click(button("Preview model"));
    expect(previews.request).toHaveBeenLastCalledWith({
      model: "bench",
      objectPath: world.objectPath,
      requestId: 2,
    });
    expect(previews.mount).toHaveBeenCalledTimes(1);
    expect(handlers.onAdd).not.toHaveBeenCalled();
  });
  it("requires another Preview click after an object path changes", () => {
    const handlers = props(),
      view = render(<ModelBrowserDialog {...handlers} />);
    fireEvent.click(button("Preview model"));
    view.rerender(
      <ModelBrowserDialog
        {...handlers}
        objectPath="https://new-assets.example/"
      />,
    );
    expect(screen.queryByTestId("model-preview")).toBeNull();
    expect(previews.request).toHaveBeenCalledTimes(1);
  });
  it("passes a safe canonical model name, records it only after accepted true and then closes", async () => {
    let resolve!: (value: boolean) => void;
    const handlers = props({
      onAdd: vi.fn(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      ),
    });
    render(<ModelBrowserDialog {...handlers} />);
    input("  My_Column.ZIP  ");
    fireEvent.click(button("Add to world"));
    expect(handlers.onAdd).toHaveBeenCalledWith("My_Column");
    expect(state().recent).toEqual([]);
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => resolve(true));
    expect(state().recent).toEqual(["My_Column"]);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
  it.each([false, undefined, "truthy-but-not-accepted"])(
    "does not record a recent or close for noncanonical acceptance %s",
    async (accepted) => {
      const handlers = props({ onAdd: vi.fn(async () => accepted as boolean) });
      render(<ModelBrowserDialog {...handlers} />);
      fireEvent.click(button("Add to world"));
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "not fully accepted",
        ),
      );
      expect(state().recent).toEqual([]);
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(button("Add to world").disabled).toBe(false);
    },
  );
  it("keeps a rejected add available for inspection without changing recents", async () => {
    const handlers = props({
      onAdd: vi.fn(async () => {
        throw new Error("Permission denied");
      }),
    });
    render(<ModelBrowserDialog {...handlers} />);
    input("bench");
    fireEvent.click(button("Add to world"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Permission denied",
      ),
    );
    expect(
      (screen.getByLabelText("Model name") as HTMLInputElement).value,
    ).toBe("bench");
    expect(state().recent).toEqual([]);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
  it("blocks duplicate pending adds and close/Escape/backdrop exits until completion", async () => {
    let resolve!: (value: boolean) => void;
    const handlers = props({
      onAdd: vi.fn(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      ),
    });
    const view = render(<ModelBrowserDialog {...handlers} />);
    fireEvent.click(button("Add to world"));
    fireEvent.click(button("Adding…"));
    fireEvent.click(button("Close dialog"));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(view.container.querySelector(".modal-backdrop")!);
    expect(handlers.onAdd).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => resolve(false));
    fireEvent.click(button("Close dialog"));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
  it("ignores stale async completion after switching to another scoped panel", async () => {
    let resolve!: (value: boolean) => void;
    const handlers = props({
      onAdd: vi.fn(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      ),
    });
    const view = render(<ModelBrowserDialog {...handlers} />);
    fireEvent.click(button("Add to world"));
    view.rerender(<ModelBrowserDialog {...handlers} scope={other} />);
    await act(async () => resolve(true));
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(state(world).recent).toEqual([]);
    expect(state(other).recent).toEqual([]);
  });
  it.each([
    "../bad.rwx",
    "https://elsewhere/model.rwx",
    "wayfarer:cube",
    "avatar.cav",
    "walk.seq",
  ])("refuses unsafe or studio-only network model %s", (name) => {
    const handlers = props();
    render(<ModelBrowserDialog {...handlers} />);
    input(name);
    expect(button("Add to world").disabled).toBe(true);
    expect(button("Preview model").disabled).toBe(true);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(button("Add to world"));
    expect(handlers.onAdd).not.toHaveBeenCalled();
  });
  it("allows explicit preview but not adding without build rights", () => {
    const handlers = props({ canBuild: false });
    render(<ModelBrowserDialog {...handlers} />);
    expect(button("Add to world").disabled).toBe(true);
    expect(button("Preview model").disabled).toBe(false);
    fireEvent.click(button("Preview model"));
    expect(previews.request).toHaveBeenCalledTimes(1);
    expect(handlers.onAdd).not.toHaveBeenCalled();
  });
  it("preserves corrupt preferences while allowing a canonical world add with a storage warning", async () => {
    const lookup = modelLibraryKey(world);
    if (!lookup.ok) throw new Error(lookup.error.message);
    localStorage.setItem(lookup.value, "{broken");
    const handlers = props();
    render(<ModelBrowserDialog {...handlers} />);
    expect(screen.getByRole("status").textContent).toContain("preserved");
    fireEvent.click(button("Add model to favorites"));
    expect(localStorage.getItem(lookup.value)).toBe("{broken");
    fireEvent.click(button("Add to world"));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
    expect(handlers.onAdd).toHaveBeenCalledWith("column.rwx");
    expect(handlers.onNotice).toHaveBeenCalledWith(
      expect.stringContaining("Object added."),
    );
    expect(localStorage.getItem(lookup.value)).toBe("{broken");
  });
  it("allows transient browsing and adding without a safe preference scope", async () => {
    const handlers = props({ scope: null });
    render(<ModelBrowserDialog {...handlers} />);
    expect(button("Add model to favorites").disabled).toBe(true);
    fireEvent.click(button("Add to world"));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
    expect(localStorage.length).toBe(0);
  });
});
