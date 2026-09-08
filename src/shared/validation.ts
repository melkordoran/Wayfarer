import type { ClientCommand, Position, WorldObject } from "./types";
import { TERRAIN_EDIT_LIMITS, terrainCentimetres } from './terrain-edit';
import { validateWorldSettingsCommand } from './world-settings-edit';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid command payload.");
  return value as Record<string, unknown>;
}
function string(
  value: unknown,
  label: string,
  maximum = 1024,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${label}.`);
}
function number(
  value: unknown,
  label: string,
  maximum = 1e9,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > maximum
  )
    throw new Error(`Invalid ${label}.`);
}
function unsignedInteger(
  value: unknown,
  label: string,
  maximum = 0xffffffff,
): asserts value is number {
  number(value, label, maximum);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`Invalid ${label}.`);
}
function position(value: unknown): asserts value is Position {
  const p = record(value);
  for (const key of ["x", "y", "z"]) number(p[key], key, 21474836.47);
  number(p.yaw, "yaw", (2147483647 * Math.PI) / 1800);
  if (p.pitch !== undefined)
    number(p.pitch, "pitch", (2147483647 * Math.PI) / 1800);
}
function object(value: unknown): asserts value is WorldObject {
  const o = record(value);
  position(value);
  for (const key of ["id", "owner"]) unsignedInteger(o[key], key);
  for (const key of ["pitch", "roll"])
    number(o[key], key, (2147483647 * Math.PI) / 1800);
  if (o.type !== undefined) unsignedInteger(o.type, "object type", 65535);
  for (const key of ["cellX", "cellZ"])
    if (o[key] !== undefined) {
      number(o[key], key, 0x7fffffff);
      if (!Number.isInteger(o[key])) throw new Error(`Invalid ${key}.`);
    }
  string(o.model, "model", 255);
  string(o.description, "description", 8192);
  string(o.action, "action", 8192);
  if (o.data !== undefined) string(o.data, "object data", 65536);
}
function requestId(value: unknown): void {
  if (value === undefined) return;
  string(value, "request ID", 128);
  if (!value.trim()) throw new Error("Invalid request ID.");
}
/** Treat renderer and WebSocket messages as untrusted, including in local development. */
export function assertCommand(value: unknown): asserts value is ClientCommand {
  const c = record(value);
  switch (c.type) {
    case "connect": {
      const o = record(c.options);
      string(o.host, "host", 253);
      if (!o.host || /[\s/\\@?#]/.test(o.host as string))
        throw new Error(
          "Enter a hostname or IP address, without a URL scheme.",
        );
      number(o.port, "port", 65535);
      if (!Number.isInteger(o.port) || (o.port as number) < 1)
        throw new Error("Port must be between 1 and 65535.");
      string(o.username, "username", 64);
      string(o.password, "password", 256);
      if (o.email !== undefined) string(o.email, "email", 50);
      if (
        o.tourist &&
        (typeof o.email !== "string" ||
          o.email.length < 8 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email))
      )
        throw new Error(
          "Axis requires an email address for tourist login (8–50 characters).",
        );
      if (!o.username)
        throw new Error("Enter your citizen name or tourist nickname.");
      if (
        typeof o.tls !== "boolean" ||
        (o.tourist !== undefined && typeof o.tourist !== "boolean")
      )
        throw new Error("Invalid connection settings.");
      if (o.world !== undefined) string(o.world, "world", 64);
      break;
    }
    case "disconnect":
    case "contacts-list":
    case "telegram-fetch":
      break;
    case "contact-add":
      string(c.name, "contact name", 64);
      if (!c.name.trim()) throw new Error("Enter a contact name.");
      if (c.options !== undefined) unsignedInteger(c.options, "contact options", 65535);
      break;
    case "contact-delete":
    case "contact-confirm":
      unsignedInteger(c.citizen, "contact citizen", 0x7fffffff);
      if (c.citizen === 0) throw new Error("A contact citizen number is required.");
      if (c.type === "contact-confirm" && c.options !== undefined) unsignedInteger(c.options, "contact options", 65535);
      break;
    case "contact-change":
      unsignedInteger(c.citizen, "contact citizen", 0x7fffffff);
      unsignedInteger(c.options, "contact options", 65535);
      break;
    case "telegram-send":
      string(c.to, "telegram recipient", 64);
      string(c.text, "telegram message", 1000);
      if (!c.to.trim() || !c.text.trim()) throw new Error("A telegram needs a recipient and a message.");
      if (c.to.trim().startsWith("*")) throw new Error("System telegram commands are not supported.");
      break;
    case "enter":
      string(c.world, "world", 64);
      if (!c.world.trim()) throw new Error("Choose a world.");
      if (c.position !== undefined) position(c.position);
      if (c.origin !== undefined && c.origin !== "user" && c.origin !== "action")
        throw new Error("Invalid travel origin.");
      if (c.origin === "action") {
        string(c.fromWorld, "source world", 64);
        if (!c.fromWorld.trim()) throw new Error("An object travel source world is required.");
        unsignedInteger(c.session, "session", 0x7fffffff);
        if (c.session === 0) throw new Error("A signed-in session is required.");
      }
      break;
    case "chat":
      string(c.text, "chat message", 1024);
      if (c.whisperTo !== undefined) unsignedInteger(c.whisperTo, "recipient");
      break;
    case "move":
      position(c.position);
      break;
    case "query":
      number(c.x, "cell x", 21474836.47);
      number(c.z, "cell z", 21474836.47);
      break;
    case 'world-settings-set':
      validateWorldSettingsCommand(c);
      break;
    case 'terrain-set': {
      requestId(c.requestId);
      if (typeof c.requestId !== 'string') throw new Error('A terrain request ID is required.');
      string(c.world, 'world', 64);
      if (!c.world.trim()) throw new Error('Choose a world.');
      unsignedInteger(c.session, 'session', 0x7fffffff);
      if (c.session === 0) throw new Error('A signed-in session is required.');
      for (const key of ['cellX', 'cellZ']) {
        number(c[key], key, TERRAIN_EDIT_LIMITS.maxCellCoordinate);
        if (!Number.isInteger(c[key])) throw new Error(`Invalid terrain ${key}.`);
      }
      if (!Array.isArray(c.heights) || c.heights.length < 1 || c.heights.length > TERRAIN_EDIT_LIMITS.maxRowCells)
        throw new Error('A terrain row must contain 1–32 cells.');
      if ((c.cellX as number) + c.heights.length - 1 > TERRAIN_EDIT_LIMITS.maxCellCoordinate) throw new Error('Terrain row exceeds the supported coordinate range.');
      for (const key of ['heights', 'previousHeights', 'previousTextures']) {
        const values = c[key];
        if (!Array.isArray(values) || values.length !== c.heights.length) throw new Error('Terrain row and baseline lengths must match.');
        for (const value of values) {
          if (key === 'previousTextures') unsignedInteger(value, 'terrain texture', 65535);
          else { number(value, 'terrain height', 21474836.48); terrainCentimetres(value); }
        }
      }
      unsignedInteger(c.texture, 'terrain texture', 65535);
      break;
    }
    case "object-add":
    case "object-delete":
      object(c.object);
      requestId(c.requestId);
      break;
    case "object-click":
      object(c.object);
      break;
    case "object-change":
      object(c.object);
      object(c.previous);
      requestId(c.requestId);
      break;
    case "avatar-set":
      unsignedInteger(c.avatar, "avatar", 65535);
      if (c.gesture !== undefined) unsignedInteger(c.gesture, "gesture", 255);
      break;
    case "gesture":
    case "avatar-select":
      if (c.type === "gesture") unsignedInteger(c.gesture, "gesture", 255);
      unsignedInteger(c.avatar, "avatar", 65535);
      unsignedInteger(c.session, "session", 0x7fffffff);
      if (c.session === 0) throw new Error("A signed-in session is required.");
      string(c.world, "world", 64);
      if (!c.world.trim()) throw new Error("Choose a world.");
      break;
    default:
      throw new Error("Unsupported command.");
  }
}

export function assetUrl(input: string): URL {
  if (typeof input !== "string" || input.length > 8192)
    throw new Error("Invalid asset URL.");
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Assets must use HTTP or HTTPS without embedded credentials.",
    );
  return url;
}
