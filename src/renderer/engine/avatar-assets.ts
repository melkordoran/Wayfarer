import { strFromU8 } from 'fflate';
import { Group, Matrix4, Quaternion, Vector3 } from 'three';
import { decodeModelAsset, firstAvailable, isDirectXHeader, modelAssetNames, type AssetFetcher } from './assets';
import { parseRwx, rwxLine, tokenize, type RwxModel, type RwxPart } from './rwx';
import { parseDirectX, type DirectXModel } from './directx';
import { parseDirectXSequence } from './directx-animation';
import { boundedUnzip } from './zip';

/** Independent format implementation; no vendor code or avatar assets are included.
 * Catalog syntax was checked against AW's published avatars/avatars.zip at
 * http://objects.activeworlds.com/aw/ (2026-09-07). Implicit slots and tagged clumps:
 * https://www.activeworlds.com/newsletter/0208/020801.html
 * https://www.activeworlds.com/newsletter/0802/080205.html
 * Binary and AWSQ layout: Alex Grigny de Castro's original SeqFileViewer specification,
 * http://www.imatowns.com/xelagot/seqspecs.html (1999/2003). This is an author-primary
 * specification, NOT an official AW binary specification. Unexplained blocks are skipped.
 */

export interface AvatarGesture { name: string; sequence: string; group?: string }
export interface AvatarDefinition {
  /** Declaration ordinal, including geometryless menu headings. Never renumber the catalog. */
  index: number; name: string; geometry?: string; autoLook: boolean; autoWalk: boolean;
  implicit: Record<string, string>; explicit: AvatarGesture[];
}
export interface AvatarCatalog { version: number; entries: AvatarDefinition[]; warnings: string[] }
const CATALOG_LIMIT = 4_000_000;
const SEQUENCE_LIMIT = 16_000_000;
const JOINT_LIMIT = 256;
const KEY_LIMIT = 100_000;

