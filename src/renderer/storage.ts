import type { ConnectionOptions, Position } from "../shared/types";

export interface Place {
  id: string;
  name: string;
  world: string;
  position: Position;
  studio: boolean;
}
export interface Preferences {
  time: "day" | "sunset" | "night";
  worldTime?: "world" | "day" | "sunset" | "night";
  reticle: boolean;
  compact: boolean;
}
export function savedPreferences(): Preferences {
  const stored = readStored<Partial<Preferences>>("preferences", {});
  return {
    time: ["day", "sunset", "night"].includes(stored.time || "") ? stored.time! : "sunset",
    // The legacy preference was a studio look, not consent to override every world.
    worldTime: ["world", "day", "sunset", "night"].includes(stored.worldTime || "") ? stored.worldTime! : "world",
    reticle: stored.reticle !== false,
    compact: stored.compact === true,
  };
}
export function readStored<T>(key: string, fallback: T): T {
  try {
    const item = localStorage.getItem(`wayfarer:${key}`);
    if (!item) return fallback;
    const parsed = JSON.parse(item);
    if (
      fallback !== null &&
      typeof fallback === "object" &&
      (parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) !== Array.isArray(fallback))
    )
      return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}
export function saveStored(key: string, value: unknown) {
  try {
    localStorage.setItem(`wayfarer:${key}`, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable in private profiles. */
  }
}
export function savedConnection(): ConnectionOptions {
  const stored = readStored<Partial<ConnectionOptions>>("connection", {});
  return {
    host: typeof stored.host === "string" ? stored.host : "127.0.0.1",
    port: typeof stored.port === "number" ? stored.port : 16670,
    username:
      typeof stored.username === "string" ? stored.username : "Wayfarer",
    password: "",
    world: typeof stored.world === "string" ? stored.world : "Haven",
    tls: stored.tls === true,
    tourist: stored.tourist === true,
  };
}
export function rememberConnection(options: ConnectionOptions) {
  const { password: _password, email: _email, ...safe } = options;
  saveStored("connection", safe);
}
export function savedPlaces(): Place[] {
  const value = readStored<unknown>("places", []);
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (p): p is Place =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.world === "string" &&
        p.position &&
        ["x", "y", "z", "yaw"].every(
          (k) =>
            typeof p.position[k] === "number" && Number.isFinite(p.position[k]),
        ),
    )
    .slice(0, 100);
}
export function coordinates(p: Position) {
  return `${(Math.abs(p.z) / 10).toFixed(1)}${p.z >= 0 ? "N" : "S"} ${(Math.abs(p.x) / 10).toFixed(1)}${p.x >= 0 ? "W" : "E"} ${(p.y / 10).toFixed(1)}a`;
}
