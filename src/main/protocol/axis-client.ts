import { randomBytes, randomUUID } from 'node:crypto';
import type { Avatar, ClientCommand, ClientEvent, ConnectionOptions, Position, TerrainTile, WorldInfo, WorldObject, WorldSettings } from '../../shared/types';
import { blob, byte, bytes, encode, field, i32, num, str, string, type Field, type Packet } from './codec';
import { P, V } from './constants';
import { AxisTransport, browserPassword } from './transport';
import { AxisSocial } from './social';
import { defaultWorldSettings, mergeWorldSettingsPacket, normalizeWorldSettings, WORLD_ATTRIBUTE } from './world-settings';
import { LOCAL_TELEPORT_DENIED, localTeleportAllowed, sameWorld } from '../../shared/navigation';
import { assertCommand } from '../../shared/validation';
import { STREAMING_LIMITS, StreamingWindow, objectSector, objectStorageBytes, sectorFromCell, validStreamTerrain } from '../../shared/streaming';
import { TerrainPageSamples, terrainCellPage, terrainCentimetres, terrainRowPages, type TerrainEditRow, type TerrainSetCommand } from '../../shared/terrain-edit';
import { validateWorldSettingsCommand, validateWorldSettingsChanges, worldSettingValuesEqual, type WorldSettingsSetCommand, type WorldSettingsResult } from '../../shared/world-settings-edit';
export { entryPosition } from './world-settings';

/** Independent browser client derived from publicly documented protocol behavior.
 * Universe: 8ecd16abd46853f91c7af04f07d4d518f465017f (LoginHandler, WorldListHandler).
 * World: c3e7486fc153ac31b3df1a07bc2b03d20e348152 (Entry, Query, Object,
 * Terrain, Avatar, Chat handlers and PacketBuilderExtensions).
 * No proprietary aw.dll, SDK header, or original browser binary is used.
 * https://gitlab.pp16.org/axis/{universe_server,world_server}
 */
export const BROWSER_BUILD = 1682;
const radians = (tenths: number): number => tenths * Math.PI / 1800;
const angle = (rad: number): number => Math.round(rad * 1800 / Math.PI);
const key = (x: number, z: number): string => `${x},${z}`;
/** Axis sectors are centered on a multiple of 80m; cell -4 through 3 is sector 0. */
export const sectorFromMetres = (value: number): number => Math.floor((Math.floor(value / 10) + 4) / 8);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const REASONS: Record<number, string> = {
  474: 'Not available', 13: 'Invalid password', 20: 'Invalid world name or password', 32: 'Not authorized',
  27: 'World does not exist or is not currently running',
  31: 'Not logged in', 58: 'Client upgrade required', 3: 'No such citizen',
  43: 'Invalid privilege password', 310: 'No build rights',
  232: 'Not allowed by server policy', 106: 'Tourist email is required',
  204: 'The original object version no longer exists; refresh before editing',
};
function accepted(p: Packet, action: string): void {
  const reason = num(p, V.ReasonCode);
  if (reason) throw new Error(`${action}: ${REASONS[reason] ?? 'Server rejected the request'} (Axis ${reason})`);
}
export function terrainTile(packet: Packet): TerrainTile {
  const size = num(packet, V.TerrainNodeSize) * 2;
  if (!Number.isInteger(size) || size < 2 || size > 128) throw new Error('Invalid terrain node size');
  const heightsRaw = bytes(packet, V.TerrainNodeHeights), texturesRaw = bytes(packet, V.TerrainNodeTextures);
  let heights: number[], textures: number[];
  if (num(packet, V.TerrainNodeMultipleHeights)) {
    if (heightsRaw.length % 4 || heightsRaw.length > 65536) throw new Error('Invalid terrain height payload');
    heights = Array.from({ length: heightsRaw.length / 4 }, (_, i) => heightsRaw.readInt32LE(i * 4) / 100);
  } else heights = [num(packet, V.TerrainNodeHeights) / 100];
  if (num(packet, V.TerrainNodeMultipleTextures)) {
    if (texturesRaw.length % 2 || texturesRaw.length > 32768) throw new Error('Invalid terrain texture payload');
    textures = Array.from({ length: texturesRaw.length / 2 }, (_, i) => texturesRaw.readUInt16LE(i * 2));
  } else textures = [num(packet, V.TerrainNodeTextures)];
  return { pageX: num(packet, V.TerrainPageX), pageZ: num(packet, V.TerrainPageZ), nodeX: num(packet, V.TerrainNodeX), nodeZ: num(packet, V.TerrainNodeZ), size, heights, textures, sequence: num(packet, V.TerrainNodeSequence) };
}
/** A canonical property broadcast, including server owner and quantized transform. */
export function objectFromPacket(p: Packet, fallbackCell = { x: 0, z: 0 }): WorldObject {
  const id = num(p, V.ObjectId) >>> 0, cellX = num(p, V.CellX, fallbackCell.x), cellZ = num(p, V.CellZ, fallbackCell.z);
  return { id, owner: num(p, V.ObjectOwner), model: string(p, V.ObjectModel), description: string(p, V.ObjectDescription), action: string(p, V.ObjectAction),
    x: (cellX * 1000 + num(p, V.ObjectX)) / 100, y: num(p, V.ObjectY) / 100, z: (cellZ * 1000 + num(p, V.ObjectZ)) / 100,
    yaw: radians(num(p, V.ObjectYaw)), pitch: radians(num(p, V.ObjectTilt)), roll: radians(num(p, V.ObjectRoll)),
    type: num(p, V.ObjectType), data: bytes(p, V.ObjectData).toString('base64'), cellX, cellZ };
}
export function sameObjectSnapshot(a: WorldObject, b: WorldObject): boolean {
  const keys: Array<keyof WorldObject> = ['id', 'owner', 'model', 'description', 'action', 'x', 'y', 'z', 'yaw', 'pitch', 'roll'];
  return keys.every(key => a[key] === b[key]) && (a.type ?? 0) === (b.type ?? 0) && (a.data ?? '') === (b.data ?? '');
}
type ObjectRecord = { object: WorldObject; number: number; sequence: number; bytes?: number };
type TerrainPage = { pageX: number; pageZ: number; nodes: Map<string, number>; cells: number; samples: TerrainPageSamples; complete: boolean };
type TerrainTarget = { pageX: number; pageZ: number; readback?: boolean };
type TerrainRequest = TerrainTarget & { key: string; sequence: number; began: boolean; replaced: boolean; valid: boolean; obsolete: boolean; completed?: boolean };
type TerrainEdit = { world: AxisTransport; generation: number; phase: 'preparing' | 'sending' | 'reading' };
type WorldSettingsEdit = {
  command: WorldSettingsSetCommand; world: AxisTransport; generation: number;
  timer: ReturnType<typeof setTimeout>; resolve: () => void; observed?: Map<number, string>;
};
/** The server accepts String fields, not numeric wire fields. A readback must
 * actually contain valid text; the cumulative normalized cache is not evidence. */
function settingsReadbackText(field: Field): string | undefined {
  if (field.type !== 4 || field.data.length > 8192) return undefined;
  const text = field.data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(field.data)) return undefined;
  const value = text.replace(/\0+$/, '');
  return value.includes('\0') ? undefined : value;
}
function settingsReadbackFields(packet: Packet): Map<number, string> | undefined {
  const values = new Map<number, string>(), ids = new Set<number>();
  for (const field of packet.fields) {
    if (ids.has(field.id)) return undefined;
    ids.add(field.id);
    const value = settingsReadbackText(field);
    if (value !== undefined) values.set(field.id, value);
  }
  return values;
}
/** Trusted host policy, never renderer-controlled. Throw synchronously to reject
 * a Universe-advertised World endpoint before any socket/nonce is sent there. */
