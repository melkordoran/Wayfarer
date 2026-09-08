import { Matrix4, ShapeUtils, Vector2, Vector3 } from 'three';

export interface RwxMaterial {
  color: [number, number, number]; opacity: number; texture?: string; mask?: string;
  doubleSided: boolean; unlit: boolean; roughness: number;
  smooth: boolean;
}
export interface RwxPart {
  positions: number[]; uvs: number[];
  /** RGB additive light coefficients, 0..1, aligned with expanded positions. Not vertex-paint multipliers. */
  prelight?: number[];
  material: RwxMaterial; tag?: number; solid: boolean;
}
export interface RwxModel { parts: RwxPart[]; warnings: string[] }
interface Vertex { point: Vector3; uv: [number, number]; prelight: [number, number, number] }
interface PrelightScope { id: number; color: [number, number, number]; enabled: boolean; parts: Set<RwxPart> }
interface State { transform: Matrix4; material: RwxMaterial; vertices: Vertex[]; prelight: PrelightScope; tag?: number; solid: boolean }
const material = (): RwxMaterial => ({ color: [1, 1, 1], opacity: 1, doubleSided: false, unlit: false, roughness: 0.8, smooth: false });
const copy = (state: State): State => ({ ...state, transform: state.transform.clone(), material: { ...state.material, color: [...state.material.color] } });

