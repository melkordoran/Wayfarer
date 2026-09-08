import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Box, Eye, History, Plus, Search, Star } from "lucide-react";
import type { WorldObject } from "../../shared/types";
import type { AssetFetcher } from "../engine/assets";
import {
  buildModelCatalog,
  loadModelLibrary,
  modelLibraryKey,
  normalizeModelRef,
  rememberModel,
  setModelFavorite,
  type ModelLibraryScope,
  type ModelLibraryState,
  type ModelReference,
} from "../model-library";
import { Modal } from "./Modal";
import { ModelPreview } from "./ModelPreview";
import "./model-browser.css";

export interface ModelBrowserDialogProps {
  studio: boolean;
  objects: WorldObject[];
  scope: ModelLibraryScope | null;
  objectPath: string;
  canBuild: boolean;
  pending: boolean;
  asset: AssetFetcher;
  onAdd: (model: string) => Promise<boolean>;
  onClose: () => void;
  onNotice?: (message: string) => void;
}

export function ModelBrowserDialog(props: ModelBrowserDialogProps) {
  const scopeKey = props.scope ? modelLibraryKey(props.scope) : null;
  const panelKey = JSON.stringify([
    props.studio,
    scopeKey?.ok ? scopeKey.value : "unscoped",
    props.objectPath,
  ]);
  return <ModelBrowserPanel key={panelKey} {...props} />;
}

