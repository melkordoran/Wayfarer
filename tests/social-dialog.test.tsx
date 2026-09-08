// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CONTACT_OPTIONS, type TelegramMessage } from "../src/shared/types";
import {
  SocialDialog,
  contactPresence,
  type SocialDialogProps,
} from "../src/renderer/components/SocialDialog";

const incoming = (id = "one"): TelegramMessage => ({
  id,
  direction: "incoming",
  from: "Alice",
  to: "Explorer",
  text: "A little note",
  time: 1000,
  status: "received",
});
function props(overrides: Partial<SocialDialogProps> = {}): SocialDialogProps {
  return {
    contacts: [
      {
        citizen: 4,
        name: "Alice",
        state: "online",
        world: "Haven",
        options: 0,
      },
    ],
    defaultOptions: 0,
    messages: [],
    telegramPending: false,
    busy: false,
    error: "",
    onCommand: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...overrides,
  };
}
function messagesTab() {
  fireEvent.click(screen.getByRole("tab", { name: /Messages/ }));
}
function button(name: string | RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("explicit social actions", () => {
  it("never collects telegrams, refreshes or accepts requests on mount, StrictMode or tab changes", () => {
    const request = {
      ...incoming(),
      text: "\n\x01(4)Alice",
      contactRequest: { citizen: 4, name: "Alice" },
    };
    const handlers = props({ messages: [request], telegramPending: true });
    render(
      <StrictMode>
        <SocialDialog {...handlers} />
      </StrictMode>,
    );
    messagesTab();
    fireEvent.click(button("Review contact request"));
    expect(
      screen.getByRole("region", { name: "Confirm contact action" })
        .textContent,
    ).toContain("can be forged");
    expect(handlers.onCommand).not.toHaveBeenCalled();
  });
  it("confirms a contact only after explicit review and a second confirmation", async () => {
    const handlers = props({
      messages: [
        { ...incoming(), contactRequest: { citizen: 4, name: "Alice" } },
      ],
    });
    render(<SocialDialog {...handlers} />);
    messagesTab();
    fireEvent.click(button("Review contact request"));
    expect(handlers.onCommand).not.toHaveBeenCalled();
    fireEvent.click(button("Confirm this citizen"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "contact-confirm",
        citizen: 4,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Confirm contact action" }),
      ).toBeNull(),
    );
  });
  it("allows removal cancellation and sends delete only after confirmation", async () => {
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    fireEvent.click(button("Remove Alice"));
    fireEvent.click(button("Cancel contact action"));
    expect(handlers.onCommand).not.toHaveBeenCalled();
    fireEvent.click(button("Remove Alice"));
    fireEvent.click(button("Remove contact"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "contact-delete",
        citizen: 4,
      }),
    );
  });
  it("adds a trimmed contact name with a snapshot of current privacy defaults", async () => {
    const handlers = props({
      defaultOptions: CONTACT_OPTIONS.worldOff | CONTACT_OPTIONS.telegramOff,
    });
    render(<SocialDialog {...handlers} />);
    fireEvent.change(screen.getByLabelText("Add contact by name"), {
      target: { value: "  Bob  " },
    });
    fireEvent.click(button("Add contact"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "contact-add",
        name: "Bob",
        options: handlers.defaultOptions,
      }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Add contact by name") as HTMLInputElement)
          .value,
      ).toBe(""),
    );
  });
  it("refreshes only after a user click", async () => {
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    expect(handlers.onCommand).not.toHaveBeenCalled();
    fireEvent.click(button("Refresh contacts"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "contacts-list",
      }),
    );
  });
  it("preserves unrelated and broad default privacy flags when applying a single setting", async () => {
    const defaults =
      CONTACT_OPTIONS.allBlocked |
      CONTACT_OPTIONS.fileTransferOff |
      CONTACT_OPTIONS.worldOff;
    const handlers = props({ defaultOptions: defaults });
    render(<SocialDialog {...handlers} />);
    fireEvent.click(button("Default privacy"));
    expect(screen.getByText(/broad allow\/block override/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Share current world"), {
      target: { value: "allow" },
    });
    expect(handlers.onCommand).not.toHaveBeenCalled();
    fireEvent.click(button("Apply privacy"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "contact-change",
        citizen: 0,
        options:
          (defaults & ~CONTACT_OPTIONS.worldOff) | CONTACT_OPTIONS.worldOn,
      }),
    );
  });
  it("edits per-contact privacy without changing other existing options", async () => {
    const handlers = props({
      contacts: [
        {
          citizen: 4,
          name: "Alice",
          state: "online",
          world: "",
          options: CONTACT_OPTIONS.chatOff,
        },
      ],
    });
    render(<SocialDialog {...handlers} />);
    fireEvent.click(button("Privacy for Alice"));
    fireEvent.change(screen.getByLabelText("Receive telegrams"), {
      target: { value: "block" },
    });
    fireEvent.click(button("Apply privacy"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "contact-change",
        citizen: 4,
        options: CONTACT_OPTIONS.chatOff | CONTACT_OPTIONS.telegramOff,
      }),
    );
  });
  it("shows only observed presence, treating missing world and hidden/offline status honestly", () => {
    const base = { citizen: 4, name: "Alice", options: 0, world: "" };
    expect(contactPresence({ ...base, state: "online" })).toBe(
      "Online · World not shared",
    );
    expect(contactPresence({ ...base, state: "away", world: "Haven" })).toBe(
      "Away · Haven",
    );
    expect(
      contactPresence({ ...base, state: "offline", world: "Old world" }),
    ).toBe("Offline or status not shared");
    expect(contactPresence({ ...base, state: "unknown" })).toBe(
      "Status not shared",
    );
  });
});

