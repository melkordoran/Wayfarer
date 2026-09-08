import { Droplets, Globe, Info, Layers, Sun } from "lucide-react";
import type { ReactNode } from "react";
import type { WorldSettings } from "../../shared/types";
import { localTeleportAllowed } from "../../shared/navigation";
import { coordinates } from "../storage";
import { Modal } from "./Modal";
import "./world-details.css";

export function displayObjectPath(value: string): string {
  if (!value) return "Not provided";
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "Unsupported object-path scheme";
    const privateParts = !!(url.username || url.password || url.search || url.hash);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return `${url.href}${privateParts ? " (credentials and parameters hidden)" : ""}`;
  } catch { return "Invalid object path"; }
}
function yesNo(value: unknown): string { return value === true ? "Yes" : value === false ? "No" : "Not provided"; }
function displayAssetName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "None";
  // Legacy attributes name object-path files, not arbitrary URLs. Never expose
  // credentials/tokens accidentally supplied in an unsupported reference.
  return value.length <= 255 && !/[\x00-\x1f\x7f:/\\?#@%]/.test(value)
    ? value : "Unsupported asset reference";
}
function number(value: unknown, unit = ""): string { return typeof value === "number" && Number.isFinite(value) ? `${Number(value.toFixed(3))}${unit}` : "Not provided"; }
function Color({ value }: { value: string }) {
  return <span className="world-color"><i style={{ backgroundColor: /^#[\da-f]{6}$/i.test(value) ? value : "transparent" }} />{value}</span>;
}
function Row({ title, children }: { title: string; children: ReactNode }) { return <div><dt>{title}</dt><dd>{children}</dd></div>; }
export function WorldDetailsDialog({ settings, studio, online = true, environmentMode, onFollowWorld, onClose, onEdit }: {
  settings: WorldSettings | null;
  studio: boolean;
  online?: boolean;
  environmentMode: "world" | "day" | "sunset" | "night";
  onFollowWorld: () => void;
  onClose: () => void;
  onEdit?: () => void;
}) {
  if (!settings) return <Modal title="World details" subtitle="Enter a world to read its environment and capabilities." onClose={onClose}><p className="dialog-copy">No world attributes are available yet.</p></Modal>;
  const direction = settings.lightDirection as { x: number; y: number; z: number } | undefined;
  const warnings = Array.isArray(settings.environmentWarnings) ? settings.environmentWarnings.filter((value): value is string => typeof value === "string") : [];
  return <Modal title={settings.title || settings.name} subtitle={studio ? "Original offline studio · local environment" : online ? `${settings.name} · server-provided environment and capabilities` : `${settings.name} · last received attributes · not connected`} onClose={onClose} wide>
    <div className={`environment-source ${!studio && environmentMode !== "world" ? "environment-overridden" : ""}`}><Globe size={20} /><span><strong>{studio ? "Your local studio look" : environmentMode === "world" ? "Following world lighting" : "Local lighting override active"}</strong><small>{studio ? "These settings belong to this original offline scene." : "This panel is read-only. Local display choices never change server attributes."}</small></span>{!studio && environmentMode !== "world" && <button className="secondary-button" onClick={onFollowWorld}>Follow world</button>}</div>
    {settings.welcome && <p className="world-welcome">{settings.welcome.slice(0, 4096)}{settings.welcome.length > 4096 && "…"}</p>}
    <div className="world-details-grid">
      <section><h3><Info size={16} />World & access</h3><dl>
        <Row title="World">{settings.name}</Row><Row title="Entrance">{coordinates(settings.entry)}</Row>
        <Row title="Build capability">{yesNo(settings.canBuild)}</Row><Row title="Speak capability">{yesNo(settings.canSpeak)}</Row><Row title="Caretaker">{yesNo(settings.caretaker)}</Row><Row title="Owner">{yesNo(settings.owner)}</Row><Row title="World flying rule">{yesNo(settings.allowFlying)}</Row><Row title="You can fly">{yesNo(settings.canFly)}</Row>
        <Row title="World teleport rule">{yesNo(settings.allowTeleport)}</Row><Row title="You can teleport">{yesNo(localTeleportAllowed(settings))}</Row>
        <Row title="Terrain editing">{yesNo(settings.canEditTerrain)}</Row>
      </dl><p className="world-details-note">Teleport permission here applies to local manual travel. Object teleports and travel to another world remain available.</p></section>
      <section><h3><Sun size={16} />Lighting & fog</h3><dl>
        <Row title="Ambient"><Color value={settings.ambientColor} /></Row><Row title="Directional"><Color value={settings.lightColor} /></Row>
        <Row title="Light direction">{direction ? `${number(direction.x)}, ${number(direction.y)}, ${number(direction.z)}` : "Not provided"}</Row>
        <Row title="Sky top"><Color value={settings.skyColor} /></Row><Row title="Fog enabled">{yesNo(settings.fogEnabled)}</Row><Row title="Fog color"><Color value={settings.fogColor} /></Row><Row title="Fog range">{number(settings.fogMin, " m")} – {number(settings.fogMax, " m")}</Row><Row title="Shadows disabled">{yesNo(settings.disableShadows)}</Row>
      </dl></section>
      <section><h3><Layers size={16} />Terrain & scenery</h3><dl>
        <Row title="Terrain enabled">{yesNo(settings.terrainEnabled)}</Row><Row title="Terrain offset">{number(settings.terrainOffset, " m")}</Row><Row title="Ground model">{displayAssetName(settings.ground)}</Row><Row title="Repeating ground">{yesNo(settings.repeatingGround)}</Row><Row title="Skybox model">{displayAssetName(settings.skybox)}</Row><Row title="Backdrop">{displayAssetName(settings.backdrop)}</Row>
      </dl></section>
      <section><h3><Droplets size={16} />Water</h3><dl>
        <Row title="Enabled">{yesNo(settings.waterEnabled)}</Row><Row title="Level">{number(settings.waterLevel, " m")}</Row><Row title="Color">{typeof settings.waterColor === "string" ? <Color value={settings.waterColor} /> : "Not provided"}</Row><Row title="Opacity">{typeof settings.waterOpacity === "number" ? number(settings.waterOpacity * 100, "%") : "Not provided"}</Row><Row title="Surface texture">{displayAssetName(settings.waterTexture)}</Row><Row title="Under terrain">{yesNo(settings.waterUnderTerrain)}</Row>
      </dl></section>
    </div>
    <div className="world-object-path"><strong>Object path</strong><span>{studio ? "Original bundled studio assets" : displayObjectPath(settings.objectPath)}</span><small>Shown as text only. Credentials and query parameters are never displayed here.</small></div>
    {!!warnings.length && <div className="world-attribute-warnings" role="status"><strong>Attribute notes</strong><ul>{warnings.slice(0, 32).map((warning, index) => <li key={index}>{warning}</li>)}</ul>{warnings.length > 32 && <p>Additional attribute notes were omitted.</p>}</div>}
    <p className="world-details-note">Values describe the world, not complete renderer support. Advanced cloud, shader-water, media and physics features may still differ from historical Active Worlds. Build capability does not override object ownership or concurrency checks.</p>
    {onEdit && !studio && online && settings.caretaker === true && settings.editContext && !settings.editContext.blocked && <button className="secondary-button full-width" onClick={onEdit}>Edit world settings</button>}
    <button className="primary-button full-width" onClick={onClose}>Back to the world</button>
  </Modal>;
}