function ModelBrowserPanel({
  studio,
  objects,
  scope,
  objectPath,
  canBuild,
  pending,
  asset,
  onAdd,
  onClose,
  onNotice,
}: ModelBrowserDialogProps) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const catalog = useMemo(
    () => buildModelCatalog(objects, { includeBuiltins: studio }),
    [objects, studio],
  );
  const [loaded] = useState(() => (scope ? loadModelLibrary(scope) : null));
  const [library, setLibrary] = useState<ModelLibraryState>(
    loaded?.ok ? loaded.value : { favorites: [], recent: [] },
  );
  const [storageError, setStorageError] = useState(
    loaded && !loaded.ok ? loaded.error.message : "",
  );
  const [tab, setTab] = useState<"loaded" | "favorites" | "recent">("loaded");
  const [query, setQuery] = useState("");
  const [model, setModel] = useState(
    studio ? "wayfarer:cube" : catalog.items[0]?.model || "",
  );
  const [preview, setPreview] = useState<{
    model: string;
    request: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const running = useRef(false);
  const normalized = normalizeModelRef(model);
  const usable =
    normalized.ok && (studio || normalized.value.kind !== "builtin");
  const disabled = pending || working;
  const favorite =
    normalized.ok && library.favorites.includes(normalized.value.model);
  const candidates: Array<ModelReference & { usage: number }> =
    tab === "loaded"
      ? catalog.items
      : library[tab].flatMap((name) => {
          const ref = normalizeModelRef(name);
          return ref.ok
            ? [
                {
                  ...ref.value,
                  usage:
                    catalog.items.find((item) => item.model === ref.value.model)
                      ?.usage || 0,
                },
              ]
            : [];
        });
  const shown = candidates.filter((item) =>
    `${item.model} ${item.displayName}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  function select(name: string) {
    setModel(name);
    setError("");
  }
  function toggleFavorite() {
    if (!scope || !usable || !normalized.ok) return;
    const saved = setModelFavorite(scope, normalized.value.model, !favorite);
    if (saved.ok) {
      setLibrary(saved.value);
      setStorageError("");
    } else setStorageError(saved.error.message);
  }
  function showPreview() {
    if (!usable || !normalized.ok) {
      setError("Choose a supported model name before previewing.");
      return;
    }
    setError("");
    setPreview((old) => ({
      model: normalized.value.model,
      request: (old?.request || 0) + 1,
    }));
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (disabled || running.current || !canBuild || !usable || !normalized.ok)
      return;
    running.current = true;
    setWorking(true);
    setError("");
    try {
      const accepted = await onAdd(normalized.value.model);
      if (!mounted.current) return;
      if (accepted !== true) {
        setError(
          "The object was not fully accepted. Review the world activity before trying again.",
        );
        return;
      }
      if (scope) {
        const saved = rememberModel(scope, normalized.value.model);
        if (saved.ok) setLibrary(saved.value);
        else {
          setStorageError(saved.error.message);
          onNotice?.(`Object added. ${saved.error.message}`);
        }
      }
      onClose();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The object could not be added.",
        );
    } finally {
      running.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  const close = () => {
    if (!disabled && !running.current) onClose();
  };
  return (
    <Modal
      title="Find your next piece."
      subtitle={
        studio
          ? "Original building pieces and the models used in your studio."
          : "Models discovered in the loaded part of this world. This is not a server directory listing."
      }
      onClose={close}
      wide
    >
      <div className="model-browser">
        <section className="model-library-panel" aria-label="Model library">
          <div className="model-search">
            <Search size={15} />
            <input
              aria-label="Search models"
              placeholder="Search pieces…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="model-tabs" role="tablist" aria-label="Model lists">
            {(
              [
                ["loaded", Box, studio ? "Original & used" : "In this world"],
                ["favorites", Star, "Favorites"],
                ["recent", History, "Recent"],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                aria-controls="model-results"
                id={`model-tab-${value}`}
                onClick={() => setTab(value)}
                title={label}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div
            className="model-results"
            id="model-results"
            role="tabpanel"
            aria-labelledby={`model-tab-${tab}`}
          >
            {!shown.length && (
              <div className="model-empty">
                <Box size={27} strokeWidth={1} />
                <p>
                  {query
                    ? "No matching models."
                    : tab === "favorites"
                      ? "Star a model to keep it here."
                      : tab === "recent"
                        ? "Models you successfully add will appear here."
                        : "No model references are loaded yet. Enter a model name to get started."}
                </p>
              </div>
            )}
            {shown.map((item) => (
              <button
                type="button"
                key={item.model}
                className={`model-result ${normalized.ok && normalized.value.model === item.model ? "selected" : ""}`}
                aria-pressed={
                  normalized.ok && normalized.value.model === item.model
                }
                onClick={() => select(item.model)}
              >
                <span className="model-result-icon">
                  <Box size={23} strokeWidth={1.2} />
                </span>
                <span className="model-result-name">
                  <strong>{item.displayName}</strong>
                  <small>{item.model}</small>
                </span>
                <span className="model-result-meta">
                  {library.favorites.includes(item.model) && (
                    <Star size={11} fill="currentColor" />
                  )}
                  <small>
                    {item.usage
                      ? `${item.usage} used`
                      : item.kind === "builtin"
                        ? "Original"
                        : "Saved"}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <p className="model-library-count">
            {shown.length} {shown.length === 1 ? "model" : "models"}
            {catalog.truncated ? " · Catalog limited to 500 references" : ""}
            {catalog.ignored
              ? ` · ${catalog.ignored} unsafe references omitted`
              : ""}
          </p>
        </section>
        <section className="model-detail" aria-label="Choose a model">
          {preview ? (
            <ModelPreview
              requestId={preview.request}
              model={preview.model}
              objectPath={objectPath}
              asset={asset}
            />
          ) : (
            <div className="model-preview model-preview-empty">
              <Box size={48} strokeWidth={1} />
              <p>A closer look before you build.</p>
              <small>Preview loads the real model and materials.</small>
            </div>
          )}
          {preview &&
            normalized.ok &&
            normalized.value.model !== preview.model && (
              <p className="field-help">
                Preview shows {preview.model}. Preview the newly selected model
                to update it.
              </p>
            )}
          <form className="form-stack" onSubmit={(event) => void add(event)}>
            <label>
              Model name
              <input
                required
                aria-label="Model name"
                maxLength={255}
                value={model}
                disabled={disabled}
                onChange={(event) => select(event.target.value)}
                placeholder={
                  studio ? "wayfarer:cube" : "object.rwx or object.x"
                }
                spellCheck={false}
              />
            </label>
            <div className="model-detail-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={!usable || disabled}
                onClick={showPreview}
              >
                <Eye size={15} />
                Preview model
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-label={
                  favorite
                    ? "Remove model from favorites"
                    : "Add model to favorites"
                }
                disabled={!scope || !usable || disabled}
                aria-pressed={favorite}
                onClick={toggleFavorite}
              >
                <Star size={15} fill={favorite ? "currentColor" : "none"} />
                {favorite ? "Saved" : "Favorite"}
              </button>
            </div>
            {model && !usable && (
              <p className="inline-error" role="alert">
                {normalized.ok
                  ? "Original studio models cannot be submitted to a remote world."
                  : normalized.error.message}
              </p>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {storageError && (
              <p className="field-help model-storage-error" role="status">
                {storageError} Browsing and adding remain available.
              </p>
            )}
            <p className="form-note">
              The object appears a few metres in front of you. Refine its
              position with the inspector or 3D building tools. Preview does not
              execute object actions.
            </p>
            {!canBuild && (
              <p className="inline-error">
                Connect to a build-enabled world to add objects.
              </p>
            )}
            <button
              className="primary-button full-width"
              disabled={disabled || !canBuild || !usable}
            >
              <Plus size={16} />
              {disabled ? "Adding…" : "Add to world"}
            </button>
          </form>
        </section>
      </div>
    </Modal>
  );
}
