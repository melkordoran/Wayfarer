import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, Users } from "lucide-react";
import type { AvatarCatalog } from "../engine/avatar-assets";
import type { AvatarAssetState } from "../engine";
import { Modal } from "./Modal";

const colors = [
  "#dba969",
  "#669c9e",
  "#b290c2",
  "#8eae72",
  "#d47f75",
  "#7c9ac7",
];
export function AvatarDialog({
  catalog,
  studio = false,
  current,
  assetState,
  onSelect,
  onClose,
}: {
  catalog: AvatarCatalog | null;
  studio?: boolean;
  current: number;
  assetState?: AvatarAssetState | null;
  onSelect: (index: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(36);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function choose(index: number) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await onSelect(index);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The avatar could not be selected.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  const hasCatalog = !!catalog?.entries.some((entry) => entry.geometry);
  const currentAsset =
    assetState?.local && assetState.type === current ? assetState : null;
  const entries = useMemo(
    () =>
      catalog?.entries.filter(
        (entry) =>
          entry.geometry &&
          entry.name.toLowerCase().includes(query.toLowerCase()),
      ) || [],
    [catalog, query],
  );
  return (
    <Modal
      title="Hello, you."
      subtitle={
        hasCatalog
          ? studio
            ? "Choose from the original studio avatar collection."
            : "Choose from this world’s own avatar collection."
          : "Choose an original fallback while no world catalog is available."
      }
      onClose={onClose}
      wide={hasCatalog}
    >
      {hasCatalog && (
        <label className="avatar-search">
          <Search size={16} />
          <input
            aria-label="Search avatars"
            placeholder="Find your look…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(36);
            }}
          />
          <span>{entries.length} avatars</span>
        </label>
      )}
      <div className={`avatar-grid ${hasCatalog ? "catalog-grid" : ""}`}>
        {(hasCatalog
          ? entries.slice(0, limit)
          : colors.map((_, index) => ({
              index,
              name: `Wayfarer ${index + 1}`,
              geometry: undefined,
            }))
        ).map((entry) => (
          <button
            key={entry.index}
            className={current === entry.index ? "selected" : ""}
            onClick={() => void choose(entry.index)}
            disabled={pending}
            aria-pressed={current === entry.index}
            title={`Choose ${entry.name}, avatar ${entry.index}`}
          >
            <div
              className="avatar-silhouette"
              style={{ color: colors[entry.index % colors.length] }}
            >
              <i />
              <span />
            </div>
            <strong>{entry.name}</strong>
            <small>
              #{entry.index} ·{" "}
              {entry.geometry
                ? /\.x$/i.test(entry.geometry)
                  ? "DirectX · experimental"
                  : /\.(cob|cav)$/i.test(entry.geometry)
                    ? "Fallback preview"
                    : "RWX / automatic"
                : "Original"}
            </small>
            {current === entry.index && <Check size={14} />}
          </button>
        ))}
      </div>
      {hasCatalog && !entries.length && (
        <p className="sidebar-empty">No avatars match that name.</p>
      )}
      {hasCatalog && entries.length > limit && (
        <button
          className="secondary-button full-width"
          onClick={() => setLimit((n) => n + 36)}
        >
          Show more avatars
        </button>
      )}
      <p className="avatar-catalog-note">
        <Users size={17} />
        <span>
          Cards use symbolic silhouettes. Switch to third-person view to see
          your selected avatar in the world. Unsupported geometry uses an
          original fallback.
        </span>
      </p>
      {currentAsset && (
        <section
          className="avatar-asset-status"
          aria-label="Selected avatar rendering"
          aria-live="polite"
        >
          <strong>
            {currentAsset.status === "loading"
              ? "Loading your avatar…"
              : currentAsset.status === "fallback"
                ? "Original fallback in use"
                : `${currentAsset.format === "x" ? "DirectX" : "RWX"} avatar loaded`}
          </strong>
          {currentAsset.message && <p>{currentAsset.message.slice(0, 500)}</p>}
          {!!currentAsset.warnings.length && (
            <details>
              <summary>
                Compatibility notes ({currentAsset.warnings.length})
              </summary>
              <ul>
                {currentAsset.warnings.slice(0, 12).map((warning, index) => (
                  <li key={index}>{warning.slice(0, 500)}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button full-width" onClick={onClose}>
        That’s me <Check size={16} />
      </button>
    </Modal>
  );
}
