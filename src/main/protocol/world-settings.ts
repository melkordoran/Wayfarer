import type { Position, WorldSettings } from '../../shared/types';
import type { Packet } from './codec';

/** Independent mapping of Axis.Platform WorldAttributeId (f18054d5) and
 * WorldAttributes.SetDefaultValues/FormatForPacket (World c3e7486).
 * Physical semantics: archived official ActiveWiki World_Features (20250506133806)
 * and AW_WORLD_* attribute pages. See WORLD_ENVIRONMENT_SOURCES below. */
export const WORLD_ATTRIBUTE = {
  AllowAvatarCollision: 0x01, AllowFlying: 0x03, AllowPassthru: 0x05, AllowTeleport: 0x06,
  AmbientLightBlue: 0x0a, AmbientLightGreen: 0x0b, AmbientLightRed: 0x0c, Backdrop: 0x0e, Buoyancy: 0x12,
  EnableTerrain: 0x2d, EntryPoint: 0x2f, FogBlue: 0x31, FogEnable: 0x32, FogGreen: 0x33,
  FogMaximum: 0x34, FogMinimum: 0x35, FogRed: 0x36, Gravity: 0x37, Ground: 0x38,
  LightBlue: 0x3b, LightDrawBright: 0x3c, LightDrawFront: 0x3d, LightDrawSize: 0x3e,
  LightGreen: 0x3f, LightMask: 0x40, LightRed: 0x41, LightTexture: 0x42, LightX: 0x43, LightY: 0x44, LightZ: 0x45,
  ObjectPassword: 0x4a, ObjectPath: 0x4c, RepeatingGround: 0x50, Skybox: 0x53,
  SkyBottomBlue: 0x54, SkyBottomGreen: 0x55, SkyBottomRed: 0x56, SkyEastBlue: 0x57, SkyEastGreen: 0x58, SkyEastRed: 0x59,
  SkyNorthBlue: 0x5a, SkyNorthGreen: 0x5b, SkyNorthRed: 0x5c, SkySouthBlue: 0x5d, SkySouthGreen: 0x5e, SkySouthRed: 0x5f,
  SkyTopBlue: 0x60, SkyTopGreen: 0x61, SkyTopRed: 0x62, SkyWestBlue: 0x63, SkyWestGreen: 0x64, SkyWestRed: 0x65,
  TerrainAmbient: 0x6c, TerrainDiffuse: 0x6d, TerrainOffset: 0x6e, Title: 0x70,
  WaterBlue: 0x72, WaterBottomMask: 0x73, WaterBottomTexture: 0x74, WaterEnabled: 0x75, WaterGreen: 0x76,
  WaterLevel: 0x77, WaterMask: 0x78, WaterOpacity: 0x79, WaterRed: 0x7a, WaterSpeed: 0x7b,
  WaterSurfaceMove: 0x7c, WaterTexture: 0x7d, WaterUnderTerrain: 0x7e, WaterVisibility: 0x7f, WaterWaveMove: 0x80,
  WelcomeMessage: 0x81, Friction: 0x89, WaterFriction: 0x8a, SlopeslideEnabled: 0x8b, SlopeslideMinAngle: 0x8c,
  SlopeslideMaxAngle: 0x8d, FogTinted: 0x8e, LightSourceUseColor: 0x8f, LightSourceColor: 0x90,
  DisableShadows: 0x95, EnableCameraCollision: 0x96, CavObjectPassword: 0x99, TerrainRight: 0x9b,
  WaterUseShaders: 0xb3, WaterSurfaceColor: 0xb4, WaterTintColor: 0xb5,
} as const;
export const WORLD_CAPABILITY = { Build: 0, Caretaker: 1, Eject: 2, EminentDomain: 3, PublicSpeaker: 4, Speak: 5, Owner: 6 } as const;
export const WORLD_ENVIRONMENT_SOURCES = {
  axis: 'https://gitlab.pp16.org/axis/world_server/-/blob/c3e7486fc153ac31b3df1a07bc2b03d20e348152/Axis.WorldServer/Models/WorldAttributes.cs',
  features: 'https://web.archive.org/web/20250506133806/https://wiki.activeworlds.com/index.php?title=World_Features',
  light: 'https://web.archive.org/web/20250506091000/https://wiki.activeworlds.com/index.php?title=AW_WORLD_LIGHT_Y',
  opacity: 'https://web.archive.org/web/20250506091018/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_OPACITY',
  waterLevel: 'https://web.archive.org/web/20250506090909/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_LEVEL',
  surface: 'https://web.archive.org/web/20250506090937/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_SURFACE_MOVE',
  wave: 'https://web.archive.org/web/20250506090904/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_WAVE_MOVE',
  speed: 'https://web.archive.org/web/20250506091015/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_SPEED',
  gravity: 'https://web.archive.org/web/20250506090933/https://wiki.activeworlds.com/index.php?title=AW_WORLD_GRAVITY',
  friction: 'https://web.archive.org/web/20250506091028/https://wiki.activeworlds.com/index.php?title=AW_WORLD_FRICTION',
  underwaterVisibility: 'https://web.archive.org/web/20250506091031/https://wiki.activeworlds.com/index.php?title=AW_WORLD_WATER_VISIBILITY',
  fogMaximum: 'https://web.archive.org/web/20250506090937/https://wiki.activeworlds.com/index.php?title=AW_WORLD_FOG_MAXIMUM',
} as const;
const A = WORLD_ATTRIBUTE, C = WORLD_CAPABILITY;
const names = new Map<number, string>(Object.entries(A).map(([name, id]) => [id, name]));
const capabilityNames = new Map<number, string>(Object.entries(C).map(([name, id]) => [id, name]));
const passwordIds = new Set<number>([A.ObjectPassword, A.CavObjectPassword]);