export interface AxisClientPolicy {
  authorizeWorldConnection?: (target: Readonly<{ host: string; port: number; tls: boolean }>) => void;
}
export class AxisClient {
  private universe?: AxisTransport;
  private social?: AxisSocial;
  private world?: AxisTransport;
  private worldReady = false;
  private options?: Omit<ConnectionOptions, 'password'>;
  private worlds = new Map<string, WorldInfo>();
  private avatars = new Map<number, Avatar>();
  private objects = new Map<number, ObjectRecord>();
  private attributes = new Map<number, string>();
  private capabilities = new Map<number, string>();
  private teleportRuleReceived = false;
  private sectors = new Map<string, number>();
  private terrainSequences = new Map<string, number>();
  private terrainPages = new Map<string, TerrainPage>();
  private terrainPending = new Map<string, TerrainTarget>();
  private terrainRunning?: Promise<void>;
  private terrainCurrent?: TerrainRequest;
  private terrainFailed = false;
  private terrainEdit?: TerrainEdit;
  private terrainEditFailed = false;
  private terrainReadbacks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private streaming = new StreamingWindow();
  private objectBytes = 0;
  private streamingWarnings = new Set<string>();
  private incompleteSectors = new Set<string>();
  private liveSectors = new Set<string>();
  private queryPending?: { x: number; z: number };
  private queryRunning?: Promise<void>;
  private queryFailed = false;
  private queryCursor?: Map<string, number>;
  private cell?: { x: number; z: number; sequence: number; prior: Set<number>; seen: Set<number> };
  private settings?: WorldSettings;
  private worldSettingsEntryId = '';
  private worldSettingsRevision = 0;
  private worldSettingsBlocked = false;
  private worldSettingsEdit?: WorldSettingsEdit;
  private timer?: ReturnType<typeof setInterval>;
  private session = 0;
  private citizen = 0;
  private name = '';
  private serial = randomBytes(4).readUInt32LE();
  private position: Position = { x: 0, y: 0, z: 0, yaw: 0 };
  private avatarType = 0;
  private gesture = 0;
  private generation = 0;
  private worldGeneration = 0;
  private callback = 0;
  private mutationNumbers = new Set<number>();
  private mutationReferences = new Map<number, number>();
  private pendingMutations = new Map<number, Set<number>>();
  private pinnedObjects = new Map<number, number>();
  private deferredEvictions = new Set<number>();
  constructor(private onEvent: (event: ClientEvent) => void, private readonly policy: AxisClientPolicy = {}) {}