describe("telegram retrieval, submission and recovery", () => {
  it("fetches exactly once per click and blocks overlapping requests", async () => {
    let resolve!: () => void;
    const handlers = props({
      telegramPending: true,
      onCommand: vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    });
    render(<SocialDialog {...handlers} />);
    messagesTab();
    const receive = button("Receive one telegram");
    fireEvent.click(receive);
    fireEvent.click(receive);
    expect(handlers.onCommand).toHaveBeenCalledTimes(1);
    expect(handlers.onCommand).toHaveBeenCalledWith({ type: "telegram-fetch" });
    await act(async () => resolve());
    expect(handlers.onCommand).toHaveBeenCalledTimes(1);
  });
  it("labels outgoing telegrams Submitted and renders hostile markup as plain text", () => {
    const text = '<img src=x onerror="alert(1)">';
    const handlers = props({
      messages: [
        { ...incoming(), text },
        { ...incoming("two"), direction: "outgoing", status: "submitted" },
      ],
    });
    const view = render(<SocialDialog {...handlers} />);
    messagesTab();
    expect(screen.getByText("Submitted")).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.queryByText("Delivered")).toBeNull();
  });
  it("submits explicit recipient and preserved body text, then clears only the acknowledged draft", async () => {
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    messagesTab();
    fireEvent.change(screen.getByLabelText("Telegram recipient"), {
      target: { value: "  Bob  " },
    });
    fireEvent.change(screen.getByLabelText("Telegram text"), {
      target: { value: "  Hello\nthere  " },
    });
    fireEvent.click(button("Submit telegram"));
    await waitFor(() =>
      expect(handlers.onCommand).toHaveBeenCalledWith({
        type: "telegram-send",
        to: "Bob",
        text: "  Hello\nthere  ",
      }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Telegram text") as HTMLTextAreaElement).value,
      ).toBe(""),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Delivery is not confirmed",
    );
  });
  it("retains draft and surfaces rejected sends", async () => {
    const handlers = props({
      onCommand: vi.fn(async () => {
        throw new Error("Not allowed by server policy");
      }),
    });
    render(<SocialDialog {...handlers} />);
    messagesTab();
    fireEvent.change(screen.getByLabelText("Telegram recipient"), {
      target: { value: "Bob" },
    });
    fireEvent.change(screen.getByLabelText("Telegram text"), {
      target: { value: "My unsent note" },
    });
    fireEvent.click(button("Submit telegram"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Not allowed"),
    );
    expect(
      (screen.getByLabelText("Telegram text") as HTMLTextAreaElement).value,
    ).toBe("My unsent note");
  });
  it("enforces the 1000-character boundary and rejects system recipients before sending", async () => {
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    messagesTab();
    const body = screen.getByLabelText("Telegram text") as HTMLTextAreaElement;
    expect(body.maxLength).toBe(1000);
    fireEvent.change(screen.getByLabelText("Telegram recipient"), {
      target: { value: "*VERIFY" },
    });
    fireEvent.change(body, { target: { value: "not a user" } });
    fireEvent.click(button("Submit telegram"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "System telegram",
      ),
    );
    expect(handlers.onCommand).not.toHaveBeenCalled();
  });
  it("blocks new telegram operations after storage failure but keeps export available", () => {
    render(
      <SocialDialog
        {...props({
          messages: [incoming()],
          receiveBlocked: true,
          error: "Local storage is full.",
        })}
      />,
    );
    messagesTab();
    expect(button("Check for one telegram").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Telegram recipient"), {
      target: { value: "Bob" },
    });
    fireEvent.change(screen.getByLabelText("Telegram text"), {
      target: { value: "note" },
    });
    expect(button("Submit telegram").disabled).toBe(true);
    expect(button("Export messages").disabled).toBe(false);
  });
  it("exports readable messages only after the user requests a download", async () => {
    const create = vi.fn((_blob: Blob) => "blob:telegram-export"),
      revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: create,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revoke,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<SocialDialog {...props({ messages: [incoming()] })} />);
    messagesTab();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(button("Export messages"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0][0] as Blob;
    const json = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(JSON.parse(json)).toEqual({
      format: "wayfarer-telegram-export",
      version: 1,
      messages: [incoming()],
    });
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(
      "wayfarer-telegrams.json",
    );
  });
  it("keeps export and explicit acknowledged clearing available while offline and storage-blocked", async () => {
    const clear = vi.fn(async () => {}),
      handlers = props({
        connected: false,
        receiveBlocked: true,
        messages: [incoming()],
        onClearInbox: clear,
      });
    render(<SocialDialog {...handlers} />);
    messagesTab();
    expect(button("Check for one telegram").disabled).toBe(true);
    expect(button("Export messages").disabled).toBe(false);
    fireEvent.click(button("Clear local inbox…"));
    expect(button("Clear local inbox").disabled).toBe(true);
    fireEvent.click(button("Clear local inbox"));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I exported messages I want to keep",
      }),
    );
    fireEvent.click(button("Clear local inbox"));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(["one"]));
    expect(handlers.onCommand).not.toHaveBeenCalled();
  });
  it("captures clear-confirmation IDs before later messages arrive, allowing the caller to reject unseen messages", async () => {
    const clear = vi.fn(async (_ids: readonly string[]) => {
      throw new Error("New messages arrived; nothing was cleared.");
    });
    const handlers = props({ messages: [incoming()], onClearInbox: clear });
    const view = render(<SocialDialog {...handlers} />);
    messagesTab();
    fireEvent.click(button("Clear local inbox…"));
    view.rerender(
      <SocialDialog
        {...handlers}
        messages={[incoming(), incoming("unseen")]}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I exported messages I want to keep",
      }),
    );
    fireEvent.click(button("Clear local inbox"));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(["one"]));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "nothing was cleared",
      ),
    );
    expect(
      screen.getByRole("region", { name: "Confirm inbox clearing" }),
    ).toBeTruthy();
  });
});