/** Bounded cumulative state; a partial packet must not erase earlier fields.
 * Password bytes are deliberately not retained or forwarded to the renderer. */
export function mergeWorldSettingsPacket(target: Map<number, string>, packet: Packet, capabilities = false): string[] {
  const warnings: string[] = [];
  for (const value of packet.fields) {
    if (capabilities ? !capabilityNames.has(value.id) : passwordIds.has(value.id)) continue;
    if (value.type !== 4) {
      if (capabilities || (value.id === A.TerrainRight && (target.has(value.id) || target.size < 1024))) target.set(value.id, '');
      warnings.push(`Ignored non-text ${capabilities ? 'capability' : 'attribute'} ${value.id}.`); continue;
    }
    if (value.data.length > 8192 || (!target.has(value.id) && target.size >= 1024)) {
      if (capabilities || (value.id === A.TerrainRight && (target.has(value.id) || target.size < 1024))) target.set(value.id, '');
      warnings.push('World attribute storage limit reached; oversized or excess values were ignored.'); continue;
    }
    target.set(value.id, value.data.toString('utf8').replace(/\0+$/, ''));
  }
  return [...new Set(warnings)].slice(0, 32);
}

export function entryPosition(value: string): Position {
  const result: Position = { x: 0, y: 0, z: 0, yaw: 0 };
  for (const match of value.matchAll(/(-?\d+(?:\.\d+)?)\s*([nsewa])/gi)) {
    const n = Number(match[1]), direction = match[2].toLowerCase();
    if (direction === 'n' || direction === 's') result.z = n * 10 * (direction === 's' ? -1 : 1);
    if (direction === 'w' || direction === 'e') result.x = n * 10 * (direction === 'e' ? -1 : 1);
    if (direction === 'a') result.y = n * 10;
  }
  const yaw = value.match(/(?:[nsewa])\s+(-?\d+(?:\.\d+)?)\s*$/i); if (yaw) result.yaw = Number(yaw[1]) * Math.PI / 180;
  return result;
}

export function defaultWorldSettings(name: string): WorldSettings {
  return {
    name, title: 'Untitled', welcome: '', objectPath: '', // A configurable server object path must be advertised, never guessed/downloaded.
    skyColor: '#000000', skyColors: { top: '#000000', bottom: '#000000', north: '#000000', south: '#000000', east: '#000000', west: '#000000' },
    fogEnabled: false, fogTinted: false, fogColor: '#ffffff', fogMin: 0, fogMax: 1200,
    ambientColor: '#bfbfbf', lightColor: '#ffffff', lightDirection: { x: 0, y: 0, z: 0 }, disableShadows: false,
    terrainEnabled: true, terrainOffset: -0.1, terrainAmbient: 1, terrainDiffuse: 0,
    ground: '', repeatingGround: true, skybox: '', backdrop: '',
    waterEnabled: false, waterLevel: 0, waterColor: '#000000', waterOpacity: 0,
    waterTexture: '', waterMask: '', waterBottomTexture: '', waterBottomMask: '', waterUnderTerrain: false,
    waterVisibility: 150, waterSpeed: 0, waterSurfaceMove: 0, waterWaveMove: 0,
    allowFlying: true, allowPassthru: true, allowTeleport: true, allowAvatarCollision: true,
    canFly: true, canPassthru: true, canTeleport: true, gravity: 1, buoyancy: 1, friction: 1, waterFriction: 2,
    entry: { x: 0, y: 0, z: 0, yaw: 0 }, canBuild: false, canEditTerrain: false, canSpeak: false, caretaker: false, owner: false,
    canEject: false, canUseEminentDomain: false, publicSpeaker: false, environmentWarnings: [], unsupportedEnvironmentAttributes: {}, rawAttributes: {},
  };
}

