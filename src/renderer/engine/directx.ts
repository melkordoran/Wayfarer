/** Independently implemented from Microsoft's public DirectX X-file templates.
 * https://learn.microsoft.com/en-us/windows/win32/direct3d9/dx9-graphics-reference-x-file-format
 * CPU data only. Matrices and coordinates remain in the source basis; the
 * renderer applies the named AW conversion policy, never the RWX 10x scale.
 */
import { decompressDirectX } from './directx-compression';
export interface DirectXMaterial {
  name?: string;
  diffuse: [number, number, number, number];
  power: number;
  specular: [number, number, number];
  emissive: [number, number, number];
  texture?: string;
}
export interface DirectXFrame {
  id: number;
  parent: number | null;
  name: string;
  uuid?: string;
  matrix: number[];
}
export interface DirectXAnimationKeys {
  /** Microsoft types: 0 rotation (WXYZ), 1 scale, 2 position, 3 matrix.
   * Type 4 is retained as exporter metadata, not silently treated as type 3. */
  type: number;
  keys: Array<{ time: number; values: number[] }>;
}
export interface DirectXAnimation {
  name?: string;
  target: { name?: string; uuid?: string };
  keys: DirectXAnimationKeys[];
  options?: { openClosed: number; positionQuality: number };
  unsupported: string[];
}
export interface DirectXAnimationSet {
  name?: string;
  ticksPerSecond?: number;
  animations: DirectXAnimation[];
  unsupported: string[];
}
export interface DirectXSkinWeights {
  bone: string;
  indices: number[];
  weights: number[];
  offsetMatrix: number[];
}
export interface DirectXMesh {
  name?: string;
  frame: number | null;
  positions: number[];
  faces: number[][];
  normals?: number[];
  normalFaces?: number[][];
  uvs?: number[];
  /** RGBA, four values per source vertex. */
  colors?: number[];
  materialIndices: number[];
  materials: DirectXMaterial[];
  skinWeights: DirectXSkinWeights[];
}
export interface DirectXModel {
  format: "x";
  encoding: "text" | "binary";
  version: string;
  floatBits: 32 | 64;
  frames: DirectXFrame[];
  meshes: DirectXMesh[];
  warnings: string[];
  hasEmbeddedAnimation: boolean;
  /** Opt-in animation parsing shares the bounded geometry lexer. Merely loading
   * geometry does not select or automatically play an embedded AnimationSet. */
  animationSets?: DirectXAnimationSet[];
  animationTicksPerSecond?: number;
}

export const DIRECTX_PARSE_LIMITS = Object.freeze({
  bytes: 30_000_000,
  tokens: 2_000_000,
  depth: 128,
  frames: 1024,
  meshes: 4096,
  vertices: 250_000,
  normals: 500_000,
  faces: 250_000,
  corners: 1_000_000,
  faceCorners: 4096,
  materials: 4096,
  skinWeights: 1_000_000,
  skinBones: 256,
  stringBytes: 4096,
  animationSets: 64,
  animationTracks: 256,
  animationKeys: 100_000,
});

type Token =
  | { kind: "name" | "string" | "symbol" | "guid"; value: string }
  | { kind: "number"; value: number };
const limits = DIRECTX_PARSE_LIMITS;
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const defaultMaterial = (): DirectXMaterial => ({
  diffuse: [1, 1, 1, 1],
  power: 0,
  specular: [0, 0, 0],
  emissive: [0, 0, 0],
});
function error(message: string): never {
  throw new Error(`DirectX: ${message}`);
}
const numeric = (value: number): number =>
  Number.isFinite(value) && Math.abs(value) <= 1e12
    ? value
    : error("non-finite or excessive numeric value");

/** Lazy tokenization prevents short malformed headers/counts from first allocating
 * millions of token objects. Every emitted token and source byte is bounded. */
