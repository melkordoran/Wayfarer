import type { TerrainSetCommand } from './terrain-edit';
import type { WorldSettingsSetCommand, WorldSettingsResult } from './world-settings-edit';
/** Units at this boundary are metres and radians; the protocol adapter converts AW units. */
export interface Position {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
}
export interface WorldInfo {
  name: string;
  users: number;
  status: string;
  description?: string;
}
export interface WorldObject {
  id: number;
  owner: number;
  model: string;
  description: string;
  action: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  type?: number;
  data?: string;
  cellX?: number;
  cellZ?: number;
}
export interface Avatar extends Position {
  session: number;
  citizen: number;
  name: string;
  type: number;
  gesture: number;
  state: number;
}
export interface TerrainTile {
  pageX: number;
  pageZ: number;
  nodeX: number;
  nodeZ: number;
  size: number;
  heights: number[];
  textures: number[];
  sequence?: number;
}
export interface WorldSettings {
  /** Local edit scope, not a server revision. A new entry always gets a new ID. */
  editContext?: { entryId: string; revision: number; blocked: boolean };
  name: string;
  title: string;
  welcome: string;
  objectPath: string;
  skyColor: string;
  fogColor: string;
  /** Metres. Fog reaches full obscuration at fogMax; fogMax also bounds far clipping. */
  fogMin: number;
  fogMax: number;
  ambientColor: string;
  lightColor: string;
  terrainEnabled: boolean;
  waterEnabled: boolean;
  /** Metres above the world origin, not 10-metre coordinate units. */
  waterLevel: number;
  entry: Position;
  canBuild: boolean;
  /** Axis advertises TerrainRight ACL, not a Terrain capability bit. */
  canEditTerrain?: boolean;
  /** Optional for legacy/offline settings; normalized Axis settings always supply these. */
  fogEnabled?: boolean;
  fogTinted?: boolean;
  /** Raw directional-light vector components in [-1,1], not unit-normalized.
   * For AW 3.3+, the light source lies in the opposite direction. */
  lightDirection?: { x: number; y: number; z: number };
  skyColors?: Record<"top" | "bottom" | "north" | "south" | "east" | "west", string>;
  ground?: string;
  repeatingGround?: boolean;
  skybox?: string;
  backdrop?: string;
  /** Metres. */
  terrainOffset?: number;
  /** Material reflection coefficients, each 0..1; not light-source intensities. */
  terrainAmbient?: number;
  terrainDiffuse?: number;
  waterColor?: string;
  /** Normalized 0..1 from the authored integer 0..255. */
  waterOpacity?: number;
  waterTexture?: string;
  waterMask?: string;
  waterBottomTexture?: string;
  waterBottomMask?: string;
  waterUnderTerrain?: boolean;
  /** Metres. */
  waterVisibility?: number;
  /** Dimensionless legacy motion speed, not a verified angular frequency. */
  waterSpeed?: number;
  /** Metres; waveform/timing is not defined by the Axis server. */
  waterSurfaceMove?: number;
  waterWaveMove?: number;
  allowFlying?: boolean;
  allowPassthru?: boolean;
  allowTeleport?: boolean;
  allowAvatarCollision?: boolean;
  /** Effective authored rule OR caretaker privilege. */
  canFly?: boolean;
  canPassthru?: boolean;
  canTeleport?: boolean;
  /** Multiples of Earth gravity; buoyancy is the underwater gravity multiplier. */
  gravity?: number;
  buoyancy?: number;
  friction?: number;
  waterFriction?: number;
  disableShadows?: boolean;
  caretaker?: boolean;
  owner?: boolean;
  canSpeak?: boolean;
  canEject?: boolean;
  canUseEminentDomain?: boolean;
  publicSpeaker?: boolean;
  environmentWarnings?: string[];
  /** Known environment metadata without a supported normalized rendering interpretation. */
  unsupportedEnvironmentAttributes?: Record<string, string>;
  /** Diagnostic values only. Object-path password attributes are excluded. */
  rawAttributes?: Record<number, string>;
  [key: string]: unknown;
}
export interface ConnectionOptions {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  world?: string;
  tourist?: boolean;
  email?: string;
}
export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  time: number;
  kind: "chat" | "system" | "whisper" | "error";
  session?: number;
  color?: string;
}
export type ContactState = "offline" | "online" | "invalid" | "away" | "unknown" | "removed" | "default";
export interface Contact { citizen: number; name: string; state: ContactState; world: string; options: number }
/** Axis per-contact/default privacy bits; an override replaces default bits. */
export const CONTACT_OPTIONS = {
  statusOn: 0x0001, statusOff: 0x0002, worldOn: 0x0004, worldOff: 0x0008,
  telegramOn: 0x0010, telegramOff: 0x0020, joinOn: 0x0040, joinOff: 0x0080,
  fileTransferOn: 0x0100, fileTransferOff: 0x0200, chatOn: 0x0400, chatOff: 0x0800,
  requestAllowed: 0x1000, requestBlocked: 0x2000, allAllowed: 0x4000, allBlocked: 0x8000,
} as const;
export interface TelegramMessage {
  /** Locally generated ID: Axis does not expose its persisted telegram ID. */
  id: string; direction: "incoming" | "outgoing"; from: string; to: string; text: string;
  /** Incoming send time is approximate, reconstructed from the server's age in seconds. */
  time: number; status: "received" | "submitted";
  /** Untrusted request text. Never confirm a contact without explicit user action. */
  contactRequest?: { citizen: number; name: string };
}
export type SocialCommand =
  | { type: "contacts-list" }
  | { type: "contact-add"; name: string; options?: number }
  | { type: "contact-delete"; citizen: number }
  | { type: "contact-change"; citizen: number; options: number }
  | { type: "contact-confirm"; citizen: number; options?: number }
  | { type: "telegram-fetch" }
  | { type: "telegram-send"; to: string; text: string };
