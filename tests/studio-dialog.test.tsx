// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioProjectDialog } from "../src/renderer/components/StudioProjectDialog";
import { makeStudioProject } from "../src/renderer/studio-project";
import { nextLocalObjectId } from "../src/renderer/local-object-id";
afterEach(cleanup);
const snapshot = makeStudioProject("Original", [], { x: 0, y: 0, z: 0, yaw: 0 });
if (!snapshot.ok) throw new Error(snapshot.error.message);
const project = snapshot.value;
describe("studio replacement confirmation", () => {
  it("cannot confuse a pending import with an original-world reset", async () => {
    const replace = vi.fn(); let resolve!: (text: string) => void;
    const file = { size: 200, text: () => new Promise<string>(done => { resolve = done; }) };
    render(<StudioProjectDialog project={project} saveError="" onClose={vi.fn()} onRename={vi.fn()} onReplace={replace} />);
    fireEvent.change(screen.getByLabelText("Import studio project"), { target: { files: [file] } });
    expect((screen.getByRole("button", { name: "Reading project…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "Confirm studio replacement" })).toBeNull();
    await act(async () => { resolve(JSON.stringify({ ...project, name: "Imported" })); });
    expect(screen.getByText('Open “Imported” (0 objects)?')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace current studio" }));
    expect(replace).toHaveBeenCalledWith({ ...project, name: "Imported" });
  });
  it("does not replace anything after malformed import or cancellation", async () => {
    const replace = vi.fn();
    render(<StudioProjectDialog project={project} saveError="" onClose={vi.fn()} onRename={vi.fn()} onReplace={replace} />);
    await act(async () => { fireEvent.change(screen.getByLabelText("Import studio project"), { target: { files: [{ size: 10, text: async () => "broken" }] } }); });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore original studio…" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep current studio" }));
    expect(replace).not.toHaveBeenCalled();
  });
});
describe("bounded local IDs", () => {
  it("wraps from uint32 max while preserving all occupied IDs", () => {
    const ids = new Map([[0xffffffff, true], [1, true], [2, true], [4, true]]);
    expect(nextLocalObjectId(ids, 0xffffffff)).toBe(3);
    expect(nextLocalObjectId(ids, NaN)).toBe(3);
  });
});