const unsupported = new Map<number, string>();
for (let layer = 1; layer <= 3; layer++) {
  for (const [i, name] of ['Mask', 'Opacity', 'SpeedX', 'SpeedZ', 'Texture', 'Tile'].entries()) unsupported.set(0x14 + (layer - 1) * 6 + i, `CloudsLayer${layer}${name}`);
}
for (const name of ['LightTexture', 'LightMask', 'LightDrawSize', 'LightDrawFront', 'LightDrawBright', 'LightSourceUseColor', 'LightSourceColor', 'SlopeslideEnabled', 'SlopeslideMinAngle', 'SlopeslideMaxAngle', 'EnableCameraCollision', 'WaterUseShaders', 'WaterSurfaceColor', 'WaterTintColor'] as const) unsupported.set(A[name], name);
for (const [group, first] of [['Wavelet', 0xb6], ['Wave1', 0xba], ['Wave2', 0xbe], ['Wave3', 0xc2], ['Wave4', 0xc6]] as const) {
  ['Speed', 'DirectionX', 'DirectionZ', 'Height'].forEach((name, i) => unsupported.set(first + i, `Water${group}${name}`));
}
['AutoCubemap', 'AutoCubemapQuality', 'AutoCubemapInterval', 'WaterReflectionHighlight', 'WaterShallowDepth', 'WaterShallowIntensity', 'WaterShallowDistortion', 'WaterShallowScale', 'WaterGridScale'].forEach((name, i) => unsupported.set(0xca + i, name));

/** Invalid input retains the previous safe value. Finite out-of-range input is
 * clamped to documented legacy ranges; the authored raw value remains diagnostic.
 * These bounds are client limits, not a claim that Axis rejects wider attributes. */
