import type { ClientCommand } from '../src/shared/types';
import { assetUrl } from '../src/shared/validation';

export interface PreviewIsolation { universePort: number; worldPort: number; assetPort: number }
export interface PreviewOptions { port: number; allowedOrigins: Set<string>; isolation: PreviewIsolation | null }
/** Explicit local development options. Never opens the bridge to remote origins. */
export function previewOptions(environment: Record<string, string | undefined> = process.env): PreviewOptions {
  const value = environment.WAYFARER_PREVIEW_BRIDGE_PORT ?? '5174';
  if (!/^\d{4,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid local preview bridge port.');
  const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173']);
  const extra = environment.WAYFARER_PREVIEW_ORIGIN;
  if (extra) {
    if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(extra)) throw new Error('Additional preview origins must be explicit IPv4 loopback HTTP origins.');
    const port = Number(new URL(extra).port);
    if (port < 1024 || port > 65535) throw new Error('Invalid additional preview origin port.');
    allowedOrigins.add(extra);
  }
  let isolation: PreviewIsolation | null = null;
  const isolated = environment.WAYFARER_PREVIEW_ISOLATED;
  const universe = environment.WAYFARER_PREVIEW_ISOLATED_UNIVERSE_PORT;
  const world = environment.WAYFARER_PREVIEW_ISOLATED_WORLD_PORT;
  const assets = environment.WAYFARER_PREVIEW_ISOLATED_ASSET_PORT;
  if (isolated !== undefined || universe !== undefined || world !== undefined || assets !== undefined) {
    if (isolated !== '1' || !extra || !universe || !world || !assets || !environment.WAYFARER_PREVIEW_BRIDGE_PORT) throw new Error('Isolated preview requires an explicit origin, bridge port, Universe port, World port and asset port.');
    const numbers = [Number(value), Number(new URL(extra).port), Number(universe), Number(world), Number(assets)];
    if (![universe, world, assets].every(port => /^\d{4,5}$/.test(port)) || numbers.some(port => port < 1024 || port > 65535 || [16670, 17000, 17400, 5173, 5174, 4173].includes(port)) || new Set(numbers).size !== 5) throw new Error('Isolated preview ports must be distinct and must not target primary services or previews.');
    isolation = Object.freeze({ universePort: Number(universe), worldPort: Number(world), assetPort: Number(assets) });
    // Primary preview origins are intentionally not allowed on this bridge.
    allowedOrigins.clear(); allowedOrigins.add(extra);
  }
  return { port: Number(value), allowedOrigins, isolation };
}

export function assertPreviewCommandTarget(command: ClientCommand, options: PreviewOptions): void {
  if (!options.isolation || command.type !== 'connect') return;
  if (command.options.host !== '127.0.0.1' || command.options.port !== options.isolation.universePort || command.options.tls !== false)
    throw new Error('This isolated preview can connect only to its own loopback test Universe. Saved primary or remote connections are blocked.');
}

export function assertPreviewAssetTarget(input: string, options: PreviewOptions): string {
  const url = assetUrl(input);
  if (options.isolation && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(options.isolation.assetPort) || url.search || url.hash))
    throw new Error('This isolated preview can load assets only from its own copied loopback fixture.');
  return url.href;
}

export function assertPreviewWorldTarget(target: { host: string; port: number; tls: boolean }, options: PreviewOptions): void {
  if (options.isolation && (target.host !== '127.0.0.1' || target.port !== options.isolation.worldPort || target.tls !== false))
    throw new Error('This isolated preview can enter only its own loopback test World server. Primary and remote World targets are blocked.');
}
