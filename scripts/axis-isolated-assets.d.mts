export function assetNameFromRequest(value: unknown): string | null;
export function loadIsolatedAssets(manifestPath: string): { directory: string; port: number; files: Map<string, Buffer> };