function* textTokens(text: string): Generator<Token> {
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (char === "#" || (char === "/" && text[at + 1] === "/")) {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    // Accept conventional block comments too; braces inside cannot alter scope.
    if (char === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) error("unterminated comment");
      at = end + 2;
      continue;
    }
    if (char === '"') {
      at++;
      let value = "",
        closed = false;
      while (at < text.length) {
        const current = text[at++];
        if (current === '"') {
          closed = true;
          break;
        }
        if (current === "\\" && (text[at] === '"' || text[at] === "\\"))
          value += text[at++];
        else value += current;
        if (value.length > limits.stringBytes) error("string exceeds limit");
      }
      if (!closed || /[\u0000-\u001f\u007f]/.test(value))
        error("invalid or unterminated string");
      yield { kind: "string", value };
      continue;
    }
    if (char === "<") {
      const end = text.indexOf(">", at + 1);
      if (
        end < 0 ||
        end - at > 80 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          text.slice(at + 1, end).trim(),
        )
      )
        error("invalid template/object UUID");
      yield {
        kind: "guid",
        value: text
          .slice(at + 1, end)
          .trim()
          .toLowerCase(),
      };
      at = end + 1;
      continue;
    }
    if (
      "{}[](),;".includes(char) ||
      (char === "." && !/\d/.test(text[at + 1] ?? ""))
    ) {
      yield { kind: "symbol", value: char };
      at++;
      continue;
    }
    if (/[+\-.0-9]/.test(char)) {
      const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(
        text.slice(at, at + 128),
      );
      if (!match || /[a-z0-9_.]/i.test(text[at + match[0].length] ?? ""))
        error("invalid numeric token");
      yield { kind: "number", value: numeric(Number(match[0])) };
      at += match[0].length;
      continue;
    }
    const name = /^[a-z_$][a-z0-9_$.-]*/i.exec(
      text.slice(at, at + limits.stringBytes + 1),
    );
    if (!name || name[0].length > limits.stringBytes)
      error("invalid or excessive identifier");
    yield { kind: "name", value: name[0] };
    at += name[0].length;
  }
}

function* binaryTokens(
  bytes: Uint8Array,
  floatBits: 32 | 64,
): Generator<Token> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (count: number) => {
    if (count > bytes.length - at) error("truncated binary token");
  };
  const word = () => {
    need(2);
    const value = view.getUint16(at, true);
    at += 2;
    return value;
  };
  const dword = () => {
    need(4);
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const symbols: Record<number, string> = {
    10: "{",
    11: "}",
    12: "(",
    13: ")",
    14: "[",
    15: "]",
    16: "<",
    17: ">",
    18: ".",
    19: ",",
    20: ";",
  };
  const names: Record<number, string> = {
    31: "template",
    40: "WORD",
    41: "DWORD",
    42: "FLOAT",
    43: "DOUBLE",
    44: "CHAR",
    45: "UCHAR",
    46: "SWORD",
    47: "SDWORD",
    48: "VOID",
    49: "LPSTR",
    50: "UNICODE",
    51: "CSTRING",
    52: "array",
  };
  let records = 0;
  while (at < bytes.length) {
    // Empty numeric-list records emit no values; count their work separately
    // so they cannot bypass the lazy reader's emitted-token ceiling.
    if (++records > limits.tokens) error("binary record budget exceeded");
    const code = word();
    if (code === 1 || code === 2) {
      const length = dword();
      if (length > limits.stringBytes) error("binary string exceeds limit");
      need(length);
      let value = "";
      for (let index = 0; index < length; index++)
        value += String.fromCharCode(bytes[at++]);
      // Some exporters include one C terminator in the counted payload.
      if (value.endsWith("\0")) value = value.slice(0, -1);
      if (/[\u0000-\u001f\u007f]/.test(value) || (code === 1 && !value))
        error("invalid binary name/string");
      if (code === 2) {
        const end = word();
        if (end !== 19 && end !== 20) error("invalid binary string terminator");
        // Microsoft documents DWORD terminators. A WORD terminator also occurs
        // in exporters; zero is not a legal next token, so the forms are distinct.
        if (at + 2 <= bytes.length && view.getUint16(at, true) === 0) at += 2;
      }
      yield { kind: code === 1 ? "name" : "string", value };
      continue;
    }
    if (code === 3) {
      yield { kind: "number", value: dword() };
      continue;
    }
    if (code === 5) {
      need(16);
      const hex = (value: number, length: number) =>
        value.toString(16).padStart(length, "0");
      const value = `${hex(view.getUint32(at, true), 8)}-${hex(view.getUint16(at + 4, true), 4)}-${hex(view.getUint16(at + 6, true), 4)}-${hex(bytes[at + 8], 2)}${hex(bytes[at + 9], 2)}-${Array.from(bytes.subarray(at + 10, at + 16), (byte) => hex(byte, 2)).join("")}`;
      at += 16;
      yield { kind: "guid", value };
      continue;
    }
    if (code === 6 || code === 7) {
      const count = dword(),
        stride = code === 6 ? 4 : floatBits / 8;
      if (
        count > limits.tokens ||
        count > Math.floor((bytes.length - at) / stride)
      )
        error("invalid binary numeric list length");
      for (let index = 0; index < count; index++) {
        const value =
          code === 6
            ? view.getUint32(at, true)
            : floatBits === 32
              ? view.getFloat32(at, true)
              : view.getFloat64(at, true);
        at += stride;
        yield { kind: "number", value: numeric(value) };
      }
      continue;
    }
    if (symbols[code]) {
      yield { kind: "symbol", value: symbols[code] };
      continue;
    }
    if (names[code]) {
      yield { kind: "name", value: names[code] };
      continue;
    }
    error(`unsupported binary token ${code}`);
  }
}

