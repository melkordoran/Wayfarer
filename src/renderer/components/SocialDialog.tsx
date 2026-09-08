import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Download,
  Mail,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  UserMinus,
  Users,
} from "lucide-react";
import {
  CONTACT_OPTIONS,
  type Contact,
  type SocialCommand,
  type TelegramMessage,
} from "../../shared/types";
import { assertCommand } from "../../shared/validation";
import { encodeTelegramMessages, SOCIAL_LIMITS } from "../social-storage";
import { Modal } from "./Modal";
import "./social-dialog.css";

export interface SocialDialogProps {
  contacts: Contact[];
  defaultOptions: number;
  messages: TelegramMessage[];
  telegramPending: boolean;
  busy: boolean;
  error: string;
  receiveBlocked?: boolean;
  connected?: boolean;
  accountLabel?: string;
  onCommand: (command: SocialCommand) => Promise<void>;
  onClearInbox?: (confirmedIds: readonly string[]) => Promise<void>;
  /** True while a meaningful unsent body or in-flight action needs this panel kept alive. */
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}
const policies = [
  {
    label: "Share online status",
    allow: CONTACT_OPTIONS.statusOn,
    block: CONTACT_OPTIONS.statusOff,
  },
  {
    label: "Share current world",
    allow: CONTACT_OPTIONS.worldOn,
    block: CONTACT_OPTIONS.worldOff,
  },
  {
    label: "Receive telegrams",
    allow: CONTACT_OPTIONS.telegramOn,
    block: CONTACT_OPTIONS.telegramOff,
  },
  {
    label: "Contact requests",
    allow: CONTACT_OPTIONS.requestAllowed,
    block: CONTACT_OPTIONS.requestBlocked,
  },
] as const;
export function contactPresence(contact: Contact): string {
  if (contact.state === "online" || contact.state === "away") {
    return `${contact.state === "away" ? "Away" : "Online"} · ${contact.world.trim() || "World not shared"}`;
  }
  if (contact.state === "offline") return "Offline or status not shared";
  if (contact.state === "invalid" || contact.state === "removed")
    return "Citizen unavailable";
  return "Status not shared";
}
type Confirmation = {
  operation: "remove" | "confirm";
  citizen: number;
  name: string;
};
type Privacy = { citizen: number; name: string; options: number };

