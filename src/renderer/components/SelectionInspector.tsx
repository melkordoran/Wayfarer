import { useEffect, useRef, useState } from "react";
import { Box, Copy, Move3D, Trash2, X } from "lucide-react";
import type { WorldObject } from "../../shared/types";
import { transformSelection } from "../build-history";

const emptyOffset = () => ({ x: "0", y: "0", z: "0", yaw: "0" });
const parseOffset = (text: string) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : undefined;
const invalidOffset = (key: string, text: string) => {
  const number = parseOffset(text);
  return number === undefined || Math.abs(number) > (key === "yaw" ? 214748364.7 : 21474836.47);
};

export function SelectionInspector({
  objects,
  pending,
  canBuild,
  onSave,
  onDuplicate,
  onDelete,
  onClose,
  onDirtyChange,
  unavailableReason,
}: {
  objects: WorldObject[];
  pending: boolean;
  canBuild: boolean;
  onSave: (objects: WorldObject[]) => Promise<boolean>;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  unavailableReason?: string;
}) {
  // Preserve '-' / '.' and precision while typing; never coerce empty text to 0.
  const [offset, setOffset] = useState(emptyOffset);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const dirty = Object.values(offset).some(value => value !== "0");
  const invalidNumeric = Object.entries(offset).some(([key, value]) => invalidOffset(key, value));
  const changed = Object.values(offset).some(value => parseOffset(value) !== 0);
  const busy = pending || applying;
  const disabled = !canBuild || busy || !objects.length;
  const copyable = Boolean(unavailableReason) && dirty && !busy;
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
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
  async function submit() {
    if (disabled || !changed || needsReview || invalidNumeric) return;
    setApplying(true);
    setError("");
    try {
      const result = transformSelection(objects, {
        x: Number(offset.x), y: Number(offset.y), z: Number(offset.z),
        yaw: (Number(offset.yaw) * Math.PI) / 180,
      });
      if (await onSave(result)) setOffset(emptyOffset());
      else setNeedsReview(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid transform.");
      setNeedsReview(true);
    } finally {
      setApplying(false);
    }
  }
  function discard() {
    setOffset(emptyOffset());
    setError("");
    setNeedsReview(false);
  }
  return (
    <aside className="inspector selection-inspector">
      <div className="panel-heading">
        <span>
          <Box size={16} /> {objects.length} objects selected
        </span>
        <button
          className="icon-button"
          title="Close inspector"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="selection-summary">
        <Move3D size={36} strokeWidth={1} />
        <h3>Better together.</h3>
        <p>
          Shift-click to add or remove an object. Transforms apply to the whole
          selection.
        </p>
      </div>
      <form
        className="inspector-fields"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {unavailableReason && <p className="edit-conflict" role="alert">{unavailableReason}</p>}
        <div className="field-label">
          Move selection <span>METRES · RELATIVE</span>
        </div>
        <div className="vector-fields">
          {(["x", "y", "z"] as const).map((key) => (
            <label key={key}>
              <span className={`axis-${key}`}>{key.toUpperCase()}</span>
              <input
                aria-label={`Move selection ${key.toUpperCase()}`}
                type="text"
                inputMode="decimal"
                value={offset[key]}
                aria-invalid={invalidOffset(key, offset[key])}
                disabled={disabled && !copyable}
                readOnly={copyable}
                onChange={(e) =>
                  !disabled && setOffset((old) => ({
                    ...old,
                    [key]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
        <label>
          Rotate around selection centre
          <input
            aria-label="Rotate selection"
            type="text"
            inputMode="decimal"
            value={offset.yaw}
            aria-invalid={invalidOffset("yaw", offset.yaw)}
            disabled={disabled && !copyable}
            readOnly={copyable}
            onChange={(e) =>
              !disabled && setOffset((old) => ({ ...old, yaw: e.target.value }))
            }
          />
        </label>
        <p className="field-help">
          Rotation is in degrees around the vertical axis. Each object keeps its
          model, actions and relative placement.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {invalidNumeric && <p className="form-error" role="alert">Enter complete finite offsets and rotation within the supported world bounds before applying.</p>}
        {needsReview && (
          <div className="edit-conflict" role="alert">
            <p>
              Some changes may already be applied. Review or undo accepted
              changes before applying again. Discard this transform first if you
              need to use Undo.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => setNeedsReview(false)}
            >
              I reviewed the selection; allow retry
            </button>
          </div>
        )}
        {dirty && (
          <p className="field-help">
            This transform has not been fully applied. Project saves do not
            include these draft offsets.
          </p>
        )}
        <button
          className="primary-button full-width"
          disabled={disabled || !changed || needsReview || invalidNumeric}
        >
          <Move3D size={15} />
          {busy ? "Applying…" : "Apply to selection"}
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
            Duplicate all
          </button>
          <button
            type="button"
            className="subtle-button danger"
            disabled={disabled || dirty}
            onClick={onDelete}
          >
            <Trash2 size={14} />
            Delete all
          </button>
        </div>
        <p className="field-help">
          Server changes are submitted one object at a time. If one is rejected,
          accepted changes remain undoable.
        </p>
      </form>
      <ul className="selection-list" aria-label="Selected objects">
        {objects.map((object) => (
          <li key={object.id}>
            <Box size={12} />
            <span>{object.model}</span>
            <small>#{object.id}</small>
          </li>
        ))}
      </ul>
    </aside>
  );
}