class Reader {
  private look: Token | null | undefined;
  private emitted = 0;
  constructor(private source: Generator<Token>) {}
  peek(): Token | null {
    if (this.look === undefined) {
      const next = this.source.next();
      if (!next.done && ++this.emitted > limits.tokens)
        error("token budget exceeded");
      this.look = next.done ? null : next.value;
    }
    return this.look;
  }
  take(): Token {
    const value = this.peek();
    if (!value) return error("unexpected end of file");
    this.look = undefined;
    return value;
  }
  separators(): void {
    while (
      this.peek()?.kind === "symbol" &&
      [",", ";"].includes(String(this.peek()?.value))
    )
      this.take();
  }
  is(value: string): boolean {
    this.separators();
    return this.peek()?.value === value;
  }
  expect(value: string): void {
    this.separators();
    if (this.take().value !== value) error(`expected ${value}`);
  }
  number(): number {
    this.separators();
    const token = this.take();
    return token.kind === "number" ? token.value : error("expected a number");
  }
  count(maximum: number, label: string): number {
    const value = this.number();
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum
      ? value
      : error(`invalid ${label} count/index`);
  }
  array(count: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < count; i++) result.push(this.number());
    return result;
  }
  string(): string {
    this.separators();
    const token = this.take();
    return token.kind === "string"
      ? token.value
      : error("expected a quoted string");
  }
  open(): { type: string; name?: string; uuid?: string } {
    this.separators();
    const type = this.take();
    if (type.kind !== "name") return error("expected an object type");
    let name: string | undefined;
    if (this.peek()?.kind === "name") name = String(this.take().value);
    this.expect("{");
    const uuid =
      this.peek()?.kind === "guid" ? String(this.take().value) : undefined;
    return { type: type.value, name, uuid };
  }
  skip(depth: number): void {
    let nested = 1;
    while (nested) {
      const token = this.take();
      if (token.kind === "symbol" && token.value === "{") {
        nested++;
        if (nested + depth > limits.depth) error("nesting limit exceeded");
      }
      if (token.kind === "symbol" && token.value === "}") nested--;
    }
  }
}

/** An affine row-vector X matrix, including offsets, must be invertible.
 * Keep arbitrary nonsingular scale/shear in CPU data; avatar pose adapters may
 * explicitly reject a non-TRS bind, whereas static geometry can preserve it. */
function matrix(reader: Reader): number[] {
  const m = reader.array(16);
  if (
    Math.abs(m[3]) > 1e-7 ||
    Math.abs(m[7]) > 1e-7 ||
    Math.abs(m[11]) > 1e-7 ||
    Math.abs(m[15] - 1) > 1e-7
  )
    error("matrix must be affine");
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) error("singular matrix");
  return m;
}

/** Parse supported geometry templates; this is not a general X template VM.
 * Unknown optional blocks are bounded and reported. Unsupported compression,
 * malformed skinning or unresolved material/bone references never become a
 * successful partial model. Explicit external SEQ/X playback belongs to the renderer. */
