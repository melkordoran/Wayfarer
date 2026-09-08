// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GestureDialog } from "../src/renderer/components/GestureDialog";
import type { AvatarDefinition } from "../src/renderer/engine/avatar-assets";

type Props = ComponentProps<typeof GestureDialog>;
const original: AvatarDefinition = {
  index: 7,
  name: "Original test avatar",
  geometry: "test-person.rwx",
  autoLook: true,
  autoWalk: true,
  implicit: { idle: "rest" },
  explicit: [
    { name: "Wave", sequence: "hello", group: "Greetings" },
    { name: "Unavailable motion", sequence: "", group: "Greetings" },
    { name: "Wave", sequence: "salute.seq", group: "Ceremony" },
    { name: "Bow", sequence: "bow", group: "Greetings" },
  ],
};
function props(overrides: Partial<Props> = {}): Props {
  return {
    avatar: original,
    studio: false,
    online: true,
    busy: false,
    active: false,
    onPlay: vi.fn(async () => true),
    onStop: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}
function search(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search gestures" }), {
    target: { value },
  });
}
function button(title: string) {
  return screen.getByTitle(title) as HTMLButtonElement;
}
function named(name: string) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
function deferred() {
  let resolve!: (result: boolean) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("gesture catalog identity and availability", () => {
  it("does not auto-play or stop on render, search, checkbox changes or prop refresh", () => {
    const handlers = props({ active: true });
    const view = render(
      <StrictMode>
        <GestureDialog {...handlers} />
      </StrictMode>,
    );
    search("greetings");
    fireEvent.click(screen.getByRole("checkbox"));
    view.rerender(
      <StrictMode>
        <GestureDialog {...handlers} busy />
      </StrictMode>,
    );
    expect(handlers.onPlay).not.toHaveBeenCalled();
    expect(handlers.onStop).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("retains the catalog ordinal after group search, including missing entries and duplicate labels", async () => {
    const handlers = props();
    render(<GestureDialog {...handlers} />);
    search("ceremony");
    expect(screen.getByText("Ceremony · #3")).toBeTruthy();
    expect(screen.queryByText("Greetings · #1")).toBeNull();
    fireEvent.click(button("Play Wave"));
    await waitFor(() => expect(handlers.onPlay).toHaveBeenCalledWith(3, true));
    expect(handlers.onPlay).toHaveBeenCalledTimes(1);
  });

  it("uses ordinal plus one for playback and reserves zero for the separate stop action", async () => {
    const handlers = props({ active: true });
    render(<GestureDialog {...handlers} />);
    search("greetings");
    fireEvent.click(button("Play Wave"));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledOnce());
    expect(handlers.onPlay).toHaveBeenCalledExactlyOnceWith(1, true);
    fireEvent.click(named("Stop gesture"));
    expect(handlers.onStop).toHaveBeenCalledOnce();
    expect(handlers.onPlay).not.toHaveBeenCalledWith(0, expect.anything());
  });

  it.each([
    "",
    "../escape",
    "https://example.invalid/wave.seq",
    "wave.bvh",
    "wave.x.zip",
    "wave.cav",
  ])(
    "keeps missing or unsupported sequence %j visible but unavailable",
    (sequence) => {
      const handlers = props({
        avatar: {
          ...original,
          explicit: [
            { name: "Bad motion", sequence },
            { name: "Good motion", sequence: "wave" },
          ],
        },
      });
      render(<GestureDialog {...handlers} />);
      const unavailable = screen.getByRole("button", {
        name: /Bad motion/,
      }) as HTMLButtonElement;
      expect(unavailable.disabled).toBe(true);
      expect(unavailable.textContent).toContain("#1 · unavailable");
      fireEvent.click(unavailable);
      expect(handlers.onPlay).not.toHaveBeenCalled();
      expect(button("Play Good motion").disabled).toBe(false);
      expect(screen.getByText("Gesture · #2")).toBeTruthy();
    },
  );

  it.each(['salute.x', 'salute.X', 'salute.seq', 'salute.zip'])('enables supported catalog sequence %s without changing its declaration ordinal', async sequence => {
    const handlers = props({ avatar: { ...original, explicit: [...original.explicit, { name: 'X Salute', sequence }] } });
    render(<GestureDialog {...handlers} />);
    expect(button('Play X Salute').disabled).toBe(false);
    fireEvent.click(button('Play X Salute'));
    await waitFor(() => expect(handlers.onPlay).toHaveBeenCalledExactlyOnceWith(original.explicit.length + 1, true));
  });

  it("keeps out-of-protocol-range declaration ordinals unavailable instead of renumbering them", () => {
    const entries = Array.from({ length: 256 }, (_, index) => ({
      name: `Motion ${index + 1}`,
      sequence: "wave",
    }));
    const handlers = props({ avatar: { ...original, explicit: entries } });
    render(<GestureDialog {...handlers} />);
    search("Motion 256");
    const unavailable = screen.getByRole("button", {
      name: /Motion 256/,
    }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.textContent).toContain("#256");
    fireEvent.click(unavailable);
    expect(handlers.onPlay).not.toHaveBeenCalled();
  });

  it("paginates 48 at a time, retains later ordinals, and resets the page limit after search", async () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({
      name: `Motion ${index + 1}`,
      sequence: `motion${index + 1}`,
    }));
    const handlers = props({
      avatar: { ...original, explicit: entries },
      onPlay: vi.fn(async () => false),
    });
    render(<GestureDialog {...handlers} />);
    expect(screen.getAllByTitle(/^Play Motion /)).toHaveLength(48);
    fireEvent.click(named("Show more gestures"));
    expect(screen.getAllByTitle(/^Play Motion /)).toHaveLength(96);
    fireEvent.click(button("Play Motion 49"));
    await waitFor(() =>
      expect(handlers.onPlay).toHaveBeenCalledExactlyOnceWith(49, true),
    );
    fireEvent.click(named("Show more gestures"));
    expect(screen.getAllByTitle(/^Play Motion /)).toHaveLength(120);
    expect(
      screen.queryByRole("button", { name: "Show more gestures" }),
    ).toBeNull();
    search("Motion");
    expect(screen.getAllByTitle(/^Play Motion /)).toHaveLength(48);
    search("No such motion");
    expect(screen.getByText("No gestures match that search.")).toBeTruthy();
    expect(handlers.onPlay).toHaveBeenCalledTimes(1);
  });

  it("explains a missing world catalog without inventing gestures", () => {
    const handlers = props({ avatar: null });
    render(<GestureDialog {...handlers} />);
    expect(screen.getByText("No gestures available")).toBeTruthy();
    expect(
      screen.getByText(/A missing world catalog cannot establish/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Search gestures" }),
    ).toBeNull();
    expect(screen.queryAllByTitle(/^Play /)).toHaveLength(0);
    expect(handlers.onPlay).not.toHaveBeenCalled();
  });

  it("explains an avatar with no explicit motions separately from a missing catalog", () => {
    render(
      <GestureDialog {...props({ avatar: { ...original, explicit: [] } })} />,
    );
    expect(
      screen.getByText("This avatar has no explicit motions in its catalog."),
    ).toBeTruthy();
    expect(screen.queryByText(/A missing world catalog/)).toBeNull();
  });

  it("disables network gestures offline but allows the explicitly labeled original studio collection", () => {
    const handlers = props({ online: false });
    const view = render(<GestureDialog {...handlers} />);
    expect(button("Play Bow").disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      "Enter a world to play its gestures.",
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
      true,
    );
    view.rerender(<GestureDialog {...handlers} studio />);
    expect(button("Play Bow").disabled).toBe(false);
    expect(screen.getByText(/Original studio collection/)).toBeTruthy();
    expect(screen.getByText(/No server connection is made/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(handlers.onPlay).not.toHaveBeenCalled();
  });
});

describe("explicit playback actions and completion lifecycle", () => {
  it.each([true, false])(
    "passes the explicit third-person preference %s without changing camera on render",
    async (showSelf) => {
      const handlers = props();
      render(<GestureDialog {...handlers} />);
      const checkbox = screen.getByRole("checkbox", {
        name: "Show me in third-person view",
      }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      if (!showSelf) fireEvent.click(checkbox);
      expect(handlers.onPlay).not.toHaveBeenCalled();
      fireEvent.click(button("Play Bow"));
      await waitFor(() =>
        expect(handlers.onPlay).toHaveBeenCalledExactlyOnceWith(4, showSelf),
      );
      expect(handlers.onClose).toHaveBeenCalledOnce();
    },
  );

  it("blocks play, stop and camera changes when the parent reports a pending command", () => {
    const handlers = props({ busy: true, active: true });
    render(<GestureDialog {...handlers} />);
    expect(button("Play Bow").disabled).toBe(true);
    expect(named("Stop gesture").disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(button("Play Bow"));
    fireEvent.click(named("Stop gesture"));
    expect(handlers.onPlay).not.toHaveBeenCalled();
    expect(handlers.onStop).not.toHaveBeenCalled();
  });

  it("blocks duplicate play and Stop while its own promise is pending, without needing a parent rerender", async () => {
    const pending = deferred();
    const handlers = props({
      active: true,
      onPlay: vi.fn(() => pending.promise),
    });
    render(<GestureDialog {...handlers} />);
    const play = button("Play Bow");
    fireEvent.click(play);
    fireEvent.click(play);
    expect(handlers.onPlay).toHaveBeenCalledOnce();
    expect(play.disabled).toBe(true);
    expect(named("Stop gesture").disabled).toBe(true);
    fireEvent.click(named("Stop gesture"));
    expect(handlers.onStop).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve(false));
    expect(play.disabled).toBe(false);
  });

  it("keeps the panel open after a false result and permits a deliberate retry", async () => {
    const onPlay = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const handlers = props({ onPlay });
    render(<GestureDialog {...handlers} />);
    fireEvent.click(button("Play Bow"));
    await waitFor(() => expect(button("Play Bow").disabled).toBe(false));
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(button("Play Bow"));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledOnce());
    expect(onPlay).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error("The sequence could not load."),
    "unstructured rejection",
  ])(
    "reports rejected play, keeps the panel open and re-enables actions",
    async (cause) => {
      const handlers = props({
        onPlay: vi.fn(async () => {
          throw cause;
        }),
      });
      render(<GestureDialog {...handlers} />);
      fireEvent.click(button("Play Bow"));
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByRole("alert").textContent).toBe(
        cause instanceof Error
          ? cause.message
          : "The gesture could not be started.",
      );
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(button("Play Bow").disabled).toBe(false);
    },
  );

  it("only permits Stop for an active gesture and never sends a playback ordinal itself", () => {
    const handlers = props();
    const view = render(<GestureDialog {...handlers} />);
    expect(named("Stop gesture").disabled).toBe(true);
    fireEvent.click(named("Stop gesture"));
    expect(handlers.onStop).not.toHaveBeenCalled();
    view.rerender(<GestureDialog {...handlers} active />);
    fireEvent.click(named("Stop gesture"));
    expect(handlers.onStop).toHaveBeenCalledOnce();
    expect(handlers.onPlay).not.toHaveBeenCalled();
  });

  it.each(["done", "escape", "backdrop"])(
    "closing via %s does not stop an active gesture",
    (method) => {
      const handlers = props({ active: true });
      render(<GestureDialog {...handlers} />);
      if (method === "done") fireEvent.click(named("Done"));
      else if (method === "escape")
        fireEvent.keyDown(document, { key: "Escape" });
      else fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(handlers.onStop).not.toHaveBeenCalled();
    },
  );

  it("ignores an old pending success after scope-key unmount so it cannot close the next dialog", async () => {
    const pending = deferred();
    const old = props({ onPlay: vi.fn(() => pending.promise) });
    const view = render(<GestureDialog key="old-world" {...old} />);
    fireEvent.click(button("Play Bow"));
    const next = props({ avatar: { ...original, name: "New world avatar" } });
    view.rerender(<GestureDialog key="new-world" {...next} />);
    await act(async () => pending.resolve(true));
    expect(old.onClose).not.toHaveBeenCalled();
    expect(next.onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/New world avatar/)).toBeTruthy();
    expect(next.onPlay).not.toHaveBeenCalled();
  });

  it("does not leak a late rejection into the new scope or block its controls", async () => {
    const pending = deferred();
    const old = props({ onPlay: vi.fn(() => pending.promise) });
    const view = render(<GestureDialog key="old-avatar" {...old} />);
    fireEvent.click(button("Play Bow"));
    const next = props({
      avatar: { ...original, index: 8, name: "Replacement avatar" },
    });
    view.rerender(<GestureDialog key="new-avatar" {...next} />);
    await act(async () =>
      pending.reject(new Error("Old avatar motion failed.")),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("Play Bow").disabled).toBe(false);
    expect(old.onClose).not.toHaveBeenCalled();
    expect(next.onClose).not.toHaveBeenCalled();
  });
});