function uncomment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    if ((line[i] === '"' || line[i] === "'") && line[i - 1] !== '\\') {
      if (!quote) quote = line[i]; else if (quote === line[i]) quote = '';
    }
    if (!quote && (line[i] === '#' || (line[i] === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))))) return line.slice(0, i).trim();
  }
  return line.trim();
}
function valueOf(value: string): string { return value.replace(/^(["'])(.*)\1$/, '$2').trim(); }

export function parseAvatarCatalog(source: string): AvatarCatalog {
  if (source.length > CATALOG_LIMIT) throw new Error('Avatar catalog exceeds 4 MB');
  const catalog: AvatarCatalog = { version: 0, entries: [], warnings: [] };
  const warnings = new Set<string>();
  let avatar: AvatarDefinition | undefined, section: 'implicit' | 'explicit' | undefined, group: string | undefined;
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = uncomment(raw);
    if (!line) continue;
    const lower = line.toLowerCase();
    const version = /^version\s*(?:=\s*|\s+)(\d+)$/i.exec(line);
    if (version && !avatar) { catalog.version = Number(version[1]); continue; }
    if (lower === 'avatar') {
      if (avatar) throw new Error('Nested avatar declaration');
      if (catalog.entries.length >= 4096) throw new Error('Avatar catalog exceeds 4096 entries');
      avatar = { index: catalog.entries.length, name: '', autoLook: false, autoWalk: false, implicit: Object.create(null), explicit: [] };
      section = undefined; group = undefined;
      continue;
    }
    if (!avatar) { warnings.add(`Unknown catalog directive: ${line.slice(0, 80)}`); continue; }
    if (lower === 'endavatar') {
      if (section) throw new Error('Unclosed avatar sequence section');
      if (!avatar.name) throw new Error('Avatar is missing its name');
      catalog.entries.push(avatar); avatar = undefined; continue;
    }
    if (lower === 'beginimp' || lower === 'beginexp') {
      if (section) throw new Error('Nested avatar sequence section');
      section = lower === 'beginimp' ? 'implicit' : 'explicit'; continue;
    }
    if (lower === 'endimp' || lower === 'endexp') {
      if (section !== (lower === 'endimp' ? 'implicit' : 'explicit')) throw new Error('Mismatched avatar sequence section');
      section = undefined; continue;
    }
    if (!section && (lower === 'autolook' || lower === 'autowalk')) { avatar[lower === 'autolook' ? 'autoLook' : 'autoWalk'] = true; continue; }
    const assignment = /^([^=]+)=(.*)$/.exec(line);
    if (!assignment) { warnings.add(`Unknown avatar directive: ${line.slice(0, 80)}`); continue; }
    const name = assignment[1].trim(), value = valueOf(assignment[2]);
    if (name.length > 256 || value.length > 4096) throw new Error('Avatar catalog field is too long');
    if (section === 'implicit') avatar.implicit[name.toLowerCase()] = value;
    else if (section === 'explicit') {
      if (name.toLowerCase() === 'group') group = value || undefined;
      else {
        if (avatar.explicit.length >= 4096) throw new Error('Avatar exceeds 4096 gestures');
        avatar.explicit.push({ name, sequence: value, ...(group ? { group } : {}) });
      }
    } else if (name.toLowerCase() === 'name') avatar.name = value;
    else if (name.toLowerCase() === 'geometry') avatar.geometry = value || undefined;
    else if (name.toLowerCase() === 'autolook') avatar.autoLook = !/^(0|false|off)$/i.test(value);
    else if (name.toLowerCase() === 'autowalk') avatar.autoWalk = !/^(0|false|off)$/i.test(value);
    else warnings.add(`Unknown avatar property: ${name.slice(0, 80)}`);
  }
  if (avatar) throw new Error('Unclosed avatar declaration');
  catalog.warnings = [...warnings];
  return catalog;
}

async function decompressGzip(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (bytes.length < 18) throw new Error('Truncated avatar GZIP');
  if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true) > limit) throw new Error('Avatar GZIP exceeds expanded size limit');
  // Streaming platform decompression validates the GZIP checksum and avoids trusting
  // an attacker-controlled ISIZE for allocation. Also bounds concatenated members.
  const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if ((total += value.byteLength) > limit) throw new Error('Avatar GZIP exceeds expanded size limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function unpack(bytes: Uint8Array, extension: 'dat' | 'seq', limit: number): Promise<Uint8Array> {
  if (bytes.byteLength > limit) throw new Error(`Avatar ${extension} download exceeds size limit`);
  bytes = await decompressGzip(bytes, limit);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return bytes;
  let total = 0;
  const files = boundedUnzip(bytes, { maxBytes: limit, maxEntries: 1024, filter: entry => {
    const matches = extension === 'dat' ? /(?:^|\/)avatars\.dat$/i.test(entry.name) : /\.seq$/i.test(entry.name);
    if (!matches) return false;
    if (entry.originalSize > limit || (total += entry.originalSize) > limit) throw new Error('Avatar archive exceeds expanded size limit');
    return true;
  } });
  const names = Object.keys(files);
  if (names.length !== 1) throw new Error(`Avatar archive must contain exactly one ${extension} asset`);
  return files[names[0]];
}

export function avatarAssetUrls(objectPath: string, name: string, kind: 'catalog' | 'geometry' | 'sequence'): string[] {
  if (!objectPath || !name) return [];
  const base = new URL(objectPath.replace(/\/?$/, '/'));
  if (!/^https?:$/.test(base.protocol)) throw new Error('Avatar object path must use HTTP or HTTPS');
  // Asset names are object-path basenames, not URLs or arbitrary paths.
  if (/[\\/:\u0000]/.test(name) || name === '.' || name === '..') throw new Error('Invalid avatar asset name');
  const folder = kind === 'sequence' ? 'seqs' : 'avatars';
  if (kind === 'geometry') return modelAssetNames(name).map(filename => new URL(`${folder}/${encodeURIComponent(filename)}`, base).href);
  if (kind === 'sequence') return sequenceAssetNames(name).map(filename => new URL(`${folder}/${encodeURIComponent(filename)}`, base).href);
  const extension = kind === 'catalog' ? '.dat' : '.seq';
  const stem = name.replace(/\.(?:dat|rwx|seq|zip)$/i, '');
  return ['.zip', extension].map(suffix => new URL(`${folder}/${encodeURIComponent(stem + suffix)}`, base).href);
}

/** Explicit X/SEQ extensions constrain archive member selection; extensionless
 * names retain ZIP-first legacy lookup and then try SEQ before X. */
function sequenceAssetNames(name: string): string[] {
  if (!name || name.length > 512 || /[\\/:\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') throw new Error('Invalid avatar sequence name');
  const extension = /\.(seq|x|zip)$/i.exec(name)?.[1].toLowerCase();
  const stem = extension ? name.slice(0, -(extension.length + 1)) : name;
  if (!stem || /\.(?:seq|x|zip)$/i.test(stem)) throw new Error('Invalid layered avatar sequence extension');
  return ['.zip', ...(extension === 'x' ? ['.x'] : extension === 'seq' ? ['.seq'] : ['.seq', '.x'])].map(suffix => stem + suffix);
}

async function unpackSequence(bytes: Uint8Array, name: string): Promise<{ bytes: Uint8Array; filename?: string }> {
  if (bytes.length > SEQUENCE_LIMIT) throw new Error('Avatar sequence download exceeds size limit');
  bytes = await decompressGzip(bytes, SEQUENCE_LIMIT);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { bytes };
  const wanted = new Set(sequenceAssetNames(name).filter(file => /\.(seq|x)$/i.test(file)).map(file => file.toLowerCase()));
  let entries = 0, total = 0;
  const seen = new Set<string>();
  const files = boundedUnzip(bytes, { maxBytes: SEQUENCE_LIMIT, maxEntries: 1024, filter: entry => {
    if (++entries > 1024) throw new Error('Avatar sequence archive exceeds 1024 entries');
    const path = entry.name;
    if (!path || path.length > 1024 || /[\\:\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid path in avatar sequence archive');
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new Error('Duplicate filename in avatar sequence archive');
    seen.add(folded);
    if (!wanted.has(folded.split('/').at(-1)!)) return false;
    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > SEQUENCE_LIMIT || (total += entry.originalSize) > SEQUENCE_LIMIT) throw new Error('Avatar sequence archive exceeds expanded size limit');
    return true;
  } });
  const names = Object.keys(files);
  if (names.length !== 1) throw new Error('Avatar sequence archive must contain exactly one matching basename and format');
  const filename = names[0];
  if (files[filename].length > SEQUENCE_LIMIT) throw new Error('Avatar sequence archive exceeds expanded size limit');
  return { bytes: files[filename], filename };
}

export async function loadAvatarCatalog(objectPath: string, fetcher: AssetFetcher): Promise<AvatarCatalog> {
  const result = await firstAvailable(fetcher, avatarAssetUrls(objectPath, 'avatars.dat', 'catalog'));
  return parseAvatarCatalog(strFromU8(await unpack(result.bytes, 'dat', CATALOG_LIMIT)));
}

export interface RotationKey { timeMs: number; rotation: Quaternion }
export interface TranslationKey { timeMs: number; value: number }
export interface JointSequence { name: string; rotations: RotationKey[]; translations?: Array<{ timeMs: number; value: Vector3 }> }
export interface AvatarSequence {
  format: 'binary' | 'awsq' | 'directx'; durationMs: number; frameCount?: number; modelName?: string; rootJoint: string;
  joints: JointSequence[]; rootTranslation?: [TranslationKey[], TranslationKey[], TranslationKey[]]; warnings: string[];
}

class SequenceReader {
  private offset = 0;
  private view: DataView;
  constructor(private bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get remaining() { return this.bytes.byteLength - this.offset; }
  require(size: number) { if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining) throw new Error('Truncated SEQ data'); }
  u16() { this.require(2); const n = this.view.getUint16(this.offset); this.offset += 2; return n; }
  u32() { this.require(4); const n = this.view.getUint32(this.offset); this.offset += 4; return n; }
  f32() { this.require(4); const n = this.view.getFloat32(this.offset); this.offset += 4; if (!Number.isFinite(n)) throw new Error('Non-finite SEQ number'); return n; }
  skip(size: number) { this.require(size); this.offset += size; }
  string() {
    const size = this.u16();
    if (!size || size > 4096) throw new Error('Invalid SEQ string size');
    this.require(size);
    if (this.bytes[this.offset + size - 1] !== 0) throw new Error('SEQ string is not NUL terminated');
    const value = strFromU8(this.bytes.subarray(this.offset, this.offset + size - 1));
    this.offset += size; return value;
  }
}

function checkedQuaternion(x: number, y: number, z: number, w: number): Quaternion {
  const rotation = new Quaternion(x, y, z, w);
  if (rotation.lengthSq() < 1e-20) throw new Error('SEQ contains a zero quaternion');
  return rotation.normalize();
}

export function parseAvatarSequence(bytes: Uint8Array): AvatarSequence {
  if (bytes.byteLength > SEQUENCE_LIMIT) throw new Error('SEQ exceeds 16 MB');
  if (isDirectXHeader(bytes)) return parseDirectXSequence(bytes, directXJointName);
  if (bytes[0] !== 0x7f) return parseTextSequence(strFromU8(bytes));
  const input = new SequenceReader(bytes), magic = input.u32();
  if (magic !== 0x7f7f7f79 && magic !== 0x7f7f7f7a) throw new Error('Unsupported binary SEQ magic');
  const frames = input.u16(), jointCount = input.u32();
  if (!frames || jointCount > JOINT_LIMIT) throw new Error('Invalid SEQ frame or joint count');
  const sequence: AvatarSequence = {
    format: 'binary', frameCount: frames, durationMs: (frames - 1) * 1000 / 30,
    modelName: input.string(), rootJoint: input.string().toLowerCase() || 'pelvis', joints: [], warnings: [],
  };
  let keyCount = 0;
  const countKeys = (count: number) => { if ((keyCount += count) > KEY_LIMIT) throw new Error('SEQ exceeds keyframe budget'); };
  const time = (frame: number, previous: number) => {
    if (frame < 1 || frame > frames || frame <= previous) throw new Error('Invalid or unordered SEQ frame number');
    return (frame - 1) * 1000 / 30;
  };
  const names = new Set<string>();
  for (let joint = 0; joint < jointCount; joint++) {
    const name = input.string().toLowerCase();
    if (!name || names.has(name)) throw new Error('Empty or duplicate SEQ joint');
    names.add(name);
    if (input.u32() !== 16) throw new Error('SEQ rotation records must contain four floats');
    const count = input.u32(); countKeys(count); input.require(count * 20);
    const rotations: RotationKey[] = [];
    let previous = 0;
    for (let key = 0; key < count; key++) {
      const frame = input.u32(), timeMs = time(frame, previous); previous = frame;
      // The file stores WXYZ; Three.js stores XYZW.
      const w = input.f32(), x = input.f32(), y = input.f32(), z = input.f32();
      rotations.push({ timeMs, rotation: checkedQuaternion(x, y, z, w) });
    }
    sequence.joints.push({ name, rotations });
  }
  // Some authentic legacy wave sequences finish directly after their joint records.
  if (input.remaining) {
    const blockCount = input.u32();
    if (blockCount > 64) throw new Error('SEQ exceeds additional block budget');
    const translations: [TranslationKey[], TranslationKey[], TranslationKey[]] = [[], [], []];
    for (let block = 0; block < blockCount; block++) {
      const dataSize = input.u32(), count = input.u32(); countKeys(count);
      if (dataSize > 1024 || (block < 3 && dataSize !== 4)) throw new Error('Invalid SEQ additional block record size');
      input.require(count * (4 + dataSize));
      let previous = 0;
      for (let key = 0; key < count; key++) {
        const frame = input.u32(), timeMs = time(frame, previous); previous = frame;
        if (block < 3) translations[block].push({ timeMs, value: input.f32() });
        else input.skip(dataSize);
      }
      if (block < 3 && count && translations[block][0].timeMs !== 0) sequence.warnings.push(`Root translation axis ${block} has no first-frame key; holding its first value`);
    }
    sequence.rootTranslation = translations;
    if (blockCount > 3) sequence.warnings.push(`${blockCount - 3} legacy auxiliary blocks are not animated`);
  }
  if (input.remaining) throw new Error('Trailing bytes after SEQ');
  return sequence;
}

function parseTextSequence(source: string): AvatarSequence {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/).map(uncomment).filter(Boolean);
  const header = /^AWSQ\s+Version=(\d+)\s+Limbs=(\d+)\s+Duration=(\d+)$/i.exec(lines.shift() ?? '');
  if (!header || Number(header[1]) !== 1) throw new Error('Unsupported AWSQ header');
  const count = Number(header[2]), durationMs = Number(header[3]);
  if (count > JOINT_LIMIT || !durationMs || durationMs > 86_400_000) throw new Error('Invalid AWSQ duration or limb count');
  const sequence: AvatarSequence = { format: 'awsq', durationMs, rootJoint: 'pelvis', joints: [], warnings: [] };
  let cursor = 0, keyCount = 0, hasScale = false, hasZeroAxisJitter = false;
  const names = new Set<string>();
  for (let limb = 0; limb < count; limb++) {
    const entry = /^(\S+)\s+frames=(\d+)$/i.exec(lines[cursor++] ?? '');
    if (!entry) throw new Error('Missing AWSQ limb header');
    const name = entry[1].toLowerCase(), frames = Number(entry[2]);
    if (frames < 2 || (keyCount += frames) > KEY_LIMIT || names.has(name)) throw new Error('Invalid AWSQ limb keyframes');
    names.add(name);
    const joint: JointSequence = { name, rotations: [], translations: [] };
    let previous = -1;
    for (let frame = 0; frame < frames; frame++) {
      const numbers = (lines[cursor++] ?? '').split(/[\s,]+/).map(Number);
      if ((numbers.length !== 8 && numbers.length !== 11) || numbers.some(n => !Number.isFinite(n) || Math.abs(n) > 1e9)) throw new Error('Invalid AWSQ frame record');
      const [timeMs, x, y, z, degrees, tx, ty, tz] = numbers;
      if (!Number.isInteger(timeMs) || timeMs <= previous || timeMs > durationMs || (frame === 0 && timeMs !== 0)) throw new Error('Invalid AWSQ frame time');
      previous = timeMs;
      const axis = new Vector3(x, y, z), rotation = new Quaternion();
      if (degrees !== 0) {
        if (!axis.lengthSq()) {
          // The published AW privet3.seq has rounded-to-zero axes with angles of
          // 0.000002–0.000014 degrees. Treat only near-identity values as identity.
          if (Math.abs(degrees - Math.round(degrees / 360) * 360) > 0.0001) throw new Error('AWSQ rotation has no axis');
          hasZeroAxisJitter = true;
        } else rotation.setFromAxisAngle(axis.normalize(), degrees * Math.PI / 180);
      }
      joint.rotations.push({ timeMs, rotation });
      joint.translations!.push({ timeMs, value: new Vector3(tx * 10, ty * 10, tz * 10) });
      if (numbers.length === 11 && numbers.slice(8).some(n => n !== 1)) hasScale = true;
    }
    sequence.joints.push(joint);
  }
  if (cursor !== lines.length) throw new Error('Trailing AWSQ records');
  if (hasScale) sequence.warnings.push('AWSQ scale keys are ignored, matching the documented legacy format');
  if (hasZeroAxisJitter) sequence.warnings.push('Zero-axis near-identity rotation keys were normalized to identity');
  return sequence;
}

export async function loadAvatarSequence(objectPath: string, name: string, fetcher: AssetFetcher): Promise<AvatarSequence> {
  const result = await firstAvailable(fetcher, avatarAssetUrls(objectPath, name, 'sequence'));
  const asset = await unpackSequence(result.bytes, name);
  const actualName = asset.filename ?? new URL(result.url).pathname;
  if ((/\.x$/i.test(name) || /\.x$/i.test(actualName)) && !isDirectXHeader(asset.bytes)) throw new Error('DirectX animation filename/header mismatch');
  return parseAvatarSequence(asset.bytes);
}

export interface JointPose { rotation: Quaternion; translation: Vector3 }
export interface SequenceSampleOptions { loop?: boolean; rootMotion?: boolean }
function bracket<T extends { timeMs: number }>(keys: T[], time: number): [T, T, number] | undefined {
  if (!keys.length) return undefined;
  let low = 0, high = keys.length - 1;
  if (time <= keys[low].timeMs) return [keys[low], keys[low], 0];
  if (time >= keys[high].timeMs) return [keys[high], keys[high], 0];
  while (high - low > 1) { const mid = (low + high) >>> 1; if (keys[mid].timeMs <= time) low = mid; else high = mid; }
  return [keys[low], keys[high], (time - keys[low].timeMs) / (keys[high].timeMs - keys[low].timeMs)];
}

/** Produces local rest-relative rotations and metre translations. No axis inversion is guessed. */
export function sampleAvatarSequence(sequence: AvatarSequence, timeMs: number, options: SequenceSampleOptions = {}): Map<string, JointPose> {
  if (!Number.isFinite(timeMs)) throw new Error('Invalid sequence time');
  const duration = sequence.durationMs;
  const time = options.loop && duration > 0 ? ((timeMs % duration) + duration) % duration : Math.min(duration, Math.max(0, timeMs));
  const result = new Map<string, JointPose>();
  for (const joint of sequence.joints) {
    const pose = { rotation: new Quaternion(), translation: new Vector3() };
    const rotation = bracket(joint.rotations, time);
    if (rotation) pose.rotation.slerpQuaternions(rotation[0].rotation, rotation[1].rotation, rotation[2]);
    const translation = joint.translations && bracket(joint.translations, time);
    if (translation && (joint.name !== sequence.rootJoint || options.rootMotion !== false)) pose.translation.lerpVectors(translation[0].value, translation[1].value, translation[2]);
    result.set(joint.name, pose);
  }
  if (sequence.rootTranslation && options.rootMotion !== false) {
    const root = result.get(sequence.rootJoint) ?? { rotation: new Quaternion(), translation: new Vector3() };
    for (let axis = 0; axis < 3; axis++) {
      const keys = bracket(sequence.rootTranslation[axis], time);
      if (keys) root.translation.setComponent(axis, keys[0].value + (keys[1].value - keys[0].value) * keys[2]);
    }
    result.set(sequence.rootJoint, root);
  }
  return result;
}

export const AVATAR_JOINT_NAMES = [
  '', 'pelvis', 'back', 'neck', 'head', 'rtsternum', 'rtshoulder', 'rtelbow', 'rtwrist', 'rtfingers',
  'lfsternum', 'lfshoulder', 'lfelbow', 'lfwrist', 'lffingers', 'rthip', 'rtknee', 'rtankle', 'rttoes',
  'lfhip', 'lfknee', 'lfankle', 'lftoes', 'neck2', 'tail', 'tail2', 'tail3', 'tail4', 'obj1', 'obj2',
  'obj3', 'hair', 'hair2', 'hair3', 'hair4', 'rtbreast', 'lfbreast', 'rteye', 'lfeye', 'lips', 'nose', 'rtear', 'lfear',
] as const;

/** Official AW tag names/aliases, not generic skeleton retargeting. Source:
 * https://web.archive.org/web/20250506100347/https://wiki.activeworlds.com/index.php?title=Skinned_avatars
 * Underscored limb aliases occur in the official DX_Animation exporter example:
 * https://web.archive.org/web/20211011235358/http://wiki.activeworlds.com/index.php?title=DX_Animation
 * Tag 28/39 retain this client's legacy SEQ keys obj1/lips. Unknown frame names
 * return undefined and remain in the source hierarchy, without fabricated tags.
 */
const DIRECTX_JOINT_NAMES = new Set<string>([
  ...AVATAR_JOINT_NAMES.filter(Boolean), 'rtbrow', 'lfbrow', 'rtlid', 'lflid',
  'rtcheek', 'lfcheek', 'rtlipupper', 'lflipupper', 'liplower', 'rtliplower', 'lfliplower',
  'chin', 'back2', 'chest', 'rtbrowouter', 'lfbrowouter',
  ...['rt', 'lf'].flatMap(side => [1, 2, 3, 4, 5].flatMap(finger => [1, 2].map(joint => `${side}${finger}finger${joint}`))),
]);
const DIRECTX_JOINT_ALIASES: Record<string, string> = { obj: 'obj1', lipupper: 'lips', lipdownl: 'lfliplower' };
for (const [suffix, side] of [['r', 'rt'], ['l', 'lf']]) {
  for (const limb of ['sternum', 'shoulder', 'elbow', 'wrist', 'fingers', 'hip', 'knee', 'ankle', 'toes', 'breast', 'eye', 'ear', 'brow', 'lid', 'cheek', 'lipupper']) DIRECTX_JOINT_ALIASES[`${limb}${suffix}`] = `${side}${limb}`;
  for (const limb of ['sternum', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'toes']) DIRECTX_JOINT_ALIASES[`${limb}_${suffix}`] = `${side}${limb}`;
}
DIRECTX_JOINT_ALIASES.liplowerr = 'rtliplower';

export function directXJointName(frameName: string): string | undefined {
  const name = frameName.toLowerCase().replace(/^aw_/, '');
  const canonical = Object.hasOwn(DIRECTX_JOINT_ALIASES, name) ? DIRECTX_JOINT_ALIASES[name] : name;
  return DIRECTX_JOINT_NAMES.has(canonical) ? canonical : undefined;
}

export interface AvatarRigJoint { tag: number; name: string; group: Group; bindPosition: Vector3; bindRotation: Quaternion }
export interface AvatarRigPart { part: RwxPart; parent: Group }
export interface AvatarRig { root: Group; joints: Map<string, AvatarRigJoint>; parts: AvatarRigPart[]; warnings: string[] }
interface ClumpBinding { tag: number; parent?: number; world: Matrix4 }

/** Prototype for rigid, tagged RWX clumps (not weighted .x skinning). Geometry remains in
 * RwxPart form so the renderer owns material/texture construction and GPU disposal.
 * Prototypes with tagged joints, sheared bind transforms and duplicate joint tags are
 * rejected instead of silently attaching geometry to incorrect bones.
 */
export function parseAvatarRwx(source: string): AvatarRig {
  const model: RwxModel = parseRwx(source);
  const bindings = new Map<number, ClumpBinding>();
  type State = { transform: Matrix4; tag?: number; clump?: { tag?: number; parent?: number; captured: boolean } };
  let state: State = { transform: new Matrix4() };
  const stack: Array<{ kind: string; state: State }> = [];
  let prototypeDepth = 0;
  const capture = () => {
    const clump = state.clump;
    if (!clump || clump.tag === undefined || clump.captured) return;
    if (bindings.has(clump.tag)) throw new Error(`Duplicate avatar joint tag ${clump.tag}`);
    if (bindings.size >= JOINT_LIMIT) throw new Error('Avatar exceeds joint budget');
    const world = state.transform.clone();
    world.elements[12] *= 10; world.elements[13] *= 10; world.elements[14] *= 10;
    if (!world.elements.every(Number.isFinite) || !Number.isFinite(world.determinant()) || Math.abs(world.determinant()) < 1e-12) throw new Error('Avatar joint has a singular or non-finite bind transform');
    bindings.set(clump.tag, { tag: clump.tag, parent: clump.parent, world }); clump.captured = true;
  };
  for (const raw of source.split(/\r?\n/)) {
    const tokens = tokenize(rwxLine(raw)), command = tokens.shift()?.toLowerCase();
    if (command === 'protobegin') { prototypeDepth++; continue; }
    if (command === 'protoend') { prototypeDepth--; continue; }
    if (prototypeDepth) { if (command === 'tag') throw new Error('Tagged joints inside RWX prototypes are not yet supported'); continue; }
    const values = tokens.map(Number);
    const arity: Record<string, number> = { translate: 3, scale: 3, rotate: 4, transform: 16, tag: 1 };
    if (command && arity[command] && (values.length !== arity[command] || values.some(n => !Number.isFinite(n) || Math.abs(n) > 1e9))) throw new Error('Invalid avatar transform');
    switch (command) {
      case 'clumpbegin':
        capture(); stack.push({ kind: command, state });
        state = { ...state, transform: state.transform.clone(), clump: { parent: state.tag, captured: false } }; break;
      case 'transformbegin': case 'attributebegin':
        stack.push({ kind: command, state }); state = { ...state, transform: state.transform.clone() }; break;
      case 'clumpend': case 'transformend': case 'attributeend': {
        if (command === 'clumpend') capture();
        const prior = stack.pop();
        if (!prior || prior.kind !== command.replace('end', 'begin')) throw new Error('Unbalanced avatar RWX hierarchy');
        state = prior.state; break;
      }
      case 'tag':
        if (!state.clump || !Number.isInteger(values[0]) || values[0] < 1) throw new Error('Invalid avatar joint tag');
        if (state.clump.tag !== undefined) throw new Error('Multiple tags in one avatar clump');
        state.clump.tag = values[0]; state.tag = values[0]; break;
      case 'identity': state.transform.identity(); break;
      case 'translate': state.transform.multiply(new Matrix4().makeTranslation(values[0], values[1], values[2])); break;
      case 'scale': state.transform.multiply(new Matrix4().makeScale(values[0], values[1], values[2])); break;
      case 'rotate': {
        const axis = new Vector3(values[0], values[1], values[2]);
        if (!axis.lengthSq()) throw new Error('Avatar rotation has no axis');
        state.transform.multiply(new Matrix4().makeRotationAxis(axis.normalize(), values[3] * Math.PI / 180)); break;
      }
      case 'transform':
        if (values.length !== 16) throw new Error('Avatar Transform requires 16 numbers');
        state.transform.fromArray(values); break;
      case 'vertex': case 'vertexext': case 'protoinstance': capture(); break;
    }
  }
  if (stack.length || prototypeDepth) throw new Error('Unclosed avatar RWX hierarchy');
  const root = new Group(), joints = new Map<string, AvatarRigJoint>(), byTag = new Map<number, AvatarRigJoint>();
  root.name = 'avatar-rig';
  for (const binding of bindings.values()) {
    const parent = binding.parent !== undefined ? bindings.get(binding.parent) : undefined;
    const local = parent ? parent.world.clone().invert().multiply(binding.world) : binding.world.clone();
    const group = new Group(); local.decompose(group.position, group.quaternion, group.scale);
    const recomposed = new Matrix4().compose(group.position, group.quaternion, group.scale);
    if (local.elements.some((value, i) => Math.abs(value - recomposed.elements[i]) > 1e-5)) throw new Error('Sheared avatar bind transforms are not supported');
    const name = AVATAR_JOINT_NAMES[binding.tag] ?? `tag${binding.tag}`;
    group.name = name; group.userData.tag = binding.tag;
    const joint = { tag: binding.tag, name, group, bindPosition: group.position.clone(), bindRotation: group.quaternion.clone() };
    joints.set(name, joint); byTag.set(binding.tag, joint);
  }
  for (const binding of bindings.values()) (binding.parent === undefined ? root : byTag.get(binding.parent)?.group ?? root).add(byTag.get(binding.tag)!.group);
  const parts = model.parts.map(part => {
    const binding = part.tag !== undefined ? bindings.get(part.tag) : undefined;
    if (!binding) return { part, parent: root };
    const inverse = binding.world.clone().invert(), point = new Vector3(), positions: number[] = [];
    for (let index = 0; index < part.positions.length; index += 3) {
      point.fromArray(part.positions, index).applyMatrix4(inverse); positions.push(point.x, point.y, point.z);
    }
    return { part: { ...part, positions }, parent: byTag.get(binding.tag)!.group };
  });
  const warnings = [...model.warnings];
  if (!joints.size) warnings.push('Avatar has no tagged clumps and will remain static');
  return { root, joints, parts, warnings };
}

export async function loadAvatarRwx(objectPath: string, name: string, fetcher: AssetFetcher): Promise<AvatarRig> {
  const result = await firstAvailable(fetcher, avatarAssetUrls(objectPath, name, 'geometry'));
  const decoded = await decodeModelAsset(result.bytes, name, result.url);
  if (decoded.format !== 'rwx') throw new Error('DirectX .x geometry requires loadAvatarModel, not loadAvatarRwx');
  return parseAvatarRwx(decoded.source);
}

export type AvatarModel = (AvatarRig & { format: 'rwx' }) | DirectXModel;

/** Geometry dispatch only: loading X meshes does not implement CAV templates,
 * clothing/deformation or automatically start an embedded animation set.
 */
export async function loadAvatarModel(objectPath: string, name: string, fetcher: AssetFetcher): Promise<AvatarModel> {
  const result = await firstAvailable(fetcher, avatarAssetUrls(objectPath, name, 'geometry'));
  const decoded = await decodeModelAsset(result.bytes, name, result.url);
  return decoded.format === 'x' ? parseDirectX(decoded.source) : { ...parseAvatarRwx(decoded.source), format: 'rwx' };
}

/** Resets absent tracks to bind pose on every application, so changing gestures cannot
 * leave stale arm rotations. Parent transforms retain the hierarchy and object scale. */
export function applyAvatarPose(rig: AvatarRig, pose: Map<string, JointPose>): void {
  for (const [name, joint] of rig.joints) {
    joint.group.position.copy(joint.bindPosition); joint.group.quaternion.copy(joint.bindRotation);
    const key = pose.get(name);
    if (key) { joint.group.quaternion.multiply(key.rotation); joint.group.position.add(key.translation); }
  }
  rig.root.updateMatrixWorld(true);
}