export function parseDirectX(
  input: Uint8Array | string,
  options: { animations?: boolean } = {},
): DirectXModel {
  if (input.length > limits.bytes) error("model exceeds 30 MB limit");
  const bytes = decompressDirectX(
    typeof input === "string" ? new TextEncoder().encode(input) : input,
  );
  if (bytes.length > limits.bytes || bytes.length < 16)
    error("invalid or excessive X header");
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  if (!/^xof 030[23](?:txt |bin )(?:0032|0064)$/.test(header))
    error("unsupported X header/version");
  const mode = header.slice(8, 12);
  const floatBits = Number(header.slice(12)) as 32 | 64;
  const reader = new Reader(
    mode === "txt "
      ? textTokens(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(16)),
        )
      : binaryTokens(bytes.subarray(16), floatBits),
  );
  const model: DirectXModel = {
    format: "x",
    encoding: mode === "txt " ? "text" : "binary",
    version: header.slice(4, 8),
    floatBits,
    frames: [],
    meshes: [],
    warnings: [],
    hasEmbeddedAnimation: false,
    ...(options.animations ? { animationSets: [] } : {}),
  };
  const warnings = new Set<string>();
  const globalMaterials = new Map<string, DirectXMaterial>();
  const uuidMaterials = new Map<string, DirectXMaterial>();
  type MaterialReference = { reference: true; name?: string; uuid?: string };
  const materialLists: {
    mesh: DirectXMesh;
    items: (DirectXMaterial | MaterialReference)[];
  }[] = [];
  let vertices = 0,
    normals = 0,
    faces = 0,
    corners = 0,
    materials = 0,
    skinEntries = 0,
    animationTracks = 0,
    animationKeys = 0;
  const warn = (message: string) => {
    if (warnings.size < 64) warnings.add(message);
    else warnings.add("Additional unsupported metadata omitted.");
  };
  const color = (count: number): number[] =>
    reader
      .array(count)
      .map((value) =>
        value >= 0 && value <= 1
          ? value
          : error("color/opacity must be between zero and one"),
      );
  const readFaces = (count: number, vertexCount: number): number[][] => {
    const output: number[][] = [];
    for (let i = 0; i < count; i++) {
      const length = reader.count(limits.faceCorners, "face vertex");
      if (length < 3 || (corners += length) > limits.corners)
        error("invalid face or face-corner budget exceeded");
      const face: number[] = [];
      for (let j = 0; j < length; j++)
        face.push(reader.count(vertexCount - 1, "vertex"));
      output.push(face);
    }
    return output;
  };
  const readMaterial = (
    name: string | undefined,
    depth: number,
    uuid?: string,
  ): DirectXMaterial => {
    if (++materials > limits.materials) error("material budget exceeded");
    const value: DirectXMaterial = {
      name,
      diffuse: color(4) as DirectXMaterial["diffuse"],
      power: reader.number(),
      specular: color(3) as DirectXMaterial["specular"],
      emissive: color(3) as DirectXMaterial["emissive"],
    };
    if (value.power < 0) error("negative material power");
    while (!reader.is("}")) {
      const child = reader.open();
      if (
        child.type === "TextureFilename" ||
        child.type === "TextureFileName"
      ) {
        if (value.texture !== undefined) error("duplicate material texture");
        value.texture = reader.string();
        reader.expect("}");
      } else {
        warn(`Unsupported material template: ${child.type.slice(0, 80)}`);
        reader.skip(depth + 1);
      }
    }
    reader.expect("}");
    if (name) {
      if (globalMaterials.has(name))
        error(`duplicate material name ${name.slice(0, 80)}`);
      globalMaterials.set(name, value);
    }
    if (uuid) {
      if (uuidMaterials.has(uuid)) error("duplicate material UUID");
      uuidMaterials.set(uuid, value);
    }
    return value;
  };
  const readMesh = (
    frame: number | null,
    name: string | undefined,
    depth: number,
  ): void => {
    if (model.meshes.length >= limits.meshes) error("mesh budget exceeded");
    const vertexCount = reader.count(limits.vertices - vertices, "vertex");
    vertices += vertexCount;
    const mesh: DirectXMesh = {
      name,
      frame,
      positions: reader.array(vertexCount * 3),
      faces: [],
      materialIndices: [],
      materials: [],
      skinWeights: [],
    };
    const faceCount = reader.count(limits.faces - faces, "face");
    faces += faceCount;
    mesh.faces = readFaces(faceCount, vertexCount);
    const seen = new Set<string>();
    const skinBones = new Set<string>();
    let declaredSkin:
      { vertex: number; face: number; bones: number } | undefined;
    while (!reader.is("}")) {
      const child = reader.open();
      if (child.type !== "SkinWeights" && seen.has(child.type))
        error(`duplicate mesh template ${child.type.slice(0, 80)}`);
      seen.add(child.type);
      if (child.type === "MeshNormals") {
        const count = reader.count(limits.normals - normals, "normal");
        normals += count;
        mesh.normals = reader.array(count * 3);
        const normalFaceCount = reader.count(limits.faces, "normal face");
        if (normalFaceCount !== faceCount)
          error("normal face count does not match mesh");
        mesh.normalFaces = readFaces(normalFaceCount, count);
        if (
          mesh.normalFaces.some(
            (face, i) => face.length !== mesh.faces[i].length,
          )
        )
          error("normal face corners do not match mesh");
        reader.expect("}");
      } else if (child.type === "MeshTextureCoords") {
        if (reader.count(limits.vertices, "UV") !== vertexCount)
          error("UV count does not match mesh");
        mesh.uvs = reader.array(vertexCount * 2);
        reader.expect("}");
      } else if (child.type === "MeshVertexColors") {
        const count = reader.count(vertexCount, "vertex color");
        mesh.colors = new Array(vertexCount * 4).fill(1);
        const indices = new Set<number>();
        for (let i = 0; i < count; i++) {
          const index = reader.count(vertexCount - 1, "vertex color");
          if (indices.has(index)) error("duplicate vertex color index");
          indices.add(index);
          mesh.colors.splice(index * 4, 4, ...color(4));
        }
        reader.expect("}");
      } else if (child.type === "MeshMaterialList") {
        const count = reader.count(limits.materials, "material");
        const indexCount = reader.count(limits.faces, "material face");
        if (indexCount !== faceCount)
          error("material face count does not match mesh");
        for (let i = 0; i < indexCount; i++)
          mesh.materialIndices.push(reader.count(count - 1, "material"));
        const items: (DirectXMaterial | MaterialReference)[] = [];
        while (!reader.is("}")) {
          if (items.length >= count) error("excess material list entries");
          if (reader.is("{")) {
            reader.expect("{");
            const reference: MaterialReference = { reference: true };
            if (reader.peek()?.kind === "name")
              reference.name = String(reader.take().value);
            if (reader.peek()?.kind === "guid")
              reference.uuid = String(reader.take().value);
            if (!reference.name && !reference.uuid)
              error("material reference must identify a material");
            items.push(reference);
            reader.expect("}");
          } else {
            const material = reader.open();
            if (material.type !== "Material")
              error("expected material list entry");
            items.push(readMaterial(material.name, depth + 2, material.uuid));
          }
        }
        if (items.length !== count) error("missing material list entries");
        materialLists.push({ mesh, items });
        reader.expect("}");
      } else if (child.type === "SkinWeights") {
        if (mesh.skinWeights.length >= limits.skinBones)
          error("skin bone declaration budget exceeded");
        const bone = reader.string();
        if (!bone || skinBones.has(bone)) error("empty or duplicate skin bone");
        skinBones.add(bone);
        const count = reader.count(
          Math.min(vertexCount, limits.skinWeights - skinEntries),
          "skin weight",
        );
        skinEntries += count;
        const indices: number[] = [];
        const used = new Set<number>();
        for (let i = 0; i < count; i++) {
          const index = reader.count(vertexCount - 1, "skin vertex");
          if (used.has(index)) error("duplicate skin vertex index");
          used.add(index);
          indices.push(index);
        }
        const weights = reader.array(count);
        if (weights.some((weight) => weight < 0 || weight > 1))
          error("invalid skin weight");
        mesh.skinWeights.push({
          bone,
          indices,
          weights,
          offsetMatrix: matrix(reader),
        });
        reader.expect("}");
      } else if (child.type === "XSkinMeshHeader") {
        declaredSkin = {
          vertex: reader.count(65535, "skin vertex influence"),
          face: reader.count(65535, "skin face influence"),
          bones: reader.count(65535, "skin bone"),
        };
        reader.expect("}");
      } else if (child.type === "DeclData" || child.type === "FVFData") {
        // These may carry additional blend indices/weights. Rendering a partial
        // rig as valid is worse than an explicit fallback.
        error(`${child.type} vertex declarations are not supported yet`);
      } else {
        warn(`Unsupported mesh template: ${child.type.slice(0, 80)}`);
        reader.skip(depth + 1);
      }
    }
    reader.expect("}");
    if (!seen.has("MeshMaterialList")) {
      mesh.materials = [defaultMaterial()];
      mesh.materialIndices = new Array(faceCount).fill(0);
    }
    if (declaredSkin && declaredSkin.bones !== mesh.skinWeights.length)
      error("skin header bone count does not match weights");
    if (mesh.skinWeights.length) {
      const sums = new Float64Array(vertexCount),
        influences = new Uint8Array(vertexCount);
      const perVertex: Set<string>[] = Array.from(
        { length: vertexCount },
        () => new Set<string>(),
      );
      for (const skin of mesh.skinWeights)
        for (let i = 0; i < skin.indices.length; i++) {
          const index = skin.indices[i],
            weight = skin.weights[i];
          if (weight === 0) continue;
          sums[index] += weight;
          if (++influences[index] > 4)
            error(
              "more than four positive skin influences on a vertex are not supported",
            );
          perVertex[index].add(skin.bone);
        }
      for (let index = 0; index < vertexCount; index++) {
        if (Math.abs(sums[index] - 1) > 1e-4)
          error("skin weights must sum to one for every vertex");
        if (declaredSkin && influences[index] > declaredSkin.vertex)
          error("skin header underreports vertex influences");
      }
      if (declaredSkin)
        for (const face of mesh.faces) {
          const used = new Set<string>();
          for (const index of face)
            for (const bone of perVertex[index]) used.add(bone);
          if (used.size > declaredSkin.face)
            error("skin header underreports face influences");
        }
    }
    model.meshes.push(mesh);
  };
  const readAnimation = (name: string | undefined, depth: number): DirectXAnimation => {
    if (++animationTracks > limits.animationTracks) error("animation track budget exceeded");
    let target: DirectXAnimation["target"] | undefined;
    const animation: DirectXAnimation = { name, target: {}, keys: [], unsupported: [] };
    const types = new Set<number>();
    while (!reader.is("}")) {
      if (reader.is("{")) {
        if (target) error("animation has more than one target reference");
        reader.expect("{");
        target = {};
        if (reader.peek()?.kind === "name") target.name = String(reader.take().value);
        if (reader.peek()?.kind === "guid") target.uuid = String(reader.take().value);
        if (!target.name && !target.uuid) error("animation has an empty target reference");
        reader.expect("}");
        continue;
      }
      const child = reader.open();
      if (child.type === "AnimationKey") {
        const type = reader.count(4, "animation key type");
        if (types.has(type)) error("duplicate animation key type");
        if ((type === 3 && types.has(4)) || (type === 4 && types.has(3))) error("ambiguous matrix animation key types");
        types.add(type);
        const count = reader.count(limits.animationKeys - animationKeys, "animation key");
        if (!count) error("animation key block is empty");
        animationKeys += count;
        const block: DirectXAnimationKeys = { type, keys: [] };
        let previous = -1;
        const width = type === 0 ? 4 : type === 1 || type === 2 ? 3 : 16;
        for (let index = 0; index < count; index++) {
          const time = reader.count(0xffffffff, "animation time");
          if (time <= previous) error("animation key times must be strictly increasing");
          previous = time;
          if (reader.count(16, "animation key value") !== width) error("animation key value count does not match type");
          block.keys.push({ time, values: reader.array(width) });
        }
        animation.keys.push(block);
        reader.expect("}");
      } else if (child.type === "AnimationOptions") {
        if (animation.options) error("duplicate animation options");
        animation.options = {
          openClosed: reader.count(1, "animation open/closed option"),
          positionQuality: reader.count(1, "animation position quality"),
        };
        reader.expect("}");
      } else {
        if (animation.unsupported.length < 64) animation.unsupported.push(child.type.slice(0, 80));
        reader.skip(depth + 1);
      }
    }
    reader.expect("}");
    if (!target || !animation.keys.length) error("animation requires a target and key block");
    animation.target = target;
    return animation;
  };
  const readAnimationSet = (name: string | undefined, depth: number): void => {
    const sets = model.animationSets!;
    if (sets.length >= limits.animationSets) error("animation set budget exceeded");
    const set: DirectXAnimationSet = { name, animations: [], unsupported: [] };
    while (!reader.is("}")) {
      const child = reader.open();
      if (child.type === "Animation") set.animations.push(readAnimation(child.name, depth + 1));
      else if (child.type === "AnimTicksPerSecond") {
        if (set.ticksPerSecond !== undefined) error("duplicate animation-set tick rate");
        set.ticksPerSecond = reader.count(0xffffffff, "animation ticks per second");
        reader.expect("}");
      }
      else {
        if (set.unsupported.length < 64) set.unsupported.push(child.type.slice(0, 80));
        reader.skip(depth + 1);
      }
    }
    reader.expect("}");
    sets.push(set);
  };
  const scope = (parent: number | null, depth: number): void => {
    if (depth > limits.depth) error("nesting limit exceeded");
    let transformSeen = false;
    while (true) {
      reader.separators();
      if (!reader.peek()) {
        if (parent !== null) error("unclosed frame");
        break;
      }
      if (reader.is("}")) {
        if (parent === null) error("unexpected closing brace");
        reader.expect("}");
        break;
      }
      const object = reader.open();
      if (object.type.toLowerCase() === "template") {
        reader.skip(depth);
        continue;
      }
      if (object.type === "Frame") {
        if (model.frames.length >= limits.frames)
          error("frame budget exceeded");
        const id = model.frames.length;
        model.frames.push({
          id,
          parent,
          name: object.name ?? "",
          ...(object.uuid ? { uuid: object.uuid } : {}),
          matrix: identity(),
        });
        scope(id, depth + 1);
      } else if (object.type === "FrameTransformMatrix") {
        if (parent === null || transformSeen)
          error("misplaced or duplicate frame transform");
        model.frames[parent].matrix = matrix(reader);
        transformSeen = true;
        reader.expect("}");
      } else if (object.type === "Mesh")
        readMesh(parent, object.name, depth + 1);
      else if (object.type === "Material")
        readMaterial(object.name, depth + 1, object.uuid);
      else if (object.type === "Header") {
        reader.count(65535, "header major");
        reader.count(65535, "header minor");
        const flags = reader.count(0xffffffff, "header flags");
        if (flags > 1) error("unknown Header flags are not supported");
        if (flags !== (mode === "txt " ? 1 : 0))
          error("mixed-mode Header data is not supported");
        reader.expect("}");
      } else if (options.animations && object.type === "AnimationSet") {
        if (parent !== null) error("AnimationSet must be at document scope");
        model.hasEmbeddedAnimation = true;
        readAnimationSet(object.name, depth + 1);
      } else if (options.animations && object.type === "AnimTicksPerSecond") {
        if (parent !== null || model.animationTicksPerSecond !== undefined) error("misplaced or duplicate animation tick rate");
        model.animationTicksPerSecond = reader.count(0xffffffff, "animation ticks per second");
        reader.expect("}");
      } else if (options.animations && ["Animation", "AnimationKey", "CompressedAnimationSet"].includes(object.type)) {
        error(`unsupported or misplaced animation template ${object.type}`);
      } else if (
        [
          "AnimationSet",
          "Animation",
          "AnimationKey",
          "AnimTicksPerSecond",
          "CompressedAnimationSet",
        ].includes(object.type)
      ) {
        model.hasEmbeddedAnimation = true;
        warn(
          "Embedded DirectX animation is not played automatically; geometry uses its bind pose and avatars may use separate catalog-referenced SEQ or X files.",
        );
        reader.skip(depth + 1);
      } else {
        warn(`Unsupported X template: ${object.type.slice(0, 80)}`);
        reader.skip(depth + 1);
      }
    }
  };
  scope(null, 0);
  for (const { mesh, items } of materialLists)
    mesh.materials = items.map((item) => {
      if (!("reference" in item)) return item;
      const named = item.name ? globalMaterials.get(item.name) : undefined;
      const identified = item.uuid ? uuidMaterials.get(item.uuid) : undefined;
      if ((item.name && !named) || (item.uuid && !identified))
        error("unresolved material reference");
      if (named && identified && named !== identified)
        error("material name/UUID reference mismatch");
      return named ?? identified ?? error("unresolved material reference");
    });
  const boneCounts = new Map<string, number>();
  for (const frame of model.frames)
    if (frame.name)
      boneCounts.set(frame.name, (boneCounts.get(frame.name) ?? 0) + 1);
  for (const mesh of model.meshes)
    for (const skin of mesh.skinWeights)
      if (boneCounts.get(skin.bone) !== 1)
        error(`missing or ambiguous skin bone ${skin.bone.slice(0, 80)}`);
  model.warnings = [...warnings];
  return model;
}