export type ClientEvent = WorldSettingsResult
  | {
      type: "status";
      phase:
        | "disconnected"
        | "connecting"
        | "authenticating"
        | "connected"
        | "entering"
        | "online";
      message: string;
    }
  | { type: "login"; citizen: number; session: number; name: string }
  | { type: "worlds"; worlds: WorldInfo[] }
  | { type: "world"; settings: WorldSettings }
  | { type: "objects"; objects: WorldObject[]; replace?: boolean }
  /** Local cache removal, never a server-side property/terrain deletion. */
  | { type: "stream-unload"; world: string; session: number; objectIds: number[]; terrainPages: Array<{ pageX: number; pageZ: number }>; reason: "distance" | "budget" | "refresh" | "reset" }
  | { type: "object-delete"; id: number }
  | { type: "object-result"; requestId: string; operation: "add" | "change" | "delete"; id: number; object?: WorldObject }
  /** Submitted is local socket dispatch, not a server acknowledgement. */
  | { type: "local-avatar"; avatar: number; gesture: number; source: "submitted" | "server" }
  | { type: "avatar"; avatar: Avatar }
  | { type: "avatar-delete"; session: number }
  | { type: "terrain"; tile: TerrainTile }
  | { type: "terrain-page"; world: string; session: number; pageX: number; pageZ: number; sequence: number; complete: boolean }
  /** ACK accepted and explicit full-page readback finished; conflict is not success. */
  | { type: "terrain-result"; requestId: string; world: string; session: number; cellX: number; cellZ: number; heights: number[]; textures: number[]; status: "verified" | "conflict" }
  | { type: "chat"; message: ChatMessage }
  | { type: "contacts"; contacts: Contact[]; defaultOptions: number }
  | { type: "telegram-pending"; pending: boolean }
  | { type: "telegram"; message: TelegramMessage }
  | { type: "teleport"; world?: string; position: Position }
  | { type: "error"; message: string }
  | { type: "query-complete" }
  | { type: "stats"; received: number; sent: number; latency?: number };
export type ClientCommand = SocialCommand | TerrainSetCommand | WorldSettingsSetCommand
  | { type: "connect"; options: ConnectionOptions }
  | { type: "disconnect" }
  /** Manual entry is the default. Authored object actions carry the source scope;
   * there is deliberately no renderer-accessible server override. */
  | { type: "enter"; world: string; position?: Position; origin?: "user" }
  | { type: "enter"; world: string; position?: Position; origin: "action"; fromWorld: string; session: number }
  | { type: "chat"; text: string; whisperTo?: number }
  | { type: "move"; position: Position }
  | { type: "query"; x: number; z: number }
  | { type: "object-add"; object: WorldObject; requestId?: string }
  | { type: "object-change"; object: WorldObject; previous: WorldObject; requestId?: string }
  | { type: "object-delete"; object: WorldObject; requestId?: string }
  | { type: "avatar-set"; avatar: number; gesture?: number }
  /** Scoped avatar selection clears the gesture; legacy avatar-set remains for compatibility. */
  | { type: "avatar-select"; avatar: number; world: string; session: number }
  /** Guarded state, not an acknowledged playback request. AW documents a one-based
   * gesture index and 0 for no gesture; 255 is Wayfarer's outgoing support limit.
   * Browser 434+ submits 0 when a sequence ends; repeated positive movement state
   * is not a new trigger. This does not guarantee Axis observer delivery.
   * https://web.archive.org/web/20250506090959/https://wiki.activeworlds.com/index.php?title=AW_MY_GESTURE
   * https://web.archive.org/web/20250506090912/https://wiki.activeworlds.com/index.php?title=AW_AVATAR_GESTURE */
  | { type: "gesture"; gesture: number; avatar: number; world: string; session: number }
  | { type: "object-click"; object: WorldObject };
export interface ClientBridge {
  command(command: ClientCommand): Promise<void>;
  subscribe(listener: (event: ClientEvent) => void): () => void;
  asset(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  mode: "desktop" | "preview";
}
declare global {
  interface Window {
    wayfarer?: ClientBridge;
  }
}
