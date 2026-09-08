import { useEffect, useMemo, useRef, useState } from "react";
import { Hand, Play, Search, Square } from "lucide-react";
import {
  avatarAssetUrls,
  type AvatarDefinition,
} from "../engine/avatar-assets";
import { Modal } from "./Modal";
import "./gestures.css";

export function GestureDialog({
  avatar,
  studio,
  online,
  busy,
  active,
  onPlay,
  onStop,
  onClose,
}: {
  avatar: AvatarDefinition | null;
  studio: boolean;
  online: boolean;
  busy: boolean;
  active: boolean;
  onPlay: (gesture: number, showSelf: boolean) => Promise<boolean>;
  onStop: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(48);
  const [showSelf, setShowSelf] = useState(true);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [localBusy, setLocalBusy] = useState(false);
  const disabled = busy || localBusy || (!studio && !online);
  const choices = useMemo(
    () =>
      (avatar?.explicit || [])
        .map((gesture, ordinal) => {
          let valid = false;
          try {
            valid =
              ordinal < 255 &&
              gesture.sequence.trim().length > 0 &&
              !/\.(?:bvh|cav|cob|rwx|jpg|jpeg|png|gif)(?:\.zip)?$/i.test(
                gesture.sequence,
              ) &&
              avatarAssetUrls(
                "https://assets.invalid/",
                gesture.sequence,
                "sequence",
              ).length > 0;
          } catch {
            /* Show an unavailable entry without rewriting its catalog ordinal. */
          }
          return { ...gesture, index: ordinal + 1, valid };
        })
        .filter((gesture) =>
          `${gesture.name} ${gesture.group || ""}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()),
        ),
    [avatar, query],
  );
  async function play(index: number) {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setLocalBusy(true);
    setError("");
    try {
      if ((await onPlay(index, showSelf)) && mounted.current) onClose();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The gesture could not be started.",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  }
  return (
    <Modal
      title="Say it with a gesture."
      subtitle={
        avatar
          ? `${avatar.name} · ${studio ? "Original studio collection" : "This world’s avatar collection"}`
          : "Select an avatar with an available gesture catalog."
      }
      onClose={onClose}
    >
      {avatar && avatar.explicit.length > 0 ? (
        <>
          <label className="gesture-search">
            <Search size={16} />
            <input
              aria-label="Search gestures"
              placeholder="Find a gesture or group…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(48);
              }}
            />
            <span>{choices.length}</span>
          </label>
          <div className="gesture-list" aria-label="Available gestures">
            {choices.slice(0, limit).map((gesture) => (
              <button
                key={gesture.index}
                className="gesture-choice"
                disabled={disabled || !gesture.valid}
                onClick={() => void play(gesture.index)}
                title={
                  gesture.valid
                    ? `Play ${gesture.name}`
                    : "The catalog sequence name or gesture index is outside this client’s supported range."
                }
              >
                <span className="gesture-symbol">
                  <Hand size={20} />
                </span>
                <span>
                  <strong>{gesture.name}</strong>
                  <small>
                    {gesture.group || "Gesture"} · #{gesture.index}
                    {!gesture.valid && " · unavailable"}
                  </small>
                </span>
                <Play size={16} />
              </button>
            ))}
            {!choices.length && (
              <p className="sidebar-empty">No gestures match that search.</p>
            )}
          </div>
          {choices.length > limit && (
            <button
              className="secondary-button full-width"
              onClick={() => setLimit((value) => value + 48)}
            >
              Show more gestures
            </button>
          )}
          <label className="gesture-self">
            <input
              type="checkbox"
              checked={showSelf}
              onChange={(event) => setShowSelf(event.target.checked)}
              disabled={disabled}
            />
            Show me in third-person view
          </label>
          <p className="gesture-note">
            {studio
              ? "These original motions play locally. No server connection is made."
              : "Play submits avatar state, not a delivery receipt. Very short or quickly repeated gestures may not be seen by others."}{" "}
            Closing this panel does not stop an active gesture.
          </p>
        </>
      ) : (
        <div className="gesture-empty">
          <Hand size={32} />
          <h3>No gestures available</h3>
          <p>
            {avatar
              ? "This avatar has no explicit motions in its catalog."
              : "A missing world catalog cannot establish which gesture numbers are valid. Choose another avatar or try the original offline studio."}
          </p>
        </div>
      )}
      {!studio && !online && (
        <p className="form-error" role="status">
          Enter a world to play its gestures.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          className="secondary-button"
          disabled={!active || busy || localBusy}
          onClick={onStop}
        >
          <Square size={14} />
          Stop gesture
        </button>
        <button className="primary-button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
