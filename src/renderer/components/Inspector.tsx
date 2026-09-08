import { useEffect, useRef, useState } from "react";
import { Box, Check, Copy, RotateCw, Trash2, X } from "lucide-react";
import type { WorldObject } from "../../shared/types";
import { sameBuildObject } from "../build-history";

const numericKeys = ["x", "y", "z", "pitch", "yaw", "roll"] as const;
type NumericKey = typeof numericKeys[number];
type NumericText = Partial<Record<NumericKey, string>>;
const rotationKey = (key: NumericKey) => key === "pitch" || key === "yaw" || key === "roll";
const displayedNumber = (object: WorldObject, key: NumericKey) => String(rotationKey(key) ? Math.round(object[key] * 180 / Math.PI * 100) / 100 : object[key]);
function parsedNumber(text: string, key: NumericKey): number | undefined {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return;
  const value = Number(text), limit = rotationKey(key) ? 214748364.7 : 21474836.47;
  if (Number.isFinite(value) && Math.abs(value) <= limit) return rotationKey(key) ? value * Math.PI / 180 : value;
}
const textChanged = (text: NumericText, object: WorldObject | null) => numericKeys.some(key => text[key] !== undefined && (!object || text[key] !== displayedNumber(object, key)));
const invalidNumbers = (text: NumericText) => numericKeys.some(key => text[key] !== undefined && parsedNumber(text[key]!, key) === undefined);