export function normalizeWorldSettings(previous: WorldSettings, attributes: ReadonlyMap<number, string>, capabilities: ReadonlyMap<number, string> = new Map(), actingCitizen?: number): WorldSettings {
  const defaults = defaultWorldSettings(previous.name), warnings = new Set<string>();
  const current = { ...defaults, ...Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)) } as WorldSettings;
  const label = (id: number) => names.get(id) ?? `attribute ${id}`;
  const numeric = (id: number, fallback: number, minimum: number, maximum: number, integer = false): number => {
    const value = attributes.get(id); if (value === undefined) return fallback;
    const clean = value.trim(), n = Number(clean);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(clean) || !Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      warnings.add(`Invalid ${label(id)}; the previous safe value was retained.`); return fallback;
    }
    const bounded = Math.max(minimum, Math.min(maximum, n));
    if (bounded !== n) warnings.add(`${label(id)} was clamped to ${minimum}..${maximum}.`);
    return bounded;
  };
  const bool = (id: number, fallback: boolean): boolean => {
    const value = attributes.get(id); if (value === undefined) return fallback;
    if (/^y$/i.test(value.trim())) return true;
    if (/^n$/i.test(value.trim())) return false;
    warnings.add(`Invalid ${label(id)}; the previous safe value was retained.`); return fallback;
  };
  const text = (id: number, fallback: string): string => {
    const value = attributes.get(id); if (value === undefined) return fallback;
    if (value.length > 8192 || value.includes('\0')) { warnings.add(`Invalid ${label(id)} text was ignored.`); return fallback; }
    return value;
  };
  const color = (r: number, g: number, b: number, fallback: string): string => {
    const parts = /^#[0-9a-f]{6}$/i.test(fallback) ? [1, 3, 5].map(i => parseInt(fallback.slice(i, i + 2), 16)) : [0, 0, 0];
    return '#' + [r, g, b].map((id, i) => numeric(id, parts[i], 0, 255, true).toString(16).padStart(2, '0')).join('');
  };
  const cap = (id: number): boolean => {
    const value = capabilities.get(id); if (value === undefined) return false;
    if (/^y$/i.test(value.trim())) return true;
    if (!/^n$/i.test(value.trim())) warnings.add(`Invalid ${capabilityNames.get(id)} capability; permission was denied.`);
    return false;
  };
  const skyColors = { ...defaults.skyColors!, ...current.skyColors };
  for (const [direction, red] of [['top', A.SkyTopRed], ['bottom', A.SkyBottomRed], ['north', A.SkyNorthRed], ['south', A.SkySouthRed], ['east', A.SkyEastRed], ['west', A.SkyWestRed]] as const) skyColors[direction] = color(red, red - 1, red - 2, skyColors[direction]);
  const caretaker = cap(C.Caretaker);
  const allowFlying = bool(A.AllowFlying, current.allowFlying!), allowPassthru = bool(A.AllowPassthru, current.allowPassthru!), allowTeleport = bool(A.AllowTeleport, current.allowTeleport!);
  let fogMin = numeric(A.FogMinimum, current.fogMin, 0, 1200, true), fogMax = numeric(A.FogMaximum, current.fogMax, 50, 1200, true);
  if (fogMax <= fogMin) { warnings.add('FogMaximum must exceed FogMinimum; the previous safe range was retained.'); fogMin = current.fogMin; fogMax = current.fogMax; }
  const rawEntry = attributes.get(A.EntryPoint), entryText = text(A.EntryPoint, ''), entry = entryPosition(entryText);
  const remainder = entryText.replace(/-?\d+(?:\.\d+)?\s*[nsewa]/gi, '').trim();
  const entrySyntax = !entryText.trim() || (remainder !== entryText.trim() && (!remainder || /^-?\d+(?:\.\d+)?$/.test(remainder)));
  const validEntry = (rawEntry === undefined || (rawEntry.length <= 8192 && !rawEntry.includes('\0')))
    && entrySyntax && [entry.x, entry.y, entry.z].every(value => Number.isFinite(value) && Math.abs(value) <= 21474836.47)
    && Number.isFinite(entry.yaw) && Math.abs(entry.yaw) <= 2147483647 * Math.PI / 1800;
  if (!validEntry) warnings.add('Invalid EntryPoint coordinates; the previous entry was retained.');
  const unsupportedEnvironmentAttributes = Object.fromEntries([...unsupported].filter(([id]) => attributes.has(id)).map(([id, name]) => [name, attributes.get(id)!]));
  if (['1', 'Y', 'y'].includes(attributes.get(A.WaterUseShaders)?.trim() ?? '')) warnings.add('Shader-water attributes are retained as metadata; legacy water settings do not reproduce shader water.');
  if ([0x18, 0x1e, 0x24].some(id => attributes.get(id)?.trim())) warnings.add('Cloud-layer attributes are retained as metadata and are not normalized for rendering.');
  if (attributes.get(A.LightTexture)?.trim()) warnings.add('The light-source sprite and its alternate packed color are retained as metadata.');
  return {
    ...current, title: text(A.Title, current.title), welcome: text(A.WelcomeMessage, current.welcome), objectPath: text(A.ObjectPath, current.objectPath),
    entry: attributes.has(A.EntryPoint) && validEntry ? entry : current.entry,
    skyColors, skyColor: skyColors.top, fogEnabled: bool(A.FogEnable, current.fogEnabled!), fogTinted: bool(A.FogTinted, current.fogTinted!),
    fogColor: color(A.FogRed, A.FogGreen, A.FogBlue, current.fogColor), fogMin, fogMax,
    ambientColor: color(A.AmbientLightRed, A.AmbientLightGreen, A.AmbientLightBlue, current.ambientColor),
    lightColor: color(A.LightRed, A.LightGreen, A.LightBlue, current.lightColor),
    lightDirection: { x: numeric(A.LightX, current.lightDirection!.x, -1, 1), y: numeric(A.LightY, current.lightDirection!.y, -1, 1), z: numeric(A.LightZ, current.lightDirection!.z, -1, 1) },
    disableShadows: bool(A.DisableShadows, current.disableShadows!),
    ground: text(A.Ground, current.ground!), repeatingGround: bool(A.RepeatingGround, current.repeatingGround!), skybox: text(A.Skybox, current.skybox!), backdrop: text(A.Backdrop, current.backdrop!),
    terrainEnabled: bool(A.EnableTerrain, current.terrainEnabled), terrainOffset: numeric(A.TerrainOffset, current.terrainOffset!, -320, 320),
    terrainAmbient: numeric(A.TerrainAmbient, current.terrainAmbient!, 0, 1), terrainDiffuse: numeric(A.TerrainDiffuse, current.terrainDiffuse!, 0, 1),
    waterEnabled: bool(A.WaterEnabled, current.waterEnabled), waterLevel: numeric(A.WaterLevel, current.waterLevel, -1000, 1000),
    waterColor: color(A.WaterRed, A.WaterGreen, A.WaterBlue, current.waterColor!), waterOpacity: numeric(A.WaterOpacity, current.waterOpacity! * 255, 0, 255, true) / 255,
    waterTexture: text(A.WaterTexture, current.waterTexture!), waterMask: text(A.WaterMask, current.waterMask!), waterBottomTexture: text(A.WaterBottomTexture, current.waterBottomTexture!), waterBottomMask: text(A.WaterBottomMask, current.waterBottomMask!),
    waterUnderTerrain: bool(A.WaterUnderTerrain, current.waterUnderTerrain!), waterVisibility: numeric(A.WaterVisibility, current.waterVisibility!, 0, 1200, true),
    waterSpeed: numeric(A.WaterSpeed, current.waterSpeed!, 0, 100), waterSurfaceMove: numeric(A.WaterSurfaceMove, current.waterSurfaceMove!, -10, 10), waterWaveMove: numeric(A.WaterWaveMove, current.waterWaveMove!, -10, 10),
    allowFlying, allowPassthru, allowTeleport, allowAvatarCollision: bool(A.AllowAvatarCollision, current.allowAvatarCollision!),
    canFly: allowFlying || caretaker, canPassthru: allowPassthru || caretaker, canTeleport: allowTeleport || caretaker,
    gravity: numeric(A.Gravity, current.gravity!, -10, 10), buoyancy: numeric(A.Buoyancy, current.buoyancy!, -10, 10),
    friction: numeric(A.Friction, current.friction!, 0, 100), waterFriction: numeric(A.WaterFriction, current.waterFriction!, 0, 100),
    caretaker, owner: cap(C.Owner), canBuild: cap(C.Build) || caretaker, canSpeak: cap(C.Speak) || caretaker,
    canEditTerrain: caretaker || axisWorldRightAllows(attributes.get(A.TerrainRight), actingCitizen),
    canEject: cap(C.Eject) || caretaker, canUseEminentDomain: cap(C.EminentDomain) || caretaker, publicSpeaker: cap(C.PublicSpeaker) || caretaker,
    environmentWarnings: [...warnings].slice(0, 64), unsupportedEnvironmentAttributes,
    rawAttributes: Object.fromEntries([...attributes].filter(([id]) => !passwordIds.has(id))),
  };
}