export function SocialDialog({
  contacts,
  defaultOptions,
  messages,
  telegramPending,
  busy,
  error,
  receiveBlocked = false,
  connected = true,
  accountLabel,
  onCommand,
  onClearInbox,
  onDirtyChange,
  onClose,
}: SocialDialogProps) {
  const [tab, setTab] = useState<"contacts" | "messages">("contacts");
  const [name, setName] = useState("");
  const [recipient, setRecipient] = useState("");
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const running = useRef(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [clearing, setClearing] = useState(false);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [closeRequested, setCloseRequested] = useState(false);
  const keepWriting = useRef<HTMLButtonElement>(null);
  const localDisabled = busy || working;
  const hasDraft = draft.trim().length > 0;
  const closeState = useRef({ hasDraft, pending: localDisabled });
  closeState.current = { hasDraft, pending: localDisabled };
  const dirtyListener = useRef(onDirtyChange);
  dirtyListener.current = onDirtyChange;
  const disabled = localDisabled || !connected;
  const messageBlocked =
    receiveBlocked || messages.length >= SOCIAL_LIMITS.messages;
  useEffect(() => {
    onDirtyChange?.(hasDraft || localDisabled);
  }, [hasDraft, localDisabled, onDirtyChange]);
  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (
        !closeState.current.hasDraft &&
        !closeState.current.pending &&
        !running.current
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => {
      window.removeEventListener("beforeunload", protectDraft);
      dirtyListener.current?.(false);
    };
  }, []);
  useEffect(() => {
    if (closeRequested) keepWriting.current?.focus();
  }, [closeRequested]);
  function requestClose() {
    if (hasDraft || localDisabled || running.current) setCloseRequested(true);
    else onClose();
  }
  function discardAndClose() {
    if (localDisabled || running.current) return;
    setDraft("");
    setCloseRequested(false);
    onDirtyChange?.(false);
    onClose();
  }
  async function command(value: SocialCommand, success?: () => void) {
    if (busy || running.current || !connected) return;
    running.current = true;
    setWorking(true);
    setLocalError("");
    setNotice("");
    try {
      assertCommand(value);
      await onCommand(value);
      success?.();
    } catch (cause) {
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "The social action could not be completed.",
      );
    } finally {
      running.current = false;
      setWorking(false);
    }
  }
  function addContact(event: FormEvent) {
    event.preventDefault();
    void command(
      { type: "contact-add", name: name.trim(), options: defaultOptions },
      () => {
        setName("");
        setNotice(
          "Contact request submitted using your current default privacy settings.",
        );
      },
    );
  }
  function sendTelegram(event: FormEvent) {
    event.preventDefault();
    if (messageBlocked) return;
    void command(
      { type: "telegram-send", to: recipient.trim(), text: draft },
      () => {
        setDraft("");
        setNotice(
          "Telegram submitted. Delivery is not confirmed by this protocol.",
        );
      },
    );
  }
  function exportMessages() {
    const encoded = encodeTelegramMessages(messages);
    if (!encoded.ok) {
      setLocalError(encoded.error.message);
      return;
    }
    try {
      const url = URL.createObjectURL(
        new Blob([encoded.value], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "wayfarer-telegrams.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setLocalError(
        "Messages could not be exported. Keep this window open and try again.",
      );
    }
  }
  async function clearInbox() {
    if (!onClearInbox || busy || running.current || !exportAcknowledged) return;
    running.current = true;
    setWorking(true);
    setLocalError("");
    setNotice("");
    try {
      await onClearInbox(confirmedIds);
      setClearing(false);
      setExportAcknowledged(false);
      setNotice(
        "Local inbox cleared. This did not delete any pending telegrams on the server.",
      );
    } catch (cause) {
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "The inbox could not be cleared. Nothing was removed.",
      );
    } finally {
      running.current = false;
      setWorking(false);
    }
  }
  return (
    <Modal
      title="Keep in touch."
      subtitle={
        accountLabel ||
        "Contacts and telegrams belong to the universe and citizen you signed in with."
      }
      onClose={requestClose}
      wide
    >
      {closeRequested && (
        <div
          className="social-confirm social-close-confirm"
          role="region"
          aria-label="Confirm closing social panel"
        >
          <strong>
            {hasDraft
              ? "Keep your unsent telegram?"
              : localDisabled
                ? "An action is still in progress."
                : "Close this panel?"}
          </strong>
          <p>
            {hasDraft
              ? "This draft exists only in memory. It is not sent, saved or included in inbox exports. Closing will discard it."
              : localDisabled
                ? "Wait for the current action to finish so its result can be shown before closing."
                : "The action has finished. You can close this panel."}
          </p>
          {hasDraft && localDisabled && (
            <p>
              Wait for the current action to finish before discarding or
              closing.
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              ref={keepWriting}
              onClick={() => {
                setCloseRequested(false);
                if (hasDraft) setTab("messages");
              }}
            >
              {hasDraft ? "Keep writing" : "Keep panel open"}
            </button>
            <button
              className={hasDraft ? "danger-button" : "primary-button"}
              disabled={localDisabled}
              onClick={discardAndClose}
            >
              {hasDraft ? "Discard draft and close" : "Close panel"}
            </button>
          </div>
        </div>
      )}
      <div
        className="segment-control social-tabs"
        role="tablist"
        aria-label="Social panels"
      >
        <button
          type="button"
          role="tab"
          id="social-contacts-tab"
          aria-controls="social-contacts"
          aria-selected={tab === "contacts"}
          className={tab === "contacts" ? "active" : ""}
          onClick={() => setTab("contacts")}
        >
          <Users size={16} />
          Contacts ({contacts.length})
        </button>
        <button
          type="button"
          role="tab"
          id="social-messages-tab"
          aria-controls="social-messages"
          aria-selected={tab === "messages"}
          className={tab === "messages" ? "active" : ""}
          onClick={() => setTab("messages")}
        >
          <Mail size={16} />
          Messages ({messages.length})
          {telegramPending && (
            <span className="social-pending" aria-label="Telegram pending">
              •
            </span>
          )}
        </button>
      </div>
      {(localError || error) && (
        <p className="inline-error" role="alert">
          {localError || error}
        </p>
      )}
      {!connected && (
        <p className="field-help">
          You are offline. Saved messages can still be exported or cleared;
          connect to use server actions.
        </p>
      )}
      {notice && (
        <p className="social-notice" role="status">
          {notice}
        </p>
      )}
      {tab === "contacts" ? (
        <section
          id="social-contacts"
          role="tabpanel"
          aria-labelledby="social-contacts-tab"
        >
          <form className="field-row social-add" onSubmit={addContact}>
            <label className="grow">
              Citizen name
              <input
                aria-label="Add contact by name"
                value={name}
                maxLength={64}
                disabled={disabled}
                onChange={(event) => setName(event.target.value)}
                placeholder="Who would you like to know?"
              />
            </label>
            <button
              type="submit"
              className="primary-button"
              disabled={disabled || !name.trim()}
            >
              <Plus size={16} />
              Add contact
            </button>
          </form>
          <div className="social-toolbar">
            <button
              className="subtle-button"
              disabled={disabled}
              onClick={() => void command({ type: "contacts-list" })}
            >
              <RefreshCw size={14} />
              Refresh contacts
            </button>
            <button
              className="subtle-button"
              disabled={disabled}
              onClick={() =>
                setPrivacy({
                  citizen: 0,
                  name: "Default contact privacy",
                  options: defaultOptions,
                })
              }
            >
              <Settings2 size={14} />
              Default privacy
            </button>
          </div>
          <div className="social-contact-list">
            {!contacts.length && (
              <p className="social-empty">
                No contacts loaded. Add someone by name or refresh your list.
              </p>
            )}
            {contacts.map((contact) => (
              <article className="social-contact" key={contact.citizen}>
                <span
                  className={`social-state social-state-${contact.state}`}
                  aria-hidden="true"
                />
                <div className="social-contact-name">
                  <strong>
                    {contact.name || `Citizen #${contact.citizen}`}
                  </strong>
                  <small>{contactPresence(contact)}</small>
                  <small>
                    Citizen #{contact.citizen} · Per-contact privacy
                  </small>
                </div>
                <button
                  className="icon-button"
                  title={`Message ${contact.name}`}
                  aria-label={`Message ${contact.name}`}
                  onClick={() => {
                    setRecipient(contact.name);
                    setTab("messages");
                  }}
                >
                  <Mail size={16} />
                </button>
                <button
                  className="icon-button"
                  title={`Privacy for ${contact.name}`}
                  aria-label={`Privacy for ${contact.name}`}
                  disabled={disabled}
                  onClick={() =>
                    setPrivacy({
                      citizen: contact.citizen,
                      name: contact.name,
                      options: contact.options,
                    })
                  }
                >
                  <Settings2 size={16} />
                </button>
                <button
                  className="icon-button"
                  title={`Remove ${contact.name}`}
                  aria-label={`Remove ${contact.name}`}
                  disabled={disabled}
                  onClick={() =>
                    setConfirmation({
                      operation: "remove",
                      citizen: contact.citizen,
                      name: contact.name,
                    })
                  }
                >
                  <UserMinus size={16} />
                </button>
              </article>
            ))}
          </div>
          {privacy && (
            <form
              className="social-privacy form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void command(
                  {
                    type: "contact-change",
                    citizen: privacy.citizen,
                    options: privacy.options,
                  },
                  () => {
                    setPrivacy(null);
                    setNotice("Privacy settings confirmed by the server.");
                  },
                );
              }}
            >
              <strong>{privacy.name}</strong>
              <p className="field-help">
                Per-contact settings replace the account defaults; a default
                contact-request block still applies. No flag means allowed
                unless a broad block applies. Unchanged privacy flags are
                preserved.
              </p>
              {(privacy.options &
                (CONTACT_OPTIONS.allAllowed | CONTACT_OPTIONS.allBlocked)) !==
                0 && (
                <p className="field-help">
                  This record has a broad allow/block override. That server flag
                  remains unchanged by the individual settings below.
                </p>
              )}
              {policies.map((policy) => (
                <label key={policy.label}>
                  {policy.label}
                  <select
                    aria-label={policy.label}
                    disabled={disabled}
                    value={
                      privacy.options & policy.block
                        ? "block"
                        : privacy.options & policy.allow
                          ? "allow"
                          : "default"
                    }
                    onChange={(event) => {
                      const selected = event.target.value;
                      setPrivacy((current) =>
                        current
                          ? {
                              ...current,
                              options:
                                (current.options &
                                  ~(policy.allow | policy.block)) |
                                (selected === "allow"
                                  ? policy.allow
                                  : selected === "block"
                                    ? policy.block
                                    : 0),
                            }
                          : null,
                      );
                    }}
                  >
                    <option value="default">No flag</option>
                    <option value="allow">Allow</option>
                    <option value="block">Block</option>
                  </select>
                </label>
              ))}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPrivacy(null)}
                >
                  Cancel privacy edit
                </button>
                <button className="primary-button" disabled={disabled}>
                  Apply privacy
                </button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <section
          id="social-messages"
          role="tabpanel"
          aria-labelledby="social-messages-tab"
        >
          <p className="field-help">
            Receiving removes one telegram from the server’s pending queue, then
            saves it on this device. If saving fails, keep Wayfarer open and
            export before closing. Telegrams are never fetched automatically.
          </p>
          <div className="social-toolbar">
            <button
              className="secondary-button"
              disabled={disabled || messageBlocked}
              onClick={() => void command({ type: "telegram-fetch" })}
            >
              <Mail size={15} />
              {telegramPending
                ? "Receive one telegram"
                : "Check for one telegram"}
            </button>
            <button
              className="subtle-button"
              disabled={!messages.length}
              onClick={exportMessages}
            >
              <Download size={15} />
              Export messages
            </button>
            {onClearInbox && (
              <button
                className="subtle-button"
                disabled={localDisabled || !messages.length}
                onClick={() => {
                  setClearing(true);
                  setExportAcknowledged(false);
                  setConfirmedIds(messages.map((entry) => entry.id));
                }}
              >
                Clear local inbox…
              </button>
            )}
          </div>
          {messageBlocked && (
            <p className="inline-error" role="alert">
              Receiving and sending are paused until your inbox can safely save
              messages. Export the messages already here; none will be removed
              automatically.
            </p>
          )}
          {clearing && (
            <div
              className="social-confirm"
              role="region"
              aria-label="Confirm inbox clearing"
            >
              <strong>Clear the messages on this device?</strong>
              <p>
                This removes the local inbox for this universe and citizen.
                Received telegrams have already left the server’s pending queue,
                so an exported file may be your only copy.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={exportAcknowledged}
                  disabled={localDisabled}
                  onChange={(event) =>
                    setExportAcknowledged(event.target.checked)
                  }
                />
                I exported messages I want to keep
              </label>
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  disabled={localDisabled}
                  onClick={() => setClearing(false)}
                >
                  Keep local inbox
                </button>
                <button
                  className="danger-button"
                  disabled={localDisabled || !exportAcknowledged}
                  onClick={() => void clearInbox()}
                >
                  Clear local inbox
                </button>
              </div>
            </div>
          )}
          <div
            className="social-message-list"
            aria-label="Saved and unsaved messages"
          >
            {!messages.length && (
              <p className="social-empty">
                Your local inbox is empty. Receiving is always your choice.
              </p>
            )}
            {[...messages].reverse().map((entry) => (
              <article
                className={`social-message social-message-${entry.direction}`}
                key={entry.id}
              >
                <div className="social-message-heading">
                  <strong>
                    {entry.direction === "incoming"
                      ? `From ${entry.from || "Unknown sender"}`
                      : `To ${entry.to}`}
                  </strong>
                  <span>
                    {entry.direction === "incoming" ? "Received" : "Submitted"}
                  </span>
                </div>
                <time dateTime={new Date(entry.time).toISOString()}>
                  {new Date(entry.time).toLocaleString()}
                </time>
                <p className="social-message-text">{entry.text}</p>
                {entry.contactRequest && entry.direction === "incoming" && (
                  <button
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() =>
                      setConfirmation({
                        operation: "confirm",
                        citizen: entry.contactRequest!.citizen,
                        name: entry.contactRequest!.name,
                      })
                    }
                  >
                    Review contact request
                  </button>
                )}
              </article>
            ))}
          </div>
          <form className="form-stack social-compose" onSubmit={sendTelegram}>
            <label>
              Recipient
              <input
                aria-label="Telegram recipient"
                value={recipient}
                maxLength={64}
                disabled={disabled}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="Citizen name"
              />
            </label>
            <label>
              Telegram
              <textarea
                aria-label="Telegram text"
                value={draft}
                maxLength={1000}
                disabled={disabled}
                onChange={(event) => setDraft(event.target.value)}
                rows={4}
                placeholder="Leave a little note…"
              />
            </label>
            <div className="social-toolbar">
              <small>
                {draft.length}/1000 characters · Submitted does not mean
                delivered.
              </small>
              <button
                className="primary-button"
                disabled={
                  disabled ||
                  messageBlocked ||
                  !recipient.trim() ||
                  !draft.trim()
                }
              >
                <Send size={15} />
                Submit telegram
              </button>
            </div>
          </form>
        </section>
      )}
      {confirmation && (
        <div
          className="social-confirm"
          role="region"
          aria-label="Confirm contact action"
        >
          <strong>
            {confirmation.operation === "remove"
              ? `Remove ${confirmation.name}?`
              : `Confirm contact ${confirmation.name}?`}
          </strong>
          <p>
            {confirmation.operation === "remove"
              ? "This changes your contact list on the universe server."
              : "Contact-request text can be forged. Check this citizen number and identity before granting contact access."}{" "}
            Citizen #{confirmation.citizen}.
          </p>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              disabled={disabled}
              onClick={() => setConfirmation(null)}
            >
              Cancel contact action
            </button>
            <button
              className={
                confirmation.operation === "remove"
                  ? "danger-button"
                  : "primary-button"
              }
              disabled={disabled}
              onClick={() =>
                void command(
                  confirmation.operation === "remove"
                    ? { type: "contact-delete", citizen: confirmation.citizen }
                    : {
                        type: "contact-confirm",
                        citizen: confirmation.citizen,
                      },
                  () => {
                    setConfirmation(null);
                    setNotice("Contact list updated.");
                  },
                )
              }
            >
              {confirmation.operation === "remove"
                ? "Remove contact"
                : "Confirm this citizen"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
