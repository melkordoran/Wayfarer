/** Caretaker editor's deliberately bounded subset of Axis WorldAttributeId.
 * IDs/types follow the pinned WorldAttributes.cs; ranges are Wayfarer editing
 * limits, not assertions that the server rejects wider legacy values. */
export interface WorldSettingField {
  key: string; label: string; group: string;
  kind: 'text' | 'asset' | 'entry' | 'object-path' | 'boolean' | 'integer' | 'float' | 'color';
  ids: readonly number[]; min?: number; max?: number; maxBytes?: number; unit?: string; multiline?: boolean;
}
export interface WorldSettingChange { id: number; before: string | null; value: string }
export interface WorldSettingsSetCommand {
  type: 'world-settings-set'; requestId: string; world: string; session: number;
  entryId: string; revision: number; changes: WorldSettingChange[];
}
/** Axis supplies no request acknowledgement, revision/CAS, or durability proof.
 * These results describe post-dispatch observation, not a transaction outcome. */
export interface WorldSettingsResult {
  type: 'world-settings-result'; requestId: string; world: string; session: number;
  entryId: string; status: 'observed' | 'conflict' | 'uncertain'; message: string;
}
const field = (key: string, label: string, group: string, kind: WorldSettingField['kind'], ids: number | number[], extra: Partial<WorldSettingField> = {}): WorldSettingField =>
  Object.freeze({ key, label, group, kind, ids: Object.freeze(Array.isArray(ids) ? ids : [ids]), ...extra });
