import { useState, type FormEvent } from "react";
import { ArrowRight, Globe, LoaderCircle, ShieldCheck } from "lucide-react";
import type { ConnectionOptions } from "../../shared/types";
import { savedConnection, rememberConnection } from "../storage";
import { Modal } from "./Modal";

export function ConnectDialog({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (options: ConnectionOptions) => Promise<void>;
}) {
  const [options, setOptions] = useState(savedConnection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = <K extends keyof ConnectionOptions>(
    key: K,
    value: ConnectionOptions[K],
  ) => setOptions((o) => ({ ...o, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onConnect(options);
      rememberConnection(options);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to connect.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="A world is waiting."
      subtitle="Connect to your Axis universe and make yourself at home."
      onClose={onClose}
    >
      <div className="connection-illustration">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <Globe size={48} strokeWidth={1} />
        <span>YOUR UNIVERSE. YOUR WAY.</span>
      </div>
      <form onSubmit={submit} className="form-stack">
        <div className="field-row">
          <label className="grow">
            Universe address
            <input
              required
              value={options.host}
              onChange={(e) => field("host", e.target.value.trim())}
              placeholder="universe.example.com"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="port-field">
            Port
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={options.port}
              onChange={(e) => field("port", Number(e.target.value))}
            />
          </label>
        </div>
        <div className="segment-control">
          <button
            type="button"
            className={!options.tourist ? "active" : ""}
            onClick={() => field("tourist", false)}
          >
            Citizen
          </button>
          <button
            type="button"
            className={options.tourist ? "active" : ""}
            onClick={() => field("tourist", true)}
          >
            Tourist
          </button>
        </div>
        <label>
          {options.tourist ? "Nickname" : "Citizen name"}
          <input
            required
            maxLength={64}
            autoComplete="username"
            aria-label={options.tourist ? "Nickname" : "Citizen name"}
            value={options.username}
            onChange={(e) => field("username", e.target.value)}
          />
        </label>
        {!options.tourist && (
          <label>
            Password
            <input
              type="password"
              aria-label="Password"
              autoComplete="current-password"
              maxLength={256}
              value={options.password}
              onChange={(e) => field("password", e.target.value)}
            />
          </label>
        )}
        {options.tourist && (
          <label>
            Email address
            <input
              required
              type="email"
              aria-label="Email address"
              autoComplete="email"
              minLength={8}
              maxLength={50}
              value={options.email || ""}
              onChange={(e) => field("email", e.target.value)}
            />
            <span className="form-note">
              Required by Axis and sent to your universe server.
            </span>
          </label>
        )}
        <label>
          Starting world <span className="optional">optional</span>
          <input
            value={options.world || ""}
            maxLength={64}
            onChange={(e) => field("world", e.target.value)}
            placeholder="Choose after signing in"
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={options.tls}
            onChange={(e) => field("tls", e.target.checked)}
          />
          <ShieldCheck size={16} /> Use TLS (requires a trusted server
          certificate)
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button full-width" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={17} /> Connecting…
            </>
          ) : (
            <>
              Enter universe <ArrowRight size={17} />
            </>
          )}
        </button>
        <p className="form-note">
          Passwords are never saved. Non-TLS connections use the server’s legacy
          transport and should stay on trusted networks.
        </p>
      </form>
    </Modal>
  );
}
