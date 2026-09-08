import type { WorldSettings } from './types';

export const LOCAL_TELEPORT_DENIED = 'Local teleporting is disabled in this world for your current rights. Object teleports and travel to another world remain available.';
export function sameWorld(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}
/** Normalized effective rights take precedence; legacy callers fall back to the
 * documented caretaker exception. This is browser behavior, not anti-cheat.
 * https://web.archive.org/web/20250506090855/https://wiki.activeworlds.com/index.php?title=AW_WORLD_ALLOW_TELEPORT */
export function localTeleportAllowed(settings: WorldSettings | null | undefined): boolean {
  if (!settings || settings.demo === true) return true;
  if (typeof settings.canTeleport === 'boolean') return settings.canTeleport;
  return settings.caretaker === true || settings.allowTeleport !== false;
}