  async command(command: ClientCommand): Promise<void> {
    try {
      switch (command.type) {
        case 'connect': return await this.connect(command.options);
        case 'disconnect': return this.disconnect();
        case 'enter': {
          assertCommand(command);
          if (command.origin === 'action' && (!this.worldReady || !this.world || !this.settings || !sameWorld(command.fromWorld, this.settings.name) || command.session !== this.session))
            throw new Error('Object travel source world or session changed. Activate the object again.');
          return await this.enter(command.world, command.position, command.origin === 'action' ? 'action' : 'user');
        }
        case 'move': this.move(command.position); return;
        case 'avatar-set': this.submitAvatar(command.avatar, command.gesture ?? 0); return;
        case 'avatar-select': this.requireAvatarScope(command, 'Avatar selection'); this.submitAvatar(command.avatar, 0); return;
        case 'gesture': this.changeGesture(command); return;
        case 'chat': this.chat(command.text, command.whisperTo); return;
        case 'contacts-list': case 'contact-add': case 'contact-delete': case 'contact-change': case 'contact-confirm':
        case 'telegram-fetch': case 'telegram-send':
          if (!this.social) throw new Error('Sign in before using contacts or telegrams');
          return await this.social.command(command);
        case 'query': return await this.query(command.x, command.z);
        case 'terrain-set': assertCommand(command); return await this.setTerrain(command);
        case 'world-settings-set': return await this.setWorldSettings(command);
        case 'object-add': return await this.editObject(P.ObjectAdd, command.object, undefined, command.requestId);
        case 'object-change': return await this.editObject(P.ObjectChange, command.object, command.previous, command.requestId);
        case 'object-delete': return await this.deleteObject(command.object, command.requestId);
        case 'object-click': this.requireWorld().send(P.ObjectClick, [i32(V.ObjectId, command.object.id), i32(V.CellX, command.object.cellX ?? Math.floor(command.object.x / 10)), i32(V.CellZ, command.object.cellZ ?? Math.floor(command.object.z / 10)), i32(V.ObjectNumber, this.objects.get(command.object.id)?.number ?? 0)]); return;
      }
    } catch (error) { this.onEvent({ type: 'error', message: errorText(error) }); throw error; }
  }
  disconnect(): void {
    this.generation++; this.worldGeneration++;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    const u = this.universe, w = this.world; this.universe = undefined; this.world = undefined;
    this.social?.close(); this.social = undefined;
    u?.close(); w?.close(); this.clearWorld(); this.session = 0; this.citizen = 0; this.options = undefined;
    this.worlds.clear(); this.onEvent({ type: 'worlds', worlds: [] });
    this.status('disconnected', 'Disconnected');
  }
  private status(phase: Extract<ClientEvent, { type: 'status' }>['phase'], message: string): void { this.onEvent({ type: 'status', phase, message }); }
  private clearWorld(): void {
    this.finishWorldSettingsEdit('uncertain', 'World entry ended before settings readback. The write may have reached the server; no retry or rollback was sent.');
    this.worldSettingsEntryId = ''; this.worldSettingsRevision = 0; this.worldSettingsBlocked = false;
    this.unload([...this.objects.keys()], [...this.terrainPages.values()], 'reset');
    this.worldReady = false; this.gesture = 0; this.teleportRuleReceived = false;
    for (const session of this.avatars.keys()) this.onEvent({ type: 'avatar-delete', session });
    this.avatars.clear(); this.objects.clear(); this.attributes.clear(); this.capabilities.clear(); this.sectors.clear();
    this.rejectTerrainReadbacks(new Error('World changed before terrain readback completed'));
    this.terrainEdit = undefined; this.terrainEditFailed = false;
    this.terrainSequences.clear(); this.terrainPages.clear(); this.terrainPending.clear(); this.terrainCurrent = undefined; this.terrainRunning = undefined; this.terrainFailed = false;
    this.queryPending = undefined; this.queryRunning = undefined; this.queryFailed = false; this.queryCursor = undefined; this.liveSectors.clear(); this.incompleteSectors.clear();
    this.pendingMutations.clear(); this.pinnedObjects.clear(); this.deferredEvictions.clear(); this.mutationReferences.clear(); this.mutationNumbers.clear();
    this.objectBytes = 0; this.streaming = new StreamingWindow(); this.streamingWarnings.clear(); this.settings = undefined; this.cell = undefined;
    this.onEvent({ type: 'objects', objects: [], replace: true });
  }
  private unload(objectIds: number[], terrainPages: Array<{ pageX: number; pageZ: number }>, reason: Extract<ClientEvent, { type: 'stream-unload' }>['reason']): void {
    if (this.settings && (objectIds.length || terrainPages.length)) this.onEvent({ type: 'stream-unload', world: this.settings.name, session: this.session, objectIds, terrainPages: terrainPages.map(({ pageX, pageZ }) => ({ pageX, pageZ })), reason });
  }
  private streamingWarning(kind: string, message: string): void {
    if (this.streamingWarnings.has(kind)) return;
    this.streamingWarnings.add(kind); this.onEvent({ type: 'error', message });
  }
  private removeCachedObject(id: number, incomplete = false): void {
    const record = this.objects.get(id); if (!record) return;
    this.objectBytes = Math.max(0, this.objectBytes - (record.bytes ?? objectStorageBytes(record.object))); this.objects.delete(id); this.deferredEvictions.delete(id);
    if (incomplete) {
      const sector = objectSector(record.object), k = key(sector.x, sector.z); this.sectors.delete(k);
      if (this.streaming.hasSector(sector.x, sector.z)) this.incompleteSectors.add(k);
    }
  }
  private trimObjectBudget(): void {
    if (this.objects.size <= STREAMING_LIMITS.maxObjects && this.objectBytes <= STREAMING_LIMITS.maxRetainedObjectBytes) return;
    const evicted: number[] = [];
    const candidates = [...this.objects].filter(([id]) => !this.pinnedObjects.has(id)).sort((a, b) => this.streaming.objectDistance(b[1].object) - this.streaming.objectDistance(a[1].object));
    for (const [id] of candidates) {
      if (this.objects.size <= STREAMING_LIMITS.maxObjects && this.objectBytes <= STREAMING_LIMITS.maxRetainedObjectBytes) break;
      this.removeCachedObject(id, true); evicted.push(id);
    }
    this.unload(evicted, [], 'budget');
    this.streamingWarning('objects', 'Property streaming budget reached; some objects are not retained. Move away and revisit to reload them.');
  }
  private updateStreamingWindow(x: number, z: number): void {
    const before = key(this.streaming.sector.x, this.streaming.sector.z); this.streaming.set(x, z);
    if (before !== key(this.streaming.sector.x, this.streaming.sector.z)) this.streamingWarnings.clear();
    const evicted: number[] = [], pages: TerrainPage[] = [];
    for (const [id, record] of this.objects) if (this.streaming.objectDistance(record.object) > STREAMING_LIMITS.sectorRadius && !this.pinnedObjects.has(id)) { this.removeCachedObject(id, true); evicted.push(id); }
    for (const k of [...this.sectors.keys(), ...this.incompleteSectors]) {
      const [sx, sz] = k.split(',').map(Number);
      if (!this.streaming.hasSector(sx, sz)) { this.sectors.delete(k); this.incompleteSectors.delete(k); }
    }
    for (const [k, page] of this.terrainPages) if (!this.streaming.hasPage(page.pageX, page.pageZ)) { pages.push(page); this.terrainPages.delete(k); this.terrainSequences.delete(k); }
    for (const [k, page] of this.terrainPending) if (!this.streaming.hasPage(page.pageX, page.pageZ)) this.terrainPending.delete(k);
    if (this.terrainCurrent && !this.streaming.hasPage(this.terrainCurrent.pageX, this.terrainCurrent.pageZ)) this.terrainCurrent.obsolete = true;
    if ([...this.terrainReadbacks.keys()].some(k => { const [x, z] = k.split(',').map(Number); return !this.streaming.hasPage(x, z); }))
      this.rejectTerrainReadbacks(new Error('Terrain edit readback left the retained area; its outcome cannot be verified'));
    this.unload(evicted, pages, 'distance'); this.trimObjectBudget();
  }
  private async connect(options: ConnectionOptions): Promise<void> {
    if (options.tourist && !options.email?.trim()) throw new Error('Tourist sign-in requires an email address');
    this.disconnect(); const generation = this.generation;
    const { password, ...rest } = options; this.options = rest;
    this.status('connecting', `Connecting to ${options.host}:${options.port}`);
    const u = new AxisTransport(p => { if (this.universe === u) this.universePacket(p); }, error => {
      if (this.universe !== u) return;
      this.disconnect(); if (error) this.onEvent({ type: 'error', message: error.message });
    }); this.universe = u;
    this.social = new AxisSocial(u, this.onEvent, () => ({ citizen: this.citizen, name: this.name }));
    try {
      await u.connect(options.host.trim(), options.port, options.tls);
      if (generation !== this.generation) throw new Error('Connection superseded');
      this.status('authenticating', 'Signing in to the universe');
      const username = options.tourist ? `"${options.username.replace(/"/g, '').trim()}"` : options.username.trim();
      const p = await u.request(P.Login, [i32(V.UserType, 2), i32(V.ClientBuild, BROWSER_BUILD), i32(V.ClientVersion, 62), str(V.LoginUsername, username), str(V.LoginEmail, options.email?.trim() ?? ''), blob(V.EncodedPassword, browserPassword(password)), i32(V.VolumeSerial, this.serial), str(V.LoginApplication, 'Wayfarer')]);
      accepted(p, 'Sign in'); this.session = num(p, V.SessionId); this.citizen = num(p, V.CitizenNumber); this.name = string(p, V.CitizenName, username);
      if (this.session <= 0) throw new Error('Universe did not issue a session');
      this.onEvent({ type: 'login', citizen: this.citizen, session: this.session, name: this.name });
      this.status('connected', `Signed in as ${this.name}`);
      await u.request(P.WorldList, [], P.WorldListResult);
      let ticks = 0;
      this.timer = setInterval(() => {
        if (this.universe !== u) return;
        this.onEvent({ type: 'stats', received: u.received + (this.world?.received ?? 0), sent: u.sent + (this.world?.sent ?? 0) });
        if (++ticks % 15 === 0) u.send(P.WorldList);
      }, 1000); this.timer.unref();
      // Starting world is optional: a blank field means Universe-only login,
      // even when the Universe advertises a default world in its attributes.
      const startingWorld = options.world?.trim();
      if (startingWorld) await this.enter(startingWorld);
    } catch (error) { if (this.universe === u) this.disconnect(); throw error; }
  }
  private universePacket(p: Packet): void {
    if (this.social?.receive(p)) return;
    if (p.type === P.WorldList) {
      const name = string(p, V.WorldListName), status = ['unknown', 'public', 'private', 'stopped'][num(p, V.WorldListStatus)] ?? 'unknown';
      if (name) this.worlds.set(name.toLowerCase(), { name, status, users: num(p, V.WorldListUsers) });
    } else if (p.type === P.WorldListResult) {
      this.onEvent({ type: 'worlds', worlds: [...this.worlds.values()].sort((a, b) => a.name.localeCompare(b.name)) });
      if (num(p, V.WorldListMore)) this.universe?.send(P.WorldList);
    } else if (p.type === P.ChatMessage || p.type === P.ConsoleMessage) this.receiveChat(p);
  }
  private async enter(name: string, destination?: Position, origin: 'user' | 'action' | 'server' = 'user'): Promise<void> {
    const u = this.universe, options = this.options;
    if (!u || !options || !this.session) throw new Error('Sign in before entering a world');
    name = name.trim();
    if (origin === 'user' && this.worldReady && sameWorld(name, this.settings?.name) && !localTeleportAllowed(this.settings))
      throw new Error(LOCAL_TELEPORT_DENIED);
    const generation = ++this.worldGeneration, previous = this.world; this.world = undefined; previous?.close(); this.clearWorld();
    this.status('entering', `Entering ${name}`);
    let lookup: Packet, host: string, port: number;
    try {
      lookup = await u.request(P.WorldLookup, [str(V.WorldName, name)], P.WorldLookup, p => string(p, V.WorldName).toLowerCase() === name.toLowerCase()); accepted(lookup, 'Find world');
      if (generation !== this.worldGeneration) throw new Error('World entry superseded');
      const ip = bytes(lookup, V.WorldAddress); if (ip.length !== 4) throw new Error('Universe supplied an invalid world address');
      host = ip.every(n => n === 0) ? options.host : [...ip].join('.'); port = num(lookup, V.WorldPort);
    } catch (error) {
      // The source world has already been left, but the Universe remains usable.
      // Do not let an older lookup reset a newer entry or intentional disconnect.
      if (generation === this.worldGeneration && this.universe === u) this.status('connected', 'World lookup failed');
      throw error;
    }
    try { this.policy.authorizeWorldConnection?.({ host, port, tls: options.tls }); }
    catch (error) { this.status('connected', 'World destination blocked by host policy'); throw error; }
    const w = new AxisTransport(p => { if (this.world === w) this.worldPacket(p); }, error => {
      if (this.world !== w) return; this.world = undefined; this.clearWorld(); this.status('connected', 'World disconnected');
      if (error) this.onEvent({ type: 'error', message: error.message });
    }); this.world = w;
    this.worldSettingsEntryId = randomUUID();
    this.settings = this.defaultSettings(string(lookup, V.WorldName, name));
    try {
      await w.connect(host, port, options.tls);
      if (generation !== this.worldGeneration || this.world !== w) throw new Error('World entry superseded');
      const response = await w.request(P.Enter, [str(V.WorldName, name), blob(V.WorldUserNonce, bytes(lookup, V.WorldUserNonce)), i32(V.SessionId, this.session), i32(V.LoginId, this.citizen), i32(V.VolumeSerial, this.serial), i32(V.WorldEventMask, 0x800005ff), byte(V.WorldEnterGlobal, 0)]); accepted(response, 'Enter world');
      if (generation !== this.worldGeneration) throw new Error('World entry superseded');
      this.worldReady = true;
      const entry = this.settings?.entry ?? { x: 0, y: 0, z: 0, yaw: 0 };
      // Official World Features explicitly specifies 0N 0W even for manual
      // entry from another world when local teleporting is disabled. It does
      // not define the forced altitude/heading: Wayfarer uses the authored
      // entry's Y/yaw/pitch, not untrusted requested vertical coordinates.
      this.position = origin === 'user' && !localTeleportAllowed(this.settings)
        ? { ...entry, x: 0, z: 0 } : { ...(destination ?? entry) };
      this.updateStreamingWindow(this.position.x, this.position.z);
      this.onEvent({ type: 'teleport', position: this.position }); this.submitAvatar(this.avatarType, this.gesture);
      w.send(P.Listen, [i32(V.ChatChannel, 1)]);
      this.status('online', `Connected to ${name}`);
      await this.query(this.position.x, this.position.z);
    } catch (error) { if (this.world === w) { this.world = undefined; w.close(); this.clearWorld(); this.status('connected', 'World entry failed'); } throw error; }
  }
  private defaultSettings(name: string): WorldSettings {
    // Published defaults are not an authoritative permission packet. Pinned Axis
    // sends attributes then capabilities before Enter success; reordered or
    // incomplete peers must not get a permissive manual-navigation window.
    return { ...defaultWorldSettings(name), canTeleport: false, editContext: this.worldSettingsContext() };
  }
  private worldSettingsContext(): NonNullable<WorldSettings['editContext']> {
    return { entryId: this.worldSettingsEntryId, revision: this.worldSettingsRevision, blocked: this.worldSettingsBlocked };
  }
  private updateSettings(p: Packet): void {
    if (!this.settings) return;
    const capabilities = p.type === P.Capabilities;
    if (!capabilities) this.worldSettingsRevision++;
    const warnings = mergeWorldSettingsPacket(capabilities ? this.capabilities : this.attributes, p, capabilities);
    if (/^[yn]$/i.test(this.attributes.get(WORLD_ATTRIBUTE.AllowTeleport)?.trim() ?? '')) this.teleportRuleReceived = true;
    this.settings = normalizeWorldSettings(this.settings, this.attributes, this.capabilities, this.citizen);
    if (!this.teleportRuleReceived && this.settings.caretaker !== true) this.settings.canTeleport = false;
    if (warnings.length) this.settings.environmentWarnings = [...new Set([...this.settings.environmentWarnings!, ...warnings])].slice(0, 64);
    this.settings.editContext = this.worldSettingsContext();
    this.onEvent({ type: 'world', settings: this.settings });
    this.observeWorldSettingsEdit(p);
  }
  private async setWorldSettings(input: WorldSettingsSetCommand): Promise<void> {
    validateWorldSettingsCommand(input);
    const command: WorldSettingsSetCommand = { ...input, changes: input.changes.map(change => ({ ...change })) };
    const world = this.world;
    if (!world || !this.worldReady || !this.settings) throw new Error('Enter a world before editing its settings.');
    if (!sameWorld(command.world, this.settings.name) || command.session !== this.session || command.entryId !== this.worldSettingsEntryId)
      throw new Error('World settings entry or session changed. Reopen the settings editor.');
    if (this.settings.caretaker !== true) throw new Error('Caretaker permission is required to edit world settings.');
    if (this.worldSettingsBlocked) throw new Error('World settings editing is paused until world re-entry after an uncertain or conflicting write.');
    if (this.worldSettingsEdit) throw new Error('A world settings write is already pending.');
    if (command.revision !== this.worldSettingsRevision) throw new Error('World settings changed since this draft was opened. Review the current values.');
    for (const change of command.changes) {
      if ((this.attributes.get(change.id) ?? null) !== change.before) throw new Error('World settings baseline changed. Review the current values.');
    }
    validateWorldSettingsChanges(command.changes, this.attributes);
    command.changes = command.changes.filter(change => change.before === null || !worldSettingValuesEqual(change.id, change.before, change.value));
    if (!command.changes.length) throw new Error('No world settings changes to send.');
    const fields = command.changes.map(change => str(change.id, change.value));
    // A one-character String alone makes a 16-byte legacy frame, whose length
    // collides with the v4 marker. Pinned Axis accepts explicit v4 and upgrades
    // replies (NetConnection.ProcessPacket); do not add filler or alter values.
    const legacySize = 10 + fields.reduce((size, field) => size + 4 + field.data.length, 0);
    const version = world.version !== 4 && legacySize === 16 ? 4 : world.version;
    // Fail local serialization before reserving/dispatching a mutation. Never
    // send an empty AttributeChange as a synthetic read-only query.
    encode(P.AttributeChange, fields, version);
    await new Promise<void>(resolve => {
      const edit: WorldSettingsEdit = { command, world, generation: this.worldGeneration, resolve,
        timer: setTimeout(() => {
          if (this.worldSettingsEdit === edit) this.finishWorldSettingsEdit('uncertain', 'No complete settings readback arrived. The write may have reached the server; re-enter before another edit.');
        }, 12000) };
      this.worldSettingsEdit = edit;
      try { world.send(P.AttributeChange, fields, version); }
      catch {
        if (this.worldSettingsEdit === edit) this.finishWorldSettingsEdit('uncertain', 'Settings dispatch failed and its outcome is uncertain. No retry or rollback was sent; re-enter before another edit.');
      }
    });
  }
  private observeWorldSettingsEdit(packet: Packet): void {
    const edit = this.worldSettingsEdit;
    if (!edit || edit.world !== this.world || edit.generation !== this.worldGeneration || edit.command.entryId !== this.worldSettingsEntryId) return;
    if (packet.type === P.Attributes || packet.type === P.AttributeChange) {
      edit.observed = undefined;
      if (packet.type !== P.Attributes) return;
      const values = settingsReadbackFields(packet);
      if (values && edit.command.changes.every(change => values.has(change.id))) edit.observed = values;
      return;
    }
    if (packet.type !== P.Capabilities || !edit.observed) return;
    const capabilities = settingsReadbackFields(packet);
    // Pinned Axis always appends all seven capabilities to its full Attributes
    // envelope. An incomplete or malformed pair cannot establish readback.
    if (!capabilities || ![0, 1, 2, 3, 4, 5, 6].every(id => /^[YN]$/i.test(capabilities.get(id) ?? ''))) {
      edit.observed = undefined; return;
    }
    const matches = edit.command.changes.every(change => worldSettingValuesEqual(change.id, edit.observed!.get(change.id)!, change.value));
    this.finishWorldSettingsEdit(matches ? 'observed' : 'conflict', matches
      ? 'Requested values were observed in a server settings broadcast. This is not an atomic or durable save acknowledgement.'
      : 'Server settings differ from this draft. The write may still have reached the server; no retry or rollback was sent. Re-enter before another edit.');
  }
  private finishWorldSettingsEdit(status: WorldSettingsResult['status'], message: string): void {
    const edit = this.worldSettingsEdit;
    if (!edit) return;
    this.worldSettingsEdit = undefined; clearTimeout(edit.timer);
    if (status !== 'observed') this.worldSettingsBlocked = true;
    if (this.settings && edit.command.entryId === this.worldSettingsEntryId) {
      this.settings = { ...this.settings, editContext: this.worldSettingsContext() };
      this.onEvent({ type: 'world', settings: this.settings });
    }
    this.onEvent({ type: 'world-settings-result', requestId: edit.command.requestId, world: edit.command.world,
      session: edit.command.session, entryId: edit.command.entryId, status, message });
    edit.resolve();
  }
  private worldPacket(p: Packet): void {
    if (this.queryFailed && [P.CellBegin, P.CellUpdate, P.CellEnd].includes(p.type as never)) return;
    if (p.type === P.Attributes || p.type === P.AttributeChange || p.type === P.Capabilities) this.updateSettings(p);
    else if (p.type === P.CellBegin) {
      const x = num(p, V.CellX), z = num(p, V.CellZ);
      this.cell = { x, z, sequence: num(p, V.CellSequence) >>> 0, prior: new Set([...this.objects].filter(([, r]) => r.object.cellX === x && r.object.cellZ === z).map(([id]) => id)), seen: new Set() };
    } else if (p.type === P.CellEnd) {
      if (this.cell) {
        for (const id of this.cell.prior) if (!this.cell.seen.has(id) && this.objects.has(id)) { this.removeCachedObject(id); this.onEvent({ type: 'object-delete', id }); }
        const sx = sectorFromCell(this.cell.x), sz = sectorFromCell(this.cell.z), sector = key(sx, sz);
        if (this.queryCursor?.has(sector)) this.queryCursor.set(sector, Math.max(this.cell.sequence, this.queryCursor.get(sector) ?? 0));
        if (this.streaming.hasSector(sx, sz) && !this.incompleteSectors.has(sector)) this.sectors.set(sector, Math.max(this.cell.sequence, this.sectors.get(sector) ?? 0));
        this.cell = undefined;
      }
    } else if ([P.CellUpdate, P.ObjectAdd, P.ObjectChange].includes(p.type as never)) this.receiveObject(p);
    else if (p.type === P.ObjectDelete) {
      const id = num(p, V.ObjectId) >>> 0, old = this.objects.get(id);
      // Axis emits Add(new-number) then Delete(old-number) for a move. The stable
      // database ID is shared by both; old-number deletion must not erase new data.
      if (old && field(p, V.ObjectNumber) && old.number !== (num(p, V.ObjectNumber) >>> 0)) return;
      this.removeCachedObject(id); this.onEvent({ type: 'object-delete', id });
    } else if (p.type === P.AvatarAdd || p.type === P.AvatarChange) this.receiveAvatar(p);
    else if (p.type === P.AvatarDelete) { const session = num(p, V.AvatarSession); this.avatars.delete(session); this.onEvent({ type: 'avatar-delete', session }); }
    else if (p.type === P.ChatMessage || p.type === P.ConsoleMessage) this.receiveChat(p);
    else if (p.type === P.TerrainData) this.receiveTerrain(p);
    else if (p.type === P.TerrainBegin && this.terrainCurrent) {
      this.terrainCurrent.began = key(num(p, V.TerrainPageX), num(p, V.TerrainPageZ)) === this.terrainCurrent.key;
      if (!this.terrainCurrent.began) this.terrainCurrent.valid = false;
    }
    else if (p.type === P.TerrainEnd && this.terrainCurrent) this.finishTerrain(p);
    else if (p.type === P.TerrainChanged) {
      const x = num(p, V.TerrainPageX), z = num(p, V.TerrainPageZ), k = key(x, z); this.terrainSequences.delete(k);
      const cached = this.terrainPages.get(k); if (cached) { cached.complete = false; this.terrainPageEvent(x, z, 0, false); }
      if (!this.terrainFailed && this.streaming.hasPage(x, z)) {
        this.terrainPending.set(k, { pageX: x, pageZ: z, readback: this.terrainPending.get(k)?.readback }); this.startTerrainWorker();
      }
    } else if (p.type === P.Teleport) {
      const world = string(p, V.TeleportWorld), position = { x: num(p, V.TeleportX) / 100, y: num(p, V.TeleportY) / 100, z: num(p, V.TeleportZ) / 100, yaw: radians(num(p, V.TeleportYaw)) };
      if (world && (!world.trim() || world.length > 64 || world.includes('\0'))) {
        this.onEvent({ type: 'error', message: 'The server supplied an invalid teleport world.' }); return;
      }
      // Axis AvatarHandler authorizes this packet before forwarding it. A
      // private route preserves that authority without exposing a command flag.
      if (world && !sameWorld(world, this.settings?.name)) {
        void this.enter(world, position, 'server').catch(error => this.onEvent({ type: 'error', message: errorText(error) }));
      } else this.onEvent({ type: 'teleport', position });
    }
  }
  private receiveObject(p: Packet): void {
    const object = objectFromPacket(p, this.cell), id = object.id;
    if (this.cell?.prior.has(id)) this.cell.seen.add(id);
    const number = num(p, V.ObjectNumber) >>> 0, reference = this.mutationReferences.get(number);
    if (reference !== undefined && num(p, V.SessionId) === this.session) this.pinObject(reference, id);
    if (this.streaming.objectDistance(object) > STREAMING_LIMITS.sectorRadius && !this.pinnedObjects.has(id)) {
      if (this.objects.has(id)) { this.removeCachedObject(id, true); this.unload([id], [], 'distance'); } return;
    }
    const storage = objectStorageBytes(object);
    if (storage > STREAMING_LIMITS.maxObjectBytes) {
      const sector = objectSector(object), k = key(sector.x, sector.z); this.sectors.delete(k);
      if (this.streaming.hasSector(sector.x, sector.z)) this.incompleteSectors.add(k);
      if (this.objects.has(id)) { this.removeCachedObject(id, true); this.unload([id], [], 'budget'); }
      this.streamingWarning('objects', 'Property streaming budget reached; an oversized object was not retained.'); return;
    }
    this.removeCachedObject(id);
    this.objects.set(id, { object, number, sequence: num(p, V.CellSequence) >>> 0, bytes: storage }); this.objectBytes += storage;
    this.trimObjectBudget();
    if (this.objects.has(id)) this.onEvent({ type: 'objects', objects: [object] });
  }
  private replaceTerrainPage(request: TerrainRequest): TerrainPage {
    if (this.terrainPages.has(request.key)) this.unload([], [request], 'refresh');
    const page: TerrainPage = { pageX: request.pageX, pageZ: request.pageZ, nodes: new Map<string, number>(), cells: 0, samples: new TerrainPageSamples(), complete: false };
    this.terrainPages.set(request.key, page); this.terrainSequences.delete(request.key); request.replaced = true; return page;
  }
  private receiveTerrain(packet: Packet): void {
    const request = this.terrainCurrent;
    if (!request || request.obsolete || !request.began || key(num(packet, V.TerrainPageX), num(packet, V.TerrainPageZ)) !== request.key || !this.streaming.hasPage(request.pageX, request.pageZ)) return;
    let tile: TerrainTile;
    try { tile = terrainTile(packet); } catch { request.valid = false; this.streamingWarning('terrain', 'Invalid terrain data was ignored; revisit this page to retry.'); return; }
    if (!validStreamTerrain(tile)) { request.valid = false; this.streamingWarning('terrain', 'Invalid terrain node bounds or sample counts were ignored.'); return; }
    const page = request.replaced ? this.terrainPages.get(request.key)! : this.replaceTerrainPage(request);
    const k = key(tile.nodeX, tile.nodeZ), cells = page.cells - (page.nodes.get(k) ?? 0) + tile.size * tile.size;
    if ((!page.nodes.has(k) && page.nodes.size >= STREAMING_LIMITS.maxTerrainNodesPerPage) || cells > STREAMING_LIMITS.maxTerrainCellsPerPage) {
      request.valid = false; this.streamingWarning('terrain', 'Terrain streaming budget reached; excess nodes were ignored. Revisit this page to retry.'); return;
    }
    try { page.samples.write(tile); } catch { request.valid = false; this.streamingWarning('terrain', 'Terrain samples could not be represented exactly.'); return; }
    page.nodes.set(k, tile.size * tile.size); page.cells = cells; page.complete = false;
    this.onEvent({ type: 'terrain', tile });
  }
  private finishTerrain(packet: Packet): void {
    const request = this.terrainCurrent!;
    if (request.obsolete || !this.streaming.hasPage(request.pageX, request.pageZ)) return;
    if (!request.began) { request.valid = false; this.terrainSequences.delete(request.key); this.terrainPageEvent(request.pageX, request.pageZ, 0, false); return; }
    const sequence = num(packet, V.TerrainNodeSequence);
    // A changed page can become empty: no Data packet is required to clear it.
    if (!request.replaced && (sequence !== request.sequence || !this.terrainPages.has(request.key))) this.replaceTerrainPage(request);
    if (request.valid && !this.terrainPending.has(request.key)) this.terrainSequences.set(request.key, sequence);
    else this.terrainSequences.delete(request.key);
    request.completed = request.valid && num(packet, V.TerrainComplete) === 1 && !this.terrainPending.has(request.key);
    const page = this.terrainPages.get(request.key); if (page) page.complete = request.completed;
    this.terrainPageEvent(request.pageX, request.pageZ, sequence, request.completed);
  }
  private terrainPageEvent(pageX: number, pageZ: number, sequence: number, complete: boolean): void {
    if (this.settings) this.onEvent({ type: 'terrain-page', world: this.settings.name, session: this.session, pageX, pageZ, sequence, complete });
  }
  private rejectTerrainReadbacks(error: Error): void {
    for (const readback of this.terrainReadbacks.values()) readback.reject(error);
    this.terrainReadbacks.clear();
  }
  private queueTerrainWindow(): void {
    if (!this.settings?.terrainEnabled || this.terrainFailed) return;
    for (const page of this.streaming.pages()) {
      const k = key(page.pageX, page.pageZ);
      if (this.terrainCurrent?.key !== k || this.terrainCurrent.obsolete) this.terrainPending.set(k, { ...page, readback: this.terrainPending.get(k)?.readback });
    }
    this.startTerrainWorker();
  }
  private startTerrainWorker(): void {
    if (this.terrainRunning || this.terrainFailed || !this.world || !this.settings?.terrainEnabled || (this.terrainEdit && this.terrainEdit.phase !== 'reading')) return;
    const w = this.world, generation = this.worldGeneration;
    const work = (async () => {
      while (this.world === w && generation === this.worldGeneration && this.settings?.terrainEnabled && this.terrainPending.size && (!this.terrainEdit || this.terrainEdit.phase === 'reading')) {
        const [k, page] = this.terrainPending.entries().next().value!; this.terrainPending.delete(k);
        if (!this.streaming.hasPage(page.pageX, page.pageZ)) continue;
        const request: TerrainRequest = { ...page, key: k, sequence: page.readback ? -1 : this.terrainSequences.get(k) ?? -1, began: false, replaced: false, valid: true, obsolete: false };
        this.terrainCurrent = request;
        try {
          await w.request(P.TerrainQuery, [i32(V.TerrainPageX, page.pageX), i32(V.TerrainPageZ, page.pageZ), i32(V.TerrainNodeSequence, request.sequence)], P.TerrainEnd);
          if (page.readback) {
            const waiter = this.terrainReadbacks.get(k);
            if (!request.completed || !request.replaced || request.obsolete) {
              if (waiter) throw new Error('Terrain readback was incomplete or changed while it was loading');
            } else { this.terrainReadbacks.delete(k); waiter?.resolve(); }
          }
        } catch (error) {
          if (this.world !== w || generation !== this.worldGeneration) return;
          // End packets have no page ID. After a timeout, continuing would risk
          // matching a late End to the next page. Pause until world re-entry.
          this.terrainFailed = true; this.terrainPending.clear();
          this.rejectTerrainReadbacks(new Error(`Terrain readback failed: ${errorText(error)}`));
          this.streamingWarning('terrain-stopped', `Terrain streaming paused until world re-entry: ${errorText(error)}`); return;
        } finally { if (this.terrainCurrent === request) this.terrainCurrent = undefined; }
      }
    })();
    this.terrainRunning = work;
    void work.finally(() => {
      if (this.terrainRunning === work) { this.terrainRunning = undefined; if (this.terrainPending.size && !this.terrainFailed) this.startTerrainWorker(); }
    }).catch(error => { if (this.world === w) this.streamingWarning('terrain-stopped', errorText(error)); });
  }
  private receiveAvatar(p: Packet): void {
    const session = num(p, V.AvatarSession), previous = this.avatars.get(session);
    const avatar: Avatar = { session, citizen: num(p, V.AvatarCitizen, previous?.citizen ?? 0), name: string(p, V.AvatarName, previous?.name ?? ''),
      x: num(p, V.AvatarXCoordinate) / 100, y: num(p, V.AvatarYCoordinate) / 100, z: num(p, V.AvatarZCoordinate) / 100, yaw: radians(num(p, V.AvatarYOrientation)),
      pitch: radians(num(p, V.AvatarPitch)), type: num(p, V.AvatarType), gesture: num(p, V.AvatarGesture), state: num(p, V.AvatarState),
    };
    // Pinned Axis AvatarHandler sends self-state for locked avatars and caretaker
    // overrides. Honor that state so a stale UI completion cannot restore a type
    // the server replaced. Ordinary StateChange has no success acknowledgement.
    if (session === this.session) {
      this.avatarType = avatar.type; this.gesture = avatar.gesture;
      this.onEvent({ type: 'local-avatar', avatar: avatar.type, gesture: avatar.gesture, source: 'server' });
    }
    this.avatars.set(session, avatar); this.onEvent({ type: 'avatar', avatar });
  }
  private receiveChat(p: Packet): void {
    this.onEvent({ type: 'chat', message: { id: randomUUID(), name: string(p, V.AvatarName, 'World'), text: string(p, V.Message), time: Date.now(), session: num(p, V.AvatarSession), kind: p.type === P.ConsoleMessage ? 'system' : num(p, V.ChatType) === 2 ? 'whisper' : 'chat',
      color: p.type === P.ConsoleMessage ? '#' + [V.ConsoleRed, V.ConsoleGreen, V.ConsoleBlue].map(id => Math.max(0, Math.min(255, num(p, id))).toString(16).padStart(2, '0')).join('') : undefined,
    } });
  }
  private requireWorld(): AxisTransport { if (!this.world) throw new Error('Enter a world first'); return this.world; }
  private move(position: Position, avatarType = this.avatarType, gesture = this.gesture): void {
    if (![position.x, position.y, position.z, position.yaw, position.pitch ?? 0].every(Number.isFinite)) throw new Error('Position must contain finite numbers');
    this.requireWorld().send(P.StateChange, [i32(V.AvatarXCoordinate, position.x * 100), i32(V.AvatarYCoordinate, position.y * 100), i32(V.AvatarZCoordinate, position.z * 100), i32(V.AvatarYOrientation, angle(position.yaw)), i32(V.AvatarPitch, angle(position.pitch ?? 0)), i32(V.AvatarType, avatarType), i32(V.AvatarGesture, gesture), i32(V.AvatarState, 0), i32(V.AvatarZone, 0)]);
    // A failed send must not latch a new gesture/type/position into later moves.
    this.position = { ...position }; this.avatarType = avatarType; this.gesture = gesture;
  }
  private submitAvatar(avatarType: number, gesture: number): void {
    this.move(this.position, avatarType, gesture);
    // Emit only after successful local dispatch. Initial entry emits even if the
    // retained type is unchanged so a previously offline UI can converge. Ordinary
    // movement does not notify, and this event never stands in for a server ACK.
    this.onEvent({ type: 'local-avatar', avatar: this.avatarType, gesture: this.gesture, source: 'submitted' });
  }
  private requireAvatarScope(command: { world: string; session: number }, label: string): void {
    if (!this.world || !this.worldReady || !this.settings) throw new Error('Enter a world before changing avatar state');
    if (!this.session || command.session !== this.session) throw new Error(`${label} session changed; try again in the current session`);
    if (command.world.trim().toLowerCase() !== this.settings.name.toLowerCase()) throw new Error(`${label} world changed; try again in the current world`);
  }
  private changeGesture(command: Extract<ClientCommand, { type: 'gesture' }>): void {
    this.requireAvatarScope(command, 'Gesture');
    if (command.avatar !== this.avatarType) throw new Error('Gesture avatar changed; choose a gesture for the current avatar');
    // World c3e7486 AvatarHandler.ProcessAvatarChange stores AvatarGesture as raw
    // Int32 and coalesces changes behind Avatar.Refresh. AvatarRefreshHandler and
    // WorldClient.SendAvatarUpdate transmit only the latest value, no start time
    // or retrigger counter. Never fabricate high bits or an immediate 0 -> N
    // replay: the neutral state may be coalesced away. Resolving means sent only.
    this.submitAvatar(this.avatarType, command.gesture);
  }
  private chat(text: string, whisperTo?: number): void {
    const value = text.trim(); if (!value) return;
    if (Buffer.byteLength(value) > 1024) throw new Error('Chat messages are limited to 1024 UTF-8 bytes');
    const fields = [str(V.Message, value), i32(V.ChatChannel, 1)]; if (whisperTo !== undefined) fields.push(i32(V.AvatarSession, whisperTo));
    this.requireWorld().send(whisperTo !== undefined ? P.Whisper : P.ChatMessage, fields);
    this.onEvent({ type: 'chat', message: { id: randomUUID(), name: this.name, text: value, time: Date.now(), session: this.session, kind: whisperTo !== undefined ? 'whisper' : 'chat' } });
  }
  private query(x: number, z: number): Promise<void> {
    if (![x, z].every(value => Number.isFinite(value) && Math.abs(value) <= 21474836.47)) return Promise.reject(new Error('Invalid query position'));
    const w = this.requireWorld(), generation = this.worldGeneration;
    if (this.queryFailed) return Promise.reject(new Error('Property streaming is paused until world re-entry after a query failure'));
    this.updateStreamingWindow(x, z); this.queryPending = { x, z };
    if (this.queryRunning) return this.queryRunning;
    const work = (async () => {
      try {
        while (this.world === w && generation === this.worldGeneration && this.queryPending) {
          const point = this.queryPending; this.queryPending = undefined;
          await this.queryArea(w, generation, point.x, point.z);
        }
      } catch (error) {
        // Property completion packets also lack request IDs. Never let a late
        // reply from a failed chain satisfy a new query on this connection.
        if (this.world === w && generation === this.worldGeneration) {
          this.queryFailed = true; this.queryPending = undefined; this.cell = undefined;
          this.streamingWarning('property-stopped', `Property streaming paused until world re-entry: ${errorText(error)}`);
        }
        throw error;
      }
    })();
    this.queryRunning = work;
    void work.finally(() => {
      if (this.queryRunning === work) {
        this.queryRunning = undefined; this.queryCursor = undefined;
        if (this.queryPending && this.world === w) void this.query(this.queryPending.x, this.queryPending.z).catch(error => this.onEvent({ type: 'error', message: errorText(error) }));
      }
    }).catch(() => {});
    return work;
  }
  private async queryArea(w: AxisTransport, generation: number, x: number, z: number): Promise<void> {
    const sx = sectorFromMetres(x), sz = sectorFromMetres(z), cursor = new Map<string, number>(), refresh = new Set<string>();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const k = key(sx + dx, sz + dz);
      if (!this.liveSectors.has(k) || this.incompleteSectors.has(k)) { refresh.add(k); this.sectors.delete(k); this.incompleteSectors.delete(k); }
      cursor.set(k, this.sectors.get(k) ?? 0);
    }
    // Retained outer sectors receive no live updates. A re-query must clear old
    // snapshots too: a now-empty cell has no frame in Axis's property query.
    const removed: number[] = [];
    for (const [id, record] of this.objects) {
      const sector = objectSector(record.object); if (!refresh.has(key(sector.x, sector.z))) continue;
      if (this.pinnedObjects.has(id)) this.deferredEvictions.add(id);
      else { this.removeCachedObject(id); removed.push(id); }
    }
    this.unload(removed, [], 'refresh'); this.queryCursor = cursor;
    let previous = '';
    for (let round = 0; round < 256; round++) {
      if (this.world !== w || generation !== this.worldGeneration) return;
      const values: Field[] = [i32(V.SectorX, sx), i32(V.SectorZ, sz)]; let id = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) values.push(i32(id++, cursor.get(key(sx + dx, sz + dz)) ?? 0));
      const signature = values.map(v => v.data.toString('hex')).join(':');
      if (signature === previous) throw new Error('World property query made no progress'); previous = signature;
      const cancellation = new AbortController();
      const done = w.waitFor(p => [P.QueryUpToDate, P.QueryNeedMore, P.ObjectQuery].includes(p.type as never), 15000, cancellation.signal);
      done.catch(() => {});
      let reply: Packet;
      try { w.send(P.Query3X3, values); reply = await done; }
      finally { cancellation.abort(); }
      if (this.world !== w || generation !== this.worldGeneration) return;
      accepted(reply, 'Load objects');
      if (reply.type === P.QueryUpToDate) {
        this.liveSectors = new Set(cursor.keys());
        if (!this.queryPending) { this.onEvent({ type: 'query-complete' }); this.queueTerrainWindow(); }
        return;
      }
      if (reply.type !== P.QueryNeedMore) throw new Error('Unexpected property query result');
      // Drain the outstanding reply before switching areas: replies carry no
      // request ID. Old off-window CellUpdates cannot resurrect evicted data.
      if (this.queryPending) return;
    }
    throw new Error('World property query exceeded 256 continuation rounds');
  }
  private requireTerrainScope(command: TerrainSetCommand): AxisTransport {
    const w = this.requireWorld();
    if (!this.worldReady || !this.settings || !sameWorld(this.settings.name, command.world) || this.session !== command.session)
      throw new Error('Terrain edit world or session changed; select the terrain again.');
    if (!this.settings.terrainEnabled) throw new Error('Terrain is disabled in this world.');
    if (this.settings.canEditTerrain !== true) throw new Error('This world has not granted you terrain editing rights.');
    if (this.terrainFailed || this.terrainEditFailed) throw new Error('Terrain editing is paused until world re-entry after an uncertain operation.');
    return w;
  }
  private cachedTerrainRow(cellX: number, cellZ: number, count: number): TerrainEditRow {
    const heights: number[] = [], textures: number[] = [];
    for (let i = 0; i < count; i++) {
      const address = terrainCellPage(cellX + i, cellZ), k = key(address.pageX, address.pageZ), page = this.terrainPages.get(k);
      const sample = page?.complete && this.terrainSequences.has(k) ? page.samples.sample(address.nodeX, address.nodeZ) : null;
      if (!sample) throw new Error('Terrain baseline is unknown, incomplete or no longer cached; wait for a full page and select it again.');
      heights.push(sample.height); textures.push(sample.texture);
    }
    return { cellX, cellZ, heights, textures };
  }
  private async setTerrain(input: TerrainSetCommand): Promise<void> {
    const command = { ...input, heights: [...input.heights], previousHeights: [...input.previousHeights], previousTextures: [...input.previousTextures] };
    const w = this.requireTerrainScope(command);
    if (this.terrainEdit) throw new Error('A terrain row edit is already pending; wait for its readback.');
    const edit: TerrainEdit = { world: w, generation: this.worldGeneration, phase: 'preparing' };
    const checkBaseline = () => {
      const row = this.cachedTerrainRow(command.cellX, command.cellZ, command.heights.length);
      if (row.heights.some((value, i) => value !== command.previousHeights[i]) || row.textures.some((value, i) => value !== command.previousTextures[i]))
        throw new Error('Terrain changed since selection; inspect the refreshed cells before editing.');
    };
    checkBaseline(); this.terrainEdit = edit;
    let attempted = false, acknowledged = false, rejected = false;
    try {
      // Reserve the terrain worker, drain its current request, then recheck the
      // exact baseline before writing. Do not queue a write behind other edits.
      await this.terrainRunning;
      if (this.terrainEdit !== edit || this.world !== w || this.worldGeneration !== edit.generation) throw new Error('Terrain edit was superseded by world entry.');
      this.requireTerrainScope(command); checkBaseline();
      const heights = Buffer.alloc(command.heights.length * 4);
      command.heights.forEach((height, i) => heights.writeInt32LE(terrainCentimetres(height), i * 4));
      const fields = [i32(V.TerrainX, command.cellX), i32(V.TerrainZ, command.cellZ), i32(V.TerrainCount, command.heights.length),
        i32(V.TerrainNodeTextures, command.texture), blob(V.TerrainNodeHeights, heights)];
      const cancellation = new AbortController(), result = w.waitFor(packet => packet.type === P.TerrainSet, 15000, cancellation.signal);
      result.catch(() => {}); edit.phase = 'sending';
      let reply: Packet;
      try { attempted = true; w.send(P.TerrainSet, fields); reply = await result; }
      finally { cancellation.abort(); }
      if (this.terrainEdit !== edit || this.world !== w) throw new Error('World changed before terrain acknowledgement.');
      const reason = field(reply, V.ReasonCode);
      if (!reason || reason.data.length !== 4 || reason.type !== 2) throw new Error('Terrain acknowledgement omitted a valid reason code.');
      if (num(reply, V.ReasonCode) !== 0) { rejected = true; accepted(reply, 'Set terrain'); }
      // Unauthorized has no coordinates. Success must echo the exact row start;
      // there is no request ID/count/sequence with which to correlate further.
      if (![V.TerrainNodeX, V.TerrainNodeZ].every(id => field(reply, id)?.type === 2 && field(reply, id)?.data.length === 4)
        || num(reply, V.TerrainNodeX) !== command.cellX || num(reply, V.TerrainNodeZ) !== command.cellZ)
        throw new Error('Terrain acknowledgement does not identify the requested row.');
      acknowledged = true; edit.phase = 'reading';
      const pages = terrainRowPages(command.cellX, command.cellZ, command.heights.length);
      if (pages.some(page => !this.streaming.hasPage(page.pageX, page.pageZ))) throw new Error('The edited terrain left the retained area before readback.');
      const reads = pages.map(page => new Promise<void>((resolve, reject) => this.terrainReadbacks.set(key(page.pageX, page.pageZ), { resolve, reject })));
      const finished = Promise.all(reads); finished.catch(() => {});
      // Full readbacks precede ordinary pending page refreshes. The -1 sentinel
      // forces even an absent (sequence zero) page to send its actual default grid.
      const priority = new Map<string, TerrainTarget>();
      for (const page of pages) {
        const k = key(page.pageX, page.pageZ); this.terrainSequences.delete(k);
        const cached = this.terrainPages.get(k); if (cached) cached.complete = false;
        this.terrainPageEvent(page.pageX, page.pageZ, 0, false);
        priority.set(k, { ...page, readback: true });
      }
      for (const [k, page] of this.terrainPending) if (!priority.has(k)) priority.set(k, page);
      this.terrainPending = priority; this.startTerrainWorker(); await finished;
      if (this.terrainEdit !== edit || this.world !== w || this.worldGeneration !== edit.generation) throw new Error('World changed before canonical terrain result.');
      const canonical = this.cachedTerrainRow(command.cellX, command.cellZ, command.heights.length);
      const verified = canonical.heights.every((height, i) => height === command.heights[i]) && canonical.textures.every(texture => texture === command.texture);
      this.onEvent({ type: 'terrain-result', requestId: command.requestId, world: this.settings!.name, session: this.session, ...canonical, status: verified ? 'verified' : 'conflict' });
    } catch (error) {
      if (attempted && !rejected && this.terrainEdit === edit && this.world === w) {
        this.terrainEditFailed = true;
        throw new Error(`${acknowledged ? 'Terrain was acknowledged but readback is uncertain' : 'Terrain edit outcome is uncertain'}; do not retry automatically. Re-enter the world and inspect it. ${errorText(error)}`);
      }
      throw error;
    } finally {
      if (this.terrainEdit === edit) {
        this.rejectTerrainReadbacks(new Error('Terrain readback ended before completion'));
        this.terrainEdit = undefined; this.startTerrainWorker();
      }
    }
  }
  private async editObject(type: number, object: WorldObject, previous?: WorldObject, requestId?: string): Promise<void> {
    const w = this.requireWorld(); if (!object.model.trim()) throw new Error('An object model is required');
    const old = previous ? this.objects.get(previous.id) : undefined;
    if (previous && (!old || !sameObjectSnapshot(old.object, previous))) throw new Error('Object changed or is no longer cached; refresh it before editing');
    const reference = ++this.callback;
    let number: number; do { number = randomBytes(4).readUInt32LE(); } while (this.mutationNumbers.has(number));
    const fields = [i32(V.ObjectCallbackReference, reference), i32(V.ObjectNumber, number), i32(V.ObjectOwner, object.owner || this.citizen), i32(V.ObjectType, object.type ?? 0),
      i32(V.ObjectBuildTimestamp, Math.floor(Date.now() / 1000)), i32(V.ObjectX, object.x * 100), i32(V.ObjectY, object.y * 100), i32(V.ObjectZ, object.z * 100),
      i32(V.ObjectYaw, angle(object.yaw)), i32(V.ObjectTilt, angle(object.pitch)), i32(V.ObjectRoll, angle(object.roll)),
      str(V.ObjectModel, object.model), str(V.ObjectDescription, object.description), str(V.ObjectAction, object.action), blob(V.ObjectData, Buffer.from(object.data ?? '', 'base64'))];
    if (previous && old) fields.push(i32(V.ObjectId, previous.id), i32(V.ObjectOldNumber, old.number),
      i32(V.ObjectOldX, old.object.cellX ?? Math.floor(old.object.x / 10)), i32(V.ObjectOldZ, old.object.cellZ ?? Math.floor(old.object.z / 10)));
    // ObjectResult carries identity but no full property. The originating session
    // is guaranteed the canonical broadcast by pinned ObjectHandler.ShouldSendUpdate.
    // Subscribe before sending: ACK + broadcast may arrive in the same TCP read.
    const cancellation = new AbortController();
    this.beginMutation(reference, old?.object.id);
    this.mutationNumbers.add(number);
    this.mutationReferences.set(number, reference);
    const canonical = requestId ? w.waitFor(p => (p.type === P.ObjectAdd || p.type === P.ObjectChange) &&
      (num(p, V.ObjectNumber) >>> 0) === number && num(p, V.SessionId) === this.session, 15000, cancellation.signal) : undefined;
    canonical?.catch(() => {}); // A rejected ACK can leave the broadcast promise unused.
    try {
      const response = await w.request(type, fields, P.ObjectResult, p => num(p, V.ObjectCallbackReference) === reference); accepted(response, type === P.ObjectAdd ? 'Add object' : 'Change object');
      if (requestId && canonical) {
        const result = objectFromPacket(await canonical), id = num(response, V.ObjectId) >>> 0;
        if (this.world !== w) throw new Error('World changed before the mutation result was handled');
        if (!id || result.id !== id) throw new Error('Canonical object broadcast does not match its acknowledged ID');
        this.onEvent({ type: 'object-result', requestId, operation: type === P.ObjectAdd ? 'add' : 'change', id, object: result });
      }
    } finally { cancellation.abort(); this.mutationNumbers.delete(number); this.mutationReferences.delete(number); this.finishMutation(reference, w); }
  }
  private beginMutation(reference: number, id?: number): void {
    if (this.pendingMutations.size >= STREAMING_LIMITS.maxPendingMutations) throw new Error('Too many pending object mutations; wait for their results.');
    this.pendingMutations.set(reference, new Set()); if (id !== undefined) this.pinObject(reference, id);
  }
  private pinObject(reference: number, id: number): void {
    const ids = this.pendingMutations.get(reference); if (!ids || ids.has(id)) return;
    // An Axis change has one stable ID; do not accept an unbounded number of
    // forged canonical IDs for a single pending number/session pair.
    if (ids.size >= 1) return;
    ids.add(id); this.pinnedObjects.set(id, (this.pinnedObjects.get(id) ?? 0) + 1);
  }
  private finishMutation(reference: number, w: AxisTransport): void {
    const ids = this.pendingMutations.get(reference); if (!ids) return; this.pendingMutations.delete(reference);
    const evicted: number[] = [];
    for (const id of ids) {
      const count = (this.pinnedObjects.get(id) ?? 1) - 1;
      if (count > 0) this.pinnedObjects.set(id, count);
      else {
        this.pinnedObjects.delete(id);
        if (this.deferredEvictions.has(id)) { this.removeCachedObject(id, true); evicted.push(id); }
      }
    }
    if (this.world === w) { this.unload(evicted, [], 'refresh'); this.updateStreamingWindow(this.streaming.position.x, this.streaming.position.z); }
  }
  private async deleteObject(object: WorldObject, requestId?: string): Promise<void> {
    const reference = ++this.callback, w = this.requireWorld();
    const old = this.objects.get(object.id);
    if (!old || !sameObjectSnapshot(old.object, object)) throw new Error('Object changed or is no longer cached; refresh it before deleting');
    this.beginMutation(reference, object.id);
    try {
      const p = await w.request(P.ObjectDelete, [i32(V.ObjectCallbackReference, reference), i32(V.ObjectId, object.id), i32(V.ObjectNumber, old.number), i32(V.CellX, old.object.cellX ?? Math.floor(old.object.x / 10)), i32(V.CellZ, old.object.cellZ ?? Math.floor(old.object.z / 10))], P.ObjectResult, p => num(p, V.ObjectCallbackReference) === reference); accepted(p, 'Delete object');
      if (requestId) {
        if (this.world !== w) throw new Error('World changed before the mutation result was handled');
        const id = num(p, V.ObjectId) >>> 0;
        if (!id || id !== object.id) throw new Error('Delete acknowledgement does not match the requested object ID');
        this.onEvent({ type: 'object-result', requestId, operation: 'delete', id });
      }
    } finally { this.finishMutation(reference, w); }
  }
}