const numeric = (key: string, label: string, group: string, kind: 'integer' | 'float', id: number, min: number, max: number, unit?: string) => field(key, label, group, kind, id, { min, max, unit });
export const WORLD_SETTING_FIELDS: readonly WorldSettingField[] = Object.freeze([
  field('title', 'World title', 'General', 'text', 0x70, { maxBytes: 255 }),
  field('welcome', 'Welcome message', 'General', 'text', 0x81, { maxBytes: 4094, multiline: true }),
  field('entry', 'Entrance', 'General', 'entry', 0x2f, { maxBytes: 128, unit: 'AW coordinates, e.g. 0N 0W 0a 0' }),
  field('allowFlying', 'Allow flying', 'Movement rules', 'boolean', 0x03),
  field('allowTeleport', 'Allow teleporting', 'Movement rules', 'boolean', 0x06),
  field('allowPassthru', 'Allow pass-through', 'Movement rules', 'boolean', 0x05),
  field('allowAvatarCollision', 'Avatar collision', 'Movement rules', 'boolean', 0x01),
  field('ambientColor', 'Ambient light', 'Lighting & sky', 'color', [0x0c, 0x0b, 0x0a]),
  field('lightColor', 'Directional light', 'Lighting & sky', 'color', [0x41, 0x3f, 0x3b]),
  numeric('lightX', 'Light direction X', 'Lighting & sky', 'float', 0x43, -1, 1),
  numeric('lightY', 'Light direction Y', 'Lighting & sky', 'float', 0x44, -1, 1),
  numeric('lightZ', 'Light direction Z', 'Lighting & sky', 'float', 0x45, -1, 1),
  field('disableShadows', 'Disable shadows', 'Lighting & sky', 'boolean', 0x95),
  field('skyTop', 'Sky top', 'Lighting & sky', 'color', [0x62, 0x61, 0x60]),
  field('skyBottom', 'Sky bottom', 'Lighting & sky', 'color', [0x56, 0x55, 0x54]),
  field('skyNorth', 'Sky north', 'Lighting & sky', 'color', [0x5c, 0x5b, 0x5a]),
  field('skySouth', 'Sky south', 'Lighting & sky', 'color', [0x5f, 0x5e, 0x5d]),
  field('skyEast', 'Sky east', 'Lighting & sky', 'color', [0x59, 0x58, 0x57]),
  field('skyWest', 'Sky west', 'Lighting & sky', 'color', [0x65, 0x64, 0x63]),
  field('fogEnabled', 'Enable fog', 'Fog', 'boolean', 0x32),
  field('fogTinted', 'Tint objects with fog color', 'Fog', 'boolean', 0x8e),
  field('fogColor', 'Fog color', 'Fog', 'color', [0x36, 0x33, 0x31]),
  numeric('fogMin', 'Fog near', 'Fog', 'integer', 0x35, 0, 1200, 'm'),
  numeric('fogMax', 'Fog far', 'Fog', 'integer', 0x34, 50, 1200, 'm'),
  field('terrainEnabled', 'Enable terrain', 'Terrain & scenery', 'boolean', 0x2d),
  numeric('terrainOffset', 'Terrain offset', 'Terrain & scenery', 'float', 0x6e, -320, 320, 'm'),
  numeric('terrainAmbient', 'Terrain ambient reflection', 'Terrain & scenery', 'float', 0x6c, 0, 1),
  numeric('terrainDiffuse', 'Terrain diffuse reflection', 'Terrain & scenery', 'float', 0x6d, 0, 1),
  field('ground', 'Ground model', 'Terrain & scenery', 'asset', 0x38, { maxBytes: 255 }),
  field('repeatingGround', 'Repeat ground', 'Terrain & scenery', 'boolean', 0x50),
  field('skybox', 'Skybox model', 'Terrain & scenery', 'asset', 0x53, { maxBytes: 255 }),
  field('backdrop', 'Backdrop texture', 'Terrain & scenery', 'asset', 0x0e, { maxBytes: 255 }),
  field('waterEnabled', 'Enable water', 'Water', 'boolean', 0x75),
  numeric('waterLevel', 'Water level', 'Water', 'float', 0x77, -1000, 1000, 'm'),
  field('waterColor', 'Water color', 'Water', 'color', [0x7a, 0x76, 0x72]),
  numeric('waterOpacity', 'Water opacity', 'Water', 'integer', 0x79, 0, 255, '0 transparent · 255 opaque'),
  field('waterTexture', 'Water surface texture', 'Water', 'asset', 0x7d, { maxBytes: 255 }),
  field('waterMask', 'Water surface mask', 'Water', 'asset', 0x78, { maxBytes: 255 }),
  field('waterBottomTexture', 'Water bottom texture', 'Water', 'asset', 0x74, { maxBytes: 255 }),
  field('waterBottomMask', 'Water bottom mask', 'Water', 'asset', 0x73, { maxBytes: 255 }),
  field('waterUnderTerrain', 'Render water under terrain', 'Water', 'boolean', 0x7e),
  numeric('waterVisibility', 'Underwater visibility', 'Water', 'integer', 0x7f, 0, 1200, 'm'),
  numeric('waterSpeed', 'Water motion speed', 'Water', 'float', 0x7b, 0, 100, 'legacy multiplier'),
  numeric('waterSurfaceMove', 'Water surface movement', 'Water', 'float', 0x7c, -10, 10, 'm'),
  numeric('waterWaveMove', 'Water wave movement', 'Water', 'float', 0x80, -10, 10, 'm'),
  numeric('gravity', 'Gravity', 'Physics', 'float', 0x37, -10, 10, 'Earth gravity multiplier'),
  numeric('buoyancy', 'Underwater gravity', 'Physics', 'float', 0x12, -10, 10, 'Earth gravity multiplier'),
  numeric('friction', 'Friction', 'Physics', 'float', 0x89, 0, 100, 'legacy multiplier'),
  numeric('waterFriction', 'Water friction', 'Physics', 'float', 0x8a, 0, 100, 'legacy multiplier'),
  field('objectPath', 'Object path replacement', 'Object path', 'object-path', 0x4c, { maxBytes: 2048 }),
]);
const byId = new Map(WORLD_SETTING_FIELDS.flatMap(item => item.ids.map(id => [id, item] as const)));
const utf8 = new TextEncoder();
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
function bytes(value: string): number { return utf8.encode(value).length; }
function safeString(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum || bytes(value) > maximum || /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(value))
    throw new Error(`Invalid ${label}.`);
}
function finite(value: string, label: string, min: number, max: number, integer: boolean): number {
  const n = Number(value);
  if (!(integer ? /^[+-]?\d+$/ : decimal).test(value) || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw new Error(`${label} must be ${integer ? 'a whole number' : 'a finite number'} from ${min} to ${max}.`);
  return n;
}
function canonicalScalar(item: WorldSettingField, value: string): string {
  safeString(value, item.maxBytes ?? 128, item.label);
  if ((item.multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new Error(`Invalid ${item.label}.`);
  if (item.kind === 'boolean') {
    if (!/^[YN]$/.test(value)) throw new Error(`${item.label} must be Yes or No.`);
    return value;
  }
  if (item.kind === 'integer' || item.kind === 'float' || item.kind === 'color') {
    const n = finite(value, item.label, item.kind === 'color' ? 0 : item.min!, item.kind === 'color' ? 255 : item.max!, item.kind !== 'float');
    return String(item.kind === 'float' ? Math.fround(n) : n);
  }
  if (item.kind === 'asset') {
    if (value !== value.trim() || /[\x00-\x1f\x7f:/\\?#@%]/.test(value) || value === '.' || value === '..')
      throw new Error(`${item.label} must be an object-path filename, not a URL or directory.`);
  }
  if (item.kind === 'object-path' && value) {
    let valid = false;
    try { const url = new URL(value); valid = /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password && !/[?#\\\s]/.test(value) && /^https?:\/\//i.test(value); } catch { /* Never echo a private URL into an error. */ }
    if (!valid) throw new Error('Object path must be an HTTP(S) URL without credentials, query parameters, or a fragment.');
  }
  if (item.kind === 'entry') {
    const match = value.match(/^(-?\d+(?:\.\d+)?)\s*([ns])\s+(-?\d+(?:\.\d+)?)\s*([ew])(?:\s+(-?\d+(?:\.\d+)?)\s*a)?(?:\s+(-?\d+(?:\.\d+)?))?$/i);
    if (!match || [match[1], match[3], match[5] ?? '0'].some(n => !Number.isFinite(Number(n)) || Math.abs(Number(n)) > 2147483.647) || Math.abs(Number(match[6] ?? 0)) > 360)
      throw new Error('Entrance needs N/S then E/W coordinates, optional altitude in 10-metre units, and heading from -360 to 360 degrees.');
  }
  return value;
}
/** No URL credentials or unsupported asset references enter editable baselines.
 * Empty is unknown/unsupported, not permission to serialize a normalized default. */
export function worldSettingDraftValue(item: WorldSettingField, raw: Readonly<Record<number, string>>): string {
  if (item.kind === 'object-path') return '';
  try {
    if (item.kind === 'color') {
      const values = item.ids.map(id => canonicalScalar(item, raw[id]));
      return `#${values.map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
    }
    return canonicalScalar(item, raw[item.ids[0]]);
  } catch { return ''; }
}
/** Comparing floats matches C# Single parsing/formatting, not JS double equality.
 * Invalid values never compare equal, even when the strings happen to match. */
export function worldSettingValuesEqual(id: number, a: string, b: string): boolean {
  const item = byId.get(id); if (!item) return false;
  try { return canonicalScalar(item, a) === canonicalScalar(item, b); } catch { return false; }
}
export function worldSettingChanges(item: WorldSettingField, value: string, raw: Readonly<Record<number, string>>): WorldSettingChange[] {
  if (!WORLD_SETTING_FIELDS.includes(item)) throw new Error('Unsupported world setting.');
  let values: string[];
  if (item.kind === 'color') {
    if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`${item.label} needs a six-digit hex color.`);
    values = [1, 3, 5].map(at => String(parseInt(value.slice(at, at + 2), 16)));
  } else values = [canonicalScalar(item, value)];
  return item.ids.flatMap((id, index) => {
    const before = Object.hasOwn(raw, id) ? raw[id] : null;
    return before !== null && worldSettingValuesEqual(id, before, values[index]) ? [] : [{ id, before, value: values[index] }];
  });
}
export function validateWorldSettingsCommand(input: unknown): asserts input is WorldSettingsSetCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid world-settings command.');
  const c = input as Record<string, unknown>;
  if (c.type !== 'world-settings-set') throw new Error('Invalid world-settings command.');
  for (const key of ['requestId', 'entryId']) {
    if (typeof c[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(c[key] as string)) throw new Error(`Invalid world-settings ${key}.`);
  }
  safeString(c.world, 64, 'world');
  if (!c.world.trim() || /[\x00-\x1f\x7f]/.test(c.world)) throw new Error('Invalid world.');
  if (!Number.isSafeInteger(c.session) || (c.session as number) < 1 || (c.session as number) > 0x7fffffff) throw new Error('A signed-in session is required.');
  if (!Number.isSafeInteger(c.revision) || (c.revision as number) < 0) throw new Error('Invalid world-settings revision.');
  if (!Array.isArray(c.changes) || c.changes.length < 1 || c.changes.length > byId.size) throw new Error('Choose a bounded set of world-setting changes.');
  const seen = new Set<number>(); let total = 0;
  for (const change of c.changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Invalid world-setting change.');
    const { id, before, value } = change as Record<string, unknown>;
    if (!Number.isInteger(id) || !byId.has(id as number) || seen.has(id as number)) throw new Error('Unsupported or duplicate world setting.');
    seen.add(id as number);
    if (before !== null) safeString(before, 8192, 'world-setting baseline');
    const item = byId.get(id as number)!;
    safeString(value, item.maxBytes ?? 128, item.label); canonicalScalar(item, value);
    total += bytes(value) + (before === null ? 0 : bytes(before as string));
    if (total > 32768) throw new Error('World-setting changes exceed the 32 KiB safety limit.');
  }
}
/** Validate edited groups only: untouched legacy-invalid fields cannot block a
 * title change. Bounds are rechecked in the adapter against its current map. */
export function validateWorldSettingsChanges(changes: readonly WorldSettingChange[], baseline: ReadonlyMap<number, string>): void {
  const next = new Map(baseline);
  for (const change of changes) {
    const item = byId.get(change.id); if (!item) throw new Error('Unsupported world setting.');
    next.set(change.id, canonicalScalar(item, change.value));
  }
  if (changes.some(change => change.id === 0x35 || change.id === 0x34)) {
    const near = next.get(0x35), far = next.get(0x34);
    if (near === undefined || far === undefined) throw new Error('Set both fog near and far when either value is unavailable.');
    const min = Number(canonicalScalar(byId.get(0x35)!, near)), max = Number(canonicalScalar(byId.get(0x34)!, far));
    if (max <= min) throw new Error('Fog far must be greater than fog near.');
  }
}