export function Inspector({
  object,
  canBuild,
  pending,
  onSave,
  onDelete,
  onDuplicate,
  onClose,
  onDirtyChange,
  unavailableReason,
}: {
  object: WorldObject | null;
  canBuild: boolean;
  pending: boolean;
  onSave: (object: WorldObject) => void | Promise<boolean | void>;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  unavailableReason?: string;
}) {
  const [draft, setDraft] = useState<WorldObject | null>(object);
  // A numeric value cannot represent intermediate typing such as '-' or '.'.
  // Keep exact text separately; only complete finite values enter the object.
  const [numericText, setNumericText] = useState<NumericText>({});
  const numericTextRef = useRef(numericText);
  numericTextRef.current = numericText;
  const baseline = useRef<WorldObject | null>(object);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const objectRef = useRef(object);
  objectRef.current = object;
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const [tab, setTab] = useState<"object" | "actions">("object");
  useEffect(() => {
    const dirty = !sameBuildObject(draftRef.current, baseline.current) || textChanged(numericTextRef.current, baseline.current);
    if (!object && baseline.current && dirty) {
      setConflict(true);
      return;
    }
    if (
      object?.id !== baseline.current?.id ||
      !dirty ||
      (!invalidNumbers(numericTextRef.current) && sameBuildObject(object, draftRef.current) && !sameBuildObject(object, baseline.current))
    ) {
      baseline.current = object;
      setDraft(object ? { ...object } : null);
      setNumericText({});
      setConflict(false);
    } else setConflict(!sameBuildObject(object, baseline.current));
  }, [object]);
  const changed = !sameBuildObject(draft, object);
  const dirty = !sameBuildObject(draft, baseline.current) || textChanged(numericText, baseline.current);
  const invalidNumeric = invalidNumbers(numericText);
  const busy = pending || saving;
  const disabled = !canBuild || busy || !object;
  const copyable = Boolean(unavailableReason) && dirty && !busy;
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(
    () => () => {
      dirtyCallback.current?.(false);
    },
    [],
  );
  useEffect(() => {
    if (!dirty && !busy) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);
  function discard() {
    baseline.current = object;
    setDraft(object ? { ...object } : null);
    setNumericText({});
    setConflict(false);
    setSaveError("");
  }
  async function submit() {
    if (!draft || !changed || disabled || conflict || invalidNumeric) return;
    setSaving(true);
    setSaveError("");
    try {
      const accepted = await onSave({ ...draft });
      // Only an explicit accepted result can replace a submitted draft with the
      // server's quantized transform. A rejection leaves its text recoverable.
      if (accepted === true && objectRef.current?.id === draft.id) {
        baseline.current = objectRef.current;
        setDraft({ ...objectRef.current });
        setNumericText({});
        setConflict(false);
      }
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "The object could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  function field(key: keyof WorldObject, value: string | number) {
    if (disabled) return;
    setDraft((o) => (o ? { ...o, [key]: value } : o));
  }
  function numericField(key: NumericKey, text: string) {
    if (disabled) return;
    setNumericText(old => ({ ...old, [key]: text }));
    const value = parsedNumber(text, key);
    if (value !== undefined) field(key, value);
  }
  return (
    <aside className="inspector">
      <div className="panel-heading">
        <span>
          <Box size={16} /> Object inspector
        </span>
        <button
          className="icon-button"
          title="Close inspector"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {!draft ? (
        <div className="inspector-empty">
          <div className="empty-icon">
            <Box size={31} strokeWidth={1} />
          </div>
          <h3>Make something yours.</h3>
          <p>
            Click an object in the world to inspect it, or add a new piece from
            the build palette.
          </p>
          <div className="key-hint">
            <kbd>B</kbd> Toggle building
          </div>
        </div>
      ) : (
        <>
          <div className="object-preview">
            <Box size={50} strokeWidth={1} />
            <span>
              {draft.model.replace(/\.rwx$/i, "").replace("wayfarer:", "")}
            </span>
            <small>
              OBJECT #{draft.id} · OWNER #{draft.owner}
            </small>
          </div>
          <div className="panel-tabs">
            <button
              className={tab === "object" ? "active" : ""}
              onClick={() => setTab("object")}
            >
              Properties
            </button>
            <button
              className={tab === "actions" ? "active" : ""}
              onClick={() => setTab("actions")}
            >
              Actions
            </button>
          </div>
          <form
            className="inspector-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {conflict && (
              <div className="edit-conflict" role="alert">
                <p>
                  {unavailableReason || (object
                    ? "This object changed on the server. Your unsaved edits are still here."
                    : "This object is no longer available. Your unsaved edits are still here; copy them before discarding.")}
                </p>
                <div>
                  <button type="button" disabled={busy} onClick={discard}>
                    Reload object
                  </button>
                  <button
                    type="button"
                    disabled={busy || !object}
                    onClick={() => {
                      if (!object || !draft || !baseline.current) return;
                      const edits = Object.fromEntries(
                        Object.entries(draft).filter(
                          ([key, value]) =>
                            value !==
                            baseline.current![key as keyof WorldObject],
                        ),
                      );
                      // A partial numeric draft is an edit even when its last
                      // complete numeric value still equals the old baseline.
                      const retainedText: NumericText = {};
                      for (const key of numericKeys) if (numericText[key] !== undefined && numericText[key] !== displayedNumber(baseline.current, key)) {
                        edits[key] = draft[key]; retainedText[key] = numericText[key];
                      }
                      setDraft({ ...object, ...edits });
                      setNumericText(retainedText);
                      baseline.current = object;
                      setConflict(false);
                    }}
                  >
                    Keep my edits
                  </button>
                </div>
              </div>
            )}
            {tab === "object" ? (
              <>
                <label>
                  Model
                  <input
                    value={draft.model}
                    maxLength={255}
                    disabled={disabled && !copyable}
                    readOnly={copyable}
                    onChange={(e) => field("model", e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label>
                  Description
                  <textarea
                    rows={3}
                    value={draft.description}
                    disabled={disabled && !copyable}
                    readOnly={copyable}
                    onChange={(e) => field("description", e.target.value)}
                    placeholder="Give this object a little context…"
                  />
                </label>
                <div className="field-label">
                  Position <span>METRES</span>
                </div>
                <div className="vector-fields">
                  {(["x", "y", "z"] as const).map((key) => (
                    <label key={key}>
                      <span className={`axis-${key}`}>{key.toUpperCase()}</span>
                      <input
                        aria-label={`Position ${key.toUpperCase()}`}
                        type="text"
                        inputMode="decimal"
                        value={numericText[key] ?? displayedNumber(draft, key)}
                        aria-invalid={numericText[key] !== undefined && parsedNumber(numericText[key]!, key) === undefined}
                        disabled={disabled && !copyable}
                        readOnly={copyable}
                        onChange={(e) => numericField(key, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <div className="field-label">
                  Rotation <span>DEGREES</span>
                </div>
                <div className="vector-fields">
                  {(["pitch", "yaw", "roll"] as const).map((key, i) => (
                    <label key={key}>
                      <span>{["X", "Y", "Z"][i]}</span>
                      <input
                        aria-label={`Rotation ${key}`}
                        type="text"
                        inputMode="decimal"
                        value={numericText[key] ?? displayedNumber(draft, key)}
                        aria-invalid={numericText[key] !== undefined && parsedNumber(numericText[key]!, key) === undefined}
                        disabled={disabled && !copyable}
                        readOnly={copyable}
                        onChange={(e) =>
                          numericField(key, e.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="subtle-button"
                  disabled={disabled}
                  onClick={() => {
                    setNumericText(old => { const next = { ...old }; delete next.pitch; delete next.yaw; delete next.roll; return next; });
                    field("pitch", 0);
                    field("yaw", 0);
                    field("roll", 0);
                  }}
                >
                  <RotateCw size={14} /> Reset rotation
                </button>
              </>
            ) : (
              <>
                <label>
                  Action script
                  <textarea
                    className="code-input"
                    rows={10}
                    value={draft.action}
                    disabled={disabled && !copyable}
                    readOnly={copyable}
                    onChange={(e) => field("action", e.target.value)}
                    placeholder="create color #e8b98a;"
                    spellCheck={false}
                  />
                </label>
                <p className="field-help">
                  Selected create, activate and bump commands are supported.
                  Unsupported lock conditions stop later navigation commands.
                </p>
                <div className="action-example">
                  <span>TRY THIS</span>
                  <code>create color #d9ae79;</code>
                </div>
              </>
            )}
            {!canBuild && !unavailableReason && (
              <p className="field-help">
                Building is disabled in this world. Your changes must also be
                accepted by the server.
              </p>
            )}
            {saveError && (
              <p className="form-error" role="alert">
                {saveError}
              </p>
            )}
            {invalidNumeric && <p className="form-error" role="alert">Enter complete finite positions and rotations within the supported world bounds before applying.</p>}
            {dirty && (
              <p className="field-help">
                These edits have not been applied. Saving or exporting your
                project does not include this draft.
              </p>
            )}
            <button
              className="primary-button full-width"
              disabled={disabled || !changed || conflict || invalidNumeric}
            >
              <Check size={15} />
              {busy ? "Saving…" : "Apply changes"}
            </button>
            {dirty && (
              <button
                type="button"
                className="subtle-button full-width"
                disabled={busy}
                onClick={discard}
              >
                Discard edits
              </button>
            )}
            <div className="object-actions">
              <button
                type="button"
                className="subtle-button"
                disabled={disabled || dirty}
                onClick={onDuplicate}
              >
                <Copy size={14} />
                Duplicate
              </button>
              <button
                type="button"
                className="subtle-button danger"
                disabled={disabled || dirty}
                onClick={onDelete}
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