/** Pinned WorldRightsValue: exact '*' only; comma/ASCII-space tokens, explicit
 * deny beats allow/range. No Terrain capability bit exists in this version. */
export function axisWorldRightAllows(value: string | undefined, citizen: number | undefined): boolean {
  if (!Number.isInteger(citizen) || citizen! < 0 || citizen! > 2147483647 || value === undefined || value.length > 8192 || value.includes('\0')) return false;
  if (value === '*') return true;
  let allowed = false, denied = false;
  const integer = (text: string): number | null => {
    if (!/^[+-]?\d+$/.test(text)) return null;
    const n = Number(text); return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
  };
  for (const raw of value.split(/[, ]/)) {
    const token = raw.trim(); if (!token) continue;
    if (token.includes('~')) {
      const at = token.indexOf('~'), first = integer(token.slice(0, at).trim()), last = integer(token.slice(at + 1).trim());
      // Math.Abs(int.MinValue) throws upstream; deny this malformed ACL safely.
      if (first === -2147483648 || last === -2147483648) return false;
      if (first !== null && last !== null && citizen! >= Math.abs(first) && citizen! <= Math.abs(last)) allowed = true;
    }
    const n = integer(token);
    if (n !== null) { if (n < 0 && -n === citizen) denied = true; else if (n === citizen) allowed = true; }
  }
  return allowed && !denied;
}
