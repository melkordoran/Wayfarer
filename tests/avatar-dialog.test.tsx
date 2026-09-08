// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AvatarDialog } from "../src/renderer/components/AvatarDialog";
import type { AvatarCatalog } from "../src/renderer/engine/avatar-assets";
import type { AvatarAssetState } from "../src/renderer/engine";

const catalog: AvatarCatalog = {
  version: 1,
  warnings: [],
  entries: ["original.rwx", "weighted.x", "custom.cav"].map(
    (geometry, index) => ({
      index,
      geometry,
      name: ["Original", "Weighted", "Custom"][index],
      autoLook: false,
      autoWalk: false,
      implicit: {},
      explicit: [],
    }),
  ),
};
const ready: AvatarAssetState = {
  local: true,
  session: -1,
  type: 1,
  geometry: "weighted.x",
  status: "ready",
  format: "x",
  warnings: ["Scale parity is not yet verified."],
};
const props = () => ({
  catalog,
  current: 1,
  onSelect: vi.fn(),
  onClose: vi.fn(),
});
afterEach(cleanup);

describe("honest avatar format and runtime status", () => {
  it("labels DirectX experimental, CAV fallback and symbolic cards distinctly", () => {
    render(<AvatarDialog {...props()} />);
    expect(screen.getByText(/DirectX · experimental/)).toBeTruthy();
    expect(screen.getByText(/Fallback preview/)).toBeTruthy();
    expect(screen.getByText(/Cards use symbolic silhouettes/)).toBeTruthy();
    expect(screen.queryByText("DirectX avatar loaded")).toBeNull();
  });
  it("shows actual loaded format and expandable compatibility notes without calling them animation proof", () => {
    render(<AvatarDialog {...props()} assetState={ready} />);
    const status = screen.getByRole("region", {
      name: "Selected avatar rendering",
    });
    expect(status.textContent).toContain("DirectX avatar loaded");
    expect(status.textContent).toContain("Scale parity is not yet verified.");
    expect(status.textContent).not.toContain("animated");
    const details = status.querySelector("details")!;
    expect(details.open).toBe(false);
  });
  it("shows loading and explicit fallback reason independently of a successful avatar selection", () => {
    const view = render(
      <AvatarDialog
        {...props()}
        assetState={{ ...ready, status: "loading", warnings: [] }}
      />,
    );
    expect(screen.getByText("Loading your avatar…")).toBeTruthy();
    view.rerender(
      <AvatarDialog
        {...props()}
        assetState={{
          ...ready,
          status: "fallback",
          message: "Unsupported compressed geometry",
          warnings: [],
        }}
      />,
    );
    expect(screen.getByText("Original fallback in use")).toBeTruthy();
    expect(screen.getByText("Unsupported compressed geometry")).toBeTruthy();
    expect(screen.queryByText("DirectX avatar loaded")).toBeNull();
  });
  it.each([
    { ...ready, local: false },
    { ...ready, type: 2 },
  ])("hides another avatar or obsolete selection status", (assetState) => {
    render(<AvatarDialog {...props()} assetState={assetState} />);
    expect(
      screen.queryByRole("region", { name: "Selected avatar rendering" }),
    ).toBeNull();
  });
  it("keeps source-provided status text inert and bounded", () => {
    render(
      <AvatarDialog
        {...props()}
        assetState={{
          ...ready,
          message: "<img src=x onerror=alert(1)>",
          warnings: Array.from(
            { length: 30 },
            (_, i) => `${i}:` + "x".repeat(1000),
          ),
        }}
      />,
    );
    const status = screen.getByRole("region", {
      name: "Selected avatar rendering",
    });
    expect(status.querySelector("img")).toBeNull();
    expect(status.querySelectorAll("li")).toHaveLength(12);
    expect(status.querySelector("li")!.textContent).toHaveLength(500);
  });
  it("preserves catalog ordinals when choosing a DirectX entry", async () => {
    const handlers = props();
    render(<AvatarDialog {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: /Weighted/ }));
    await waitFor(() => expect(handlers.onSelect).toHaveBeenCalledWith(1));
  });
});