/** Hard ceilings apply even when a caller requests a larger parsing budget. */
export const RWX_PARSE_LIMITS = Object.freeze({ maxCommands: 2_000_000, maxPrototypeExpansions: 100_000, maxScopeDepth: 1024 });
export interface RwxParseOptions {
  /** Separate limits on non-comment source commands and executed commands, including no-ops. May only lower the 2,000,000 hard ceiling. */
  maxCommands?: number;
  /** Every ProtoInstance attempt counts, even for an empty/unknown prototype or recursion cutoff. May only lower the 100,000 hard ceiling. */
  maxPrototypeExpansions?: number;
}
function budget(value: number | undefined, maximum: number, name: string) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid RWX ${name} budget; choose 1 through ${maximum}`);
  return value;
}

/** RWX modelling units are 10 metres. Call with unitScale=1 for generic RenderWare files.
 * The optional third argument can lower (never disable) parsing budgets. These
 * counters bound work before tokenization/expansion, independently of emitted
 * geometry. Each scope stack is also capped at 1024 entries. Exceeding a work
 * budget throws; a partial model must not be rendered as a successful parse. */
export function parseRwx(source: string, unitScale = 10, options: RwxParseOptions = {}): RwxModel {
  const maxCommands = budget(options.maxCommands, RWX_PARSE_LIMITS.maxCommands, 'command');
  const maxPrototypeExpansions = budget(options.maxPrototypeExpansions, RWX_PARSE_LIMITS.maxPrototypeExpansions, 'prototype expansion');
  if (source.length > 20_000_000) throw new Error('RWX exceeds the 20 MB model limit');
  const warnings = new Set<string>();
  const lines: string[] = [];
  // Scan incrementally: a low preview budget must not first allocate millions
  // of split strings. Comments/blank lines remain bounded by the source limit.
  for (let start = 0; start < source.length;) {
    let end = source.indexOf('\n', start); if (end < 0) end = source.length;
    const line = rwxLine(source.slice(start, end).replace(/\r/g, '')); start = end + 1;
    if (!line) continue;
    if (lines.length >= maxCommands) throw new Error(`RWX exceeds source command budget (${maxCommands})`);
    lines.push(line);
  }
  const prototypes = new Map<string, string[]>();
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const token = tokenize(lines[i]);
    if (token[0]?.toLowerCase() !== 'protobegin') { body.push(lines[i]); continue; }
    const name = token[1]?.toLowerCase();
    const proto: string[] = [];
    let depth = 1;
    while (++i < lines.length) {
      const command = tokenize(lines[i])[0]?.toLowerCase();
      if (command === 'protobegin') depth++;
      if (command === 'protoend' && --depth === 0) break;
      proto.push(lines[i]);
    }
    if (name) prototypes.set(name, proto);
  }
  const result: RwxModel = { parts: [], warnings: [] };
  const partMap = new Map<string, RwxPart>();
  let totalVertices = 0;
  let executedCommands = 0;
  let prototypeExpansions = 0;
  let scopeId = 0;
  const prelightScope = (): PrelightScope => ({ id: ++scopeId, color: [0, 0, 0], enabled: false, parts: new Set() });
  const enablePrelight = (scope: PrelightScope) => {
    if (scope.enabled) return;
    scope.enabled = true;
    for (const part of scope.parts) if (!part.prelight) part.prelight = new Array(part.positions.length).fill(0);
  };
  const emitFace = (indices: number[], state: State, line: string) => {
    const vertices = indices.map(index => state.vertices[index - 1]);
    if (vertices.length < 3 || vertices.some(v => !v)) { warnings.add(`Invalid face: ${line.slice(0, 90)}`); return; }
    // Newell's normal also handles valid polygons whose first three vertices are collinear.
    const normal = new Vector3();
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i].point, b = vertices[(i + 1) % vertices.length].point;
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    }
    if (normal.lengthSq() < 1e-20) { warnings.add(`Degenerate face: ${line.slice(0, 90)}`); return; }
    const abs = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const axis = abs.indexOf(Math.max(...abs));
    const contour = vertices.map(({ point: p }) => axis === 0 ? new Vector2(p.y, p.z) : axis === 1 ? new Vector2(p.x, p.z) : new Vector2(p.x, p.y));
    const triangles = vertices.length === 3 ? [[0, 1, 2]] : ShapeUtils.triangulateShape(contour, []);
    // Ambient-only legacy parts stay clump-local: promoting one clump to prelit
    // must not change the material/shading of an unrelated non-prelit clump.
    const key = JSON.stringify([state.material, state.tag, state.solid, state.material.unlit ? state.prelight.id : 0]);
    let part = partMap.get(key);
    if (!part) { part = { positions: [], uvs: [], material: { ...state.material, color: [...state.material.color] }, tag: state.tag, solid: state.solid }; partMap.set(key, part); result.parts.push(part); }
    state.prelight.parts.add(part);
    if (state.prelight.enabled && !part.prelight) part.prelight = new Array(part.positions.length).fill(0);
    for (const triangle of triangles) {
      // Earcut may orient a projected contour differently. Preserve the original 3D winding.
      const a = vertices[triangle[0]].point, b = vertices[triangle[1]].point, c = vertices[triangle[2]].point;
      if (new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).dot(normal) < 0) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
      for (const index of triangle) {
        if (++totalVertices > 3_000_000) throw new Error('RWX exceeds triangle budget');
        const v = vertices[index];
        part.positions.push(v.point.x * unitScale, v.point.y * unitScale, v.point.z * unitScale);
        part.uvs.push(v.uv[0], 1 - v.uv[1]);
        if (part.prelight) part.prelight.push(...v.prelight);
      }
    }
  };
  const run = (program: string[], incoming: State, depth: number) => {
    if (depth > 16) { warnings.add('Prototype recursion limit reached'); return; }
    let state = copy(incoming);
    const inheritedTransform = incoming.transform.clone();
    const stack: Array<{ kind: string; state: State }> = [];
    for (const line of program) {
      if (++executedCommands > maxCommands) throw new Error(`RWX exceeds execution command budget (${maxCommands})`);
      const tokens = tokenize(line);
      const command = tokens.shift()?.toLowerCase();
      const number = (index: number, fallback = 0) => Number.isFinite(Number(tokens[index])) ? Number(tokens[index]) : fallback;
      switch (command) {
        case 'modelbegin': case 'modelend': case 'protoend': case 'textureaddressmode': case 'geometrysampling': break;
        case 'clumpbegin': case 'transformbegin': case 'attributebegin':
          if (stack.length >= RWX_PARSE_LIMITS.maxScopeDepth) throw new Error(`RWX exceeds scope depth budget (${RWX_PARSE_LIMITS.maxScopeDepth})`);
          stack.push({ kind: command, state: copy(state) });
          state = copy(state);
          if (command === 'clumpbegin') { state.vertices = []; state.prelight = prelightScope(); }
          break;
        case 'clumpend': case 'transformend': case 'attributeend': {
          const prior = stack.pop();
          if (prior) state = prior.state;
          else warnings.add(`Unbalanced ${command}`);
          break;
        }
        case 'identity': state.transform.copy(inheritedTransform); break;
        case 'translate': state.transform.multiply(new Matrix4().makeTranslation(number(0), number(1), number(2))); break;
        case 'scale': state.transform.multiply(new Matrix4().makeScale(number(0, 1), number(1, 1), number(2, 1))); break;
        case 'rotate': {
          const axis = new Vector3(number(0), number(1), number(2));
          if (axis.lengthSq()) state.transform.multiply(new Matrix4().makeRotationAxis(axis.normalize(), number(3) * Math.PI / 180));
          break;
        }
        case 'transform':
          if (tokens.length >= 16) state.transform.copy(inheritedTransform).multiply(new Matrix4().fromArray(tokens.slice(0, 16).map(Number)));
          else warnings.add('Transform requires 16 numbers');
          break;
        case 'vertex': case 'vertexext': {
          const uvIndex = tokens.findIndex(t => t.toLowerCase() === 'uv');
          const prelightIndices = tokens.flatMap((token, index) => token.toLowerCase() === 'prelight' ? [index] : []);
          if (prelightIndices.length) {
            const index = prelightIndices[0], raw = tokens.slice(index + 1, index + 4), values = raw.map(Number);
            const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
            if (prelightIndices.length !== 1 || values.length !== 3 || raw.some(value => !numeric.test(value)) || numeric.test(tokens[index + 4] ?? '') || values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
              warnings.add('Invalid RWX PRELIGHT: expected one finite RGB triple in the range 0..1; retaining the prior clump value');
            } else {
              state.prelight.color = values as [number, number, number]; enablePrelight(state.prelight);
            }
          }
          state.vertices.push({ point: new Vector3(number(0), number(1), number(2)).applyMatrix4(state.transform), uv: uvIndex < 0 ? [0, 0] : [number(uvIndex + 1), number(uvIndex + 2)], prelight: state.prelight.color });
          if (state.vertices.length > 1_000_000) throw new Error('RWX exceeds vertex budget');
          break;
        }
        case 'triangle': case 'quad': case 'polygon': {
          const offset = command === 'polygon' ? 1 : 0;
          const count = command === 'triangle' ? 3 : command === 'quad' ? 4 : number(0);
          if (count > 4096) { warnings.add('Polygon exceeds 4096 vertices'); break; }
          const tagIndex = tokens.findIndex(t => t.toLowerCase() === 'tag');
          const faceState = tagIndex >= 0 ? { ...state, tag: number(tagIndex + 1) } : state;
          emitFace(tokens.slice(offset, offset + count).map(Number), faceState, line);
          break;
        }
        case 'color': state.material.color = [number(0, 1), number(1, 1), number(2, 1)].map(n => Math.max(0, Math.min(1, n))) as [number, number, number]; break;
        case 'opacity': state.material.opacity = Math.max(0, Math.min(1, number(0, 1))); break;
        case 'surface': state.material.roughness = Math.max(0.05, Math.min(1, 1 - number(2) * 0.7)); break;
        case 'texture': {
          state.material.texture = /^(null|delete)$/i.test(tokens[0] ?? '') ? undefined : tokens[0];
          const maskIndex = tokens.findIndex(t => t.toLowerCase() === 'mask');
          state.material.mask = maskIndex >= 0 ? tokens[maskIndex + 1] : undefined;
          break;
        }
        case 'texturemodes': case 'texturemode':
          state.material.unlit = !tokens.some(t => t.toLowerCase() === 'lit');
          break;
        case 'lightsampling': state.material.smooth = tokens[0]?.toLowerCase() === 'vertex'; break;
        case 'materialmodes': case 'materialmode': state.material.doubleSided = tokens.some(t => /^(double|doublesided)$/i.test(t)); break;
        case 'collision': state.solid = !/^(off|no|false)$/i.test(tokens[0] ?? ''); break;
        case 'tag': state.tag = number(0); break;
        case 'protoinstance': {
          if (++prototypeExpansions > maxPrototypeExpansions) throw new Error(`RWX exceeds prototype expansion budget (${maxPrototypeExpansions})`);
          const proto = prototypes.get(tokens[0]?.toLowerCase());
          if (proto) run(proto, { ...copy(state), vertices: [], prelight: prelightScope() }, depth + 1);
          else warnings.add(`Unknown prototype ${tokens[0]}`);
          break;
        }
        default: if (command) warnings.add(`Unsupported RWX command: ${command}`);
      }
    }
  };
  run(body, { transform: new Matrix4(), material: material(), vertices: [], prelight: prelightScope(), solid: true }, 0);
  if (result.parts.some(part => part.prelight && part.material.unlit)) warnings.add('PRELIGHT with legacy non-Lit TextureMode uses ambient-only modern shading; historical Surface and gamma parity are not reproduced');
  result.warnings = [...warnings];
  return result;
}

/** AW extensions after #! are executable, ordinary # comments are not. Quotes retain literal hashes. */
export function rwxLine(line: string): string {
  const pieces: string[] = [];
  let start = 0, quote = '';
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== '\\') {
      if (!quote) quote = character; else if (quote === character) quote = '';
    }
    if (!quote && character === '#') {
      pieces.push(line.slice(start, index));
      if (line[index + 1] !== '!') return pieces.join('').trim();
      pieces.push(' '); index++; start = index + 1;
    }
  }
  pieces.push(line.slice(start));
  return pieces.join('').trim();
}

export function tokenize(text: string): string[] {
  return (text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) ?? []).map(token => token.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2'));
}
