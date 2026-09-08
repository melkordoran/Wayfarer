import type { Position } from '../../shared/types';
import { tokenize } from './rwx';

export interface ActionCommand { trigger: string; command: string; args: string[]; raw: string }
export const ACTION_LIMITS = Object.freeze({ sourceCharacters: 65_536, commands: 256, contacts: 256, bumpMeshes: 256, bumpCooldownMs: 1000 });
/** Split only outside quotes so descriptions and URLs may contain commas and semicolons. */
function split(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (quote) { if (text[i] === quote) quote = ''; }
    else if (text[i] === '"' || text[i] === "'") quote = text[i];
    else if (text[i] === delimiter) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}
export function parseActions(source: string): ActionCommand[] {
  if (source.length > ACTION_LIMITS.sourceCharacters) return [];
  const actions: ActionCommand[] = [];
  for (const block of split(source, ';')) {
    const trimmed = block.trim();
    const trigger = /^(create|activate|bump|adone|done|collide|enter|exit)\s+/i.exec(trimmed);
    if (!trigger) continue;
    for (const raw of split(trimmed.slice(trigger[0].length), ',')) {
      const [command, ...args] = tokenize(raw.trim());
      if (command) {
        if (actions.length >= ACTION_LIMITS.commands) return []; // Never execute an accidentally truncated script.
        actions.push({ trigger: trigger[1].toLowerCase(), command: command.toLowerCase(), args, raw: raw.trim() });
      }
    }
  }
  return actions;
}
export interface TeleportTarget { world?: string; position: Position }
const decimal = '(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const numberToken = new RegExp(`^[+-]?${decimal}$`);
const relativeToken = new RegExp(`^[+-]${decimal}$`);
const cardinalToken = new RegExp(`^([+-]?${decimal})([NSEW])$`, 'i');
const altitudeToken = new RegExp(`^([+-]?${decimal})A$`, 'i');
const coordinateLike = new RegExp(`^[+-]?${decimal}[NSEWA]?$`, 'i');
/** AW world-axis coordinates and altitude use 10 m units; heading uses degrees.
 * Signed bare horizontal pairs are relative N/S then E/W, never avatar-local.
 * https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Teleport */
export function parseTeleport(value: string, current: Position): TeleportTarget | null {
  if (value.length > 1024) return null;
  const parts = tokenize(value);
  let world: string | undefined;
  if (parts[0] && !coordinateLike.test(parts[0])) {
    world = parts.shift();
    if (!world || world.length > 64 || /[\x00-\x1f\x7f]/.test(world) || !world.trim() || /^(?:[+-]?Infinity|NaN)$/i.test(world)) return null;
  }
  if (!parts.length) return world ? checkedTarget(world, { x: 0, y: 0, z: 0, yaw: current.yaw, ...(current.pitch === undefined ? {} : { pitch: current.pitch }) }) : null;
  if (parts.length < 2 || parts.length > 4) return null;
  const position = { ...current };
  const [first, second] = parts.splice(0, 2);
  if (relativeToken.test(first) && relativeToken.test(second)) {
    position.z += Number(first) * 10; position.x += Number(second) * 10;
  } else {
    const a = cardinalToken.exec(first), b = cardinalToken.exec(second);
    if (!a || !b || /[NS]/i.test(a[2]) === /[NS]/i.test(b[2])) return null;
    for (const coordinate of [a, b]) {
      const amount = Number(coordinate[1]) * 10, axis = coordinate[2].toUpperCase();
      if (axis === 'N' || axis === 'S') position.z = axis === 'N' ? amount : -amount;
      else position.x = axis === 'W' ? amount : -amount;
    }
  }
  if (parts.length && altitudeToken.test(parts[0])) {
    const altitude = altitudeToken.exec(parts.shift()!)![1];
    position.y = Number(altitude) * 10 + (relativeToken.test(altitude) ? current.y : 0);
  }
  if (parts.length) {
    const heading = parts.shift()!;
    if (!numberToken.test(heading)) return null;
    position.yaw = Number(heading) * Math.PI / 180 + (relativeToken.test(heading) ? current.yaw : 0);
  }
  return parts.length ? null : checkedTarget(world, position);
}

function checkedTarget(world: string | undefined, position: Position): TeleportTarget | null {
  return [position.x, position.y, position.z].every(value => Number.isFinite(value) && Math.abs(value) <= 21474836.47)
    && [position.yaw, position.pitch ?? 0].every(value => Number.isFinite(value) && Math.abs(value) <= 2147483647 * Math.PI / 1800)
    ? { world, position } : null;
}

/** Contact edges plus a global one-second safety cooldown prevent authored portal
 * loops and repeated callbacks while pressing a wall. This is a Wayfarer safety
 * policy, not a claim about an undocumented historical AW timing interval. */
export class BumpContacts {
  private previous = new Set<number>();
  private suppressed = new Set<number>();
  private nextAllowed = 0;
  update(ids: Iterable<number>, now: number, enabled = true): number | undefined {
    const current = new Set<number>();
    let first: number | undefined, scanned = 0;
    for (const id of ids) {
      if (scanned++ >= ACTION_LIMITS.contacts) break;
      if (!Number.isSafeInteger(id)) continue;
      current.add(id);
      if (first === undefined && !this.previous.has(id) && !this.suppressed.has(id)) first = id;
    }
    this.previous = current; this.suppressed.clear();
    if (!enabled || !Number.isFinite(now) || now < this.nextAllowed || first === undefined) return undefined;
    this.nextAllowed = now + ACTION_LIMITS.bumpCooldownMs; return first;
  }
  has(id: number) { return this.previous.has(id); }
  suppress(id: number) { if (this.suppressed.size < ACTION_LIMITS.contacts) this.suppressed.add(id); }
  forget(id: number) { this.previous.delete(id); this.suppressed.delete(id); }
  reset(now: number, quiet = true) { this.previous.clear(); this.suppressed.clear(); this.nextAllowed = Number.isFinite(now) && quiet ? now + ACTION_LIMITS.bumpCooldownMs : 0; }
}

export function actionColor(args: string[]): string | undefined {
  if (!args.length) return undefined;
  if (args.length >= 3 && args.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
    return '#' + args.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, Number(v)))).toString(16).padStart(2, '0')).join('');
  }
  const value = args[0];
  return /^[0-9a-f]{6}$/i.test(value) ? '#' + value : value;
}