describe("unsent telegram draft protection", () => {
  function writeDraft(value = "A note I have not submitted") {
    messagesTab();
    fireEvent.change(screen.getByLabelText("Telegram recipient"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByLabelText("Telegram text"), {
      target: { value },
    });
  }
  function unload() {
    const event = new Event("beforeunload", { cancelable: true });
    fireEvent(window, event);
    return event;
  }
  it("preserves a draft on close and returns to writing without sending or saving it", () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    writeDraft();
    fireEvent.click(button("Close dialog"));
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Confirm closing social panel" })
        .textContent,
    ).toContain("only in memory");
    fireEvent.click(button("Keep writing"));
    expect(
      screen.queryByRole("region", { name: "Confirm closing social panel" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Telegram text") as HTMLTextAreaElement).value,
    ).toBe("A note I have not submitted");
    expect(handlers.onCommand).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
  it("does not discard on repeated Escape presses", () => {
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    writeDraft();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(button("Keep writing")).toBe(document.activeElement);
    expect(
      (screen.getByLabelText("Telegram text") as HTMLTextAreaElement).value,
    ).toBe("A note I have not submitted");
  });
  it("routes backdrop closing through the same discard confirmation", () => {
    const handlers = props(),
      view = render(<SocialDialog {...handlers} />);
    writeDraft();
    fireEvent.mouseDown(view.container.querySelector(".modal-backdrop")!);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(button("Discard draft and close")).toBeTruthy();
  });
  it("requires explicit discard, clears the parent dirty flag, and never submits", () => {
    const dirty = vi.fn(),
      handlers = props({ onDirtyChange: dirty });
    render(<SocialDialog {...handlers} />);
    writeDraft();
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(button("Close dialog"));
    fireEvent.click(button("Discard draft and close"));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(handlers.onCommand).not.toHaveBeenCalled();
    expect(unload().defaultPrevented).toBe(false);
  });
  it("guards browser unload while dirty and removes the guard on unmount", () => {
    const dirty = vi.fn(),
      handlers = props({ onDirtyChange: dirty });
    const view = render(<SocialDialog {...handlers} />);
    expect(unload().defaultPrevented).toBe(false);
    writeDraft();
    expect(unload().defaultPrevented).toBe(true);
    expect(handlers.onClose).not.toHaveBeenCalled();
    view.unmount();
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(unload().defaultPrevented).toBe(false);
  });
  it("does not nag for a selected recipient or whitespace-only body", () => {
    const handlers = props();
    render(<SocialDialog {...handlers} />);
    writeDraft("  \n ");
    fireEvent.click(button("Close dialog"));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(unload().defaultPrevented).toBe(false);
    expect(
      screen.queryByRole("region", { name: "Confirm closing social panel" }),
    ).toBeNull();
  });
  it("keeps the draft guarded until submission succeeds, then allows a normal close", async () => {
    let resolve!: () => void;
    const dirty = vi.fn(),
      handlers = props({
        onDirtyChange: dirty,
        onCommand: vi.fn(
          () =>
            new Promise<void>((done) => {
              resolve = done;
            }),
        ),
      });
    render(<SocialDialog {...handlers} />);
    writeDraft();
    fireEvent.click(button("Submit telegram"));
    fireEvent.click(button("Close dialog"));
    expect(button("Discard draft and close").disabled).toBe(true);
    expect(unload().defaultPrevented).toBe(true);
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(
      (screen.getByLabelText("Telegram text") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(unload().defaultPrevented).toBe(false);
    fireEvent.click(button("Close dialog"));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onCommand).toHaveBeenCalledTimes(1);
  });
  it("keeps a rejected send guarded instead of treating failure as a saved draft", async () => {
    const handlers = props({
      onCommand: vi.fn(async () => {
        throw new Error("Send rejected");
      }),
    });
    render(<SocialDialog {...handlers} />);
    writeDraft();
    fireEvent.click(button("Submit telegram"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Send rejected"),
    );
    fireEvent.click(button("Close dialog"));
    expect(button("Discard draft and close").disabled).toBe(false);
    expect(unload().defaultPrevented).toBe(true);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
  it("protects a pending non-send action even when no draft exists", async () => {
    let resolve!: () => void;
    const handlers = props({
      onCommand: vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    });
    render(<SocialDialog {...handlers} />);
    fireEvent.click(button("Refresh contacts"));
    fireEvent.click(button("Close dialog"));
    expect(button("Close panel").disabled).toBe(true);
    expect(unload().defaultPrevented).toBe(true);
    fireEvent.click(button("Close panel"));
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(unload().defaultPrevented).toBe(false);
    fireEvent.click(button("Close panel"));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
  it("protects the panel while its caller reports an outstanding command", () => {
    const handlers = props({ busy: true });
    render(<SocialDialog {...handlers} />);
    fireEvent.click(button("Close dialog"));
    expect(button("Close panel").disabled).toBe(true);
    expect(unload().defaultPrevented).toBe(true);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});
