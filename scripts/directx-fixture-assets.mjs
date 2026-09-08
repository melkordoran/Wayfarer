/** Original CC0 DirectX fixtures. Importing creates no files or processes.
 * Text and binary encoders consume authored records independently; neither
 * parses/transcodes the other. No Microsoft/AW sample geometry is included.
 * Binary reference: https://learn.microsoft.com/en-us/windows/win32/direct3d9/token-records
 * Tokens are LE WORDs; normative TOKEN_STRING terminator is a LE DWORD.
 * A deliberately labeled WORD-terminator variant is not normative evidence.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync, zlibSync } from "fflate";
import {
  avatarFixtureAssets,
  avatarGestureFixtureAssets,
} from "./axis-avatar-assets.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T = Object.freeze({
  name: 1,
  string: 2,
  integer: 3,
  integerList: 6,
  floatList: 7,
  open: 10,
  close: 11,
  semicolon: 20,
});
const decimal = (value) => Number(value.toFixed(9)).toString();
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x, y, z) => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];
const yQuarter = (x, y, z) => [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, x, y, z, 1];
const point = (v, matrix) =>
  [0, 1, 2].map((column) =>
    v.reduce(
      (sum, value, row) => sum + value * matrix[row * 4 + column],
      matrix[12 + column],
    ),
  );
const ints = (values, text) => ({
  kind: "ints",
  values,
  text: text ?? values.join(";") + ";",
});
const floats = (values, text) => ({
  kind: "floats",
  values,
  text: text ?? values.map(decimal).join(";") + ";",
});
const string = (value) => ({ kind: "string", value });
const object = (type, name, parts) => ({ kind: "object", type, name, parts });
const reference = (name) => ({ kind: "reference", name });
const skinTemplates = () => [
  {
    kind: "template",
    name: "XSkinMeshHeader",
    guid: "3cf169ce-ff7c-44ab-93c0-f78f62d172e2",
    members: [
      ["WORD", "nMaxSkinWeightsPerVertex"],
      ["WORD", "nMaxSkinWeightsPerFace"],
      ["WORD", "nBones"],
    ],
  },
  {
    kind: "template",
    name: "SkinWeights",
    guid: "6f0d123b-bad2-4167-a0d0-80224f25fabb",
    members: [
      ["STRING", "transformNodeName"],
      ["DWORD", "nWeights"],
      ["DWORD", "vertexIndices", "nWeights"],
      ["FLOAT", "weights", "nWeights"],
      ["Matrix4x4", "matrixOffset"],
    ],
  },
];
const vectors = (values) =>
  floats(
    values.flat(),
    values.map((v) => v.map(decimal).join(";") + ";").join(",\n") + ";",
  );
const matrix = (values) =>
  object("FrameTransformMatrix", "", [
    floats(values, values.map(decimal).join(",") + ";;"),
  ]);
const faces = (values) =>
  ints(
    values.flatMap((v) => [v.length, ...v]),
    values.map((v) => `${v.length};${v.join(",")};`).join(",\n") + ";",
  );
const material = (name, color, texture) =>
  object("Material", name, [
    floats(color, color.map(decimal).join(";") + ";;"),
    floats([8]),
    floats([0.1, 0.1, 0.1], ".1;.1;.1;;"),
    floats([0, 0, 0], "0;0;0;;"),
    ...(texture ? [object("TextureFilename", "", [string(texture)])] : []),
  ]);
const materialRecords = () => [
  material("OriginalTeal", [1, 1, 1, 1], "wf-x-corners.png"),
  material("OriginalGold", [0.92, 0.58, 0.18, 0.65]),
];

function meshRecord(mesh) {
  return object("Mesh", mesh.name, [
    ints([mesh.vertices.length]),
    vectors(mesh.vertices),
    ints([mesh.faces.length]),
    faces(mesh.faces),
    object("MeshNormals", "", [
      ints([mesh.normals.length]),
      vectors(mesh.normals),
      ints([mesh.normalFaces.length]),
      faces(mesh.normalFaces),
    ]),
    object("MeshTextureCoords", "", [ints([mesh.uv.length]), vectors(mesh.uv)]),
    object("MeshMaterialList", "", [
      ints([2]),
      ints([mesh.faces.length]),
      ints(mesh.materials, mesh.materials.join(",") + ";;"),
      ...materialRecords(),
    ]),
    ...(mesh.bones
      ? [
          object("XSkinMeshHeader", "", [ints([2, 2, mesh.bones.length])]),
          ...mesh.bones.map((bone) => {
            const influenced = mesh.weights
              .map((weights, index) => ({
                index,
                weight:
                  weights.find((value) => value.bone === bone.name)?.weight ??
                  0,
              }))
              .filter((value) => value.weight > 0);
            return object("SkinWeights", "", [
              string(bone.name),
              ints([influenced.length]),
              ints(
                influenced.map((value) => value.index),
                influenced.map((value) => value.index).join(",") + ";",
              ),
              floats(
                influenced.map((value) => value.weight),
                influenced.map((value) => decimal(value.weight)).join(",") +
                  ";",
              ),
              floats(bone.offset, bone.offset.map(decimal).join(",") + ";;"),
            ]);
          }),
        ]
      : []),
  ]);
}

function staticDefinition() {
  const vertices = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0.5, 0],
    [1, 0.5, 0],
    [1, 1.5, 0],
    [0, 1.5, 0],
    [0, 0, -0.25],
    [1, 0, -0.25],
    [0, 0, 0.75],
  ];
  const mesh = {
    name: "OriginalConcaveMarker",
    vertices,
    faces: [
      [0, 1, 2, 3, 4, 5],
      [6, 8, 7],
    ],
    normals: [
      [0, 0, 1],
      [0, 1, 0],
    ],
    normalFaces: [
      [0, 0, 0, 0, 0, 0],
      [1, 1, 1],
    ],
    uv: [
      [0, 1],
      [1, 1],
      [1, 2 / 3],
      [0.5, 2 / 3],
      [0.5, 0],
      [0, 0],
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    materials: [0, 1],
  };
  const parent = yQuarter(3, 0, -2),
    child = translation(1, 0.5, 2);
  return {
    mesh,
    parent,
    child,
    records: [
      object("Frame", "MarkerParent", [
        matrix(parent),
        object("Frame", "MarkerChild", [matrix(child), meshRecord(mesh)]),
      ]),
    ],
  };
}

function skinnedDefinition() {
  // Source is RH/+Y up. One source unit is one metre in THIS original asset.
  // This authoring choice is not evidence for historical AW .x unit scaling.
  const spec = [
    ["aw_pelvis", null, [0, 0.95, 0]],
    ["aw_back", "aw_pelvis", [0, 0.1, 0]],
    ["aw_neck", "aw_back", [0, 0.4, 0]],
    ["aw_head", "aw_neck", [0, 0.08, 0]],
    ["aw_lfshoulder", "aw_back", [0.25, 0.3, 0]],
    ["aw_lfelbow", "aw_lfshoulder", [0, -0.3, 0]],
    ["aw_lfwrist", "aw_lfelbow", [0, -0.3, 0]],
    ["aw_rtshoulder", "aw_back", [-0.25, 0.3, 0]],
    ["aw_rtelbow", "aw_rtshoulder", [0, -0.3, 0]],
    ["aw_rtwrist", "aw_rtelbow", [0, -0.3, 0]],
    ["aw_lfhip", "aw_pelvis", [0.1, -0.1, 0]],
    ["aw_lfknee", "aw_lfhip", [0, -0.38, 0]],
    ["aw_lfankle", "aw_lfknee", [0, -0.38, 0]],
    ["aw_rthip", "aw_pelvis", [-0.1, -0.1, 0]],
    ["aw_rtknee", "aw_rthip", [0, -0.38, 0]],
    ["aw_rtankle", "aw_rtknee", [0, -0.38, 0]],
  ];
  const bones = [];
  for (const [name, parent, local] of spec) {
    const origin = local.map(
      (value, axis) =>
        value + (bones.find((bone) => bone.name === parent)?.origin[axis] ?? 0),
    );
    bones.push({
      name,
      parent,
      local,
      origin,
      rest: translation(...local),
      offset: translation(...origin.map((value) => -value)),
    });
  }
  const mesh = {
    name: "OriginalWeightedVoyager",
    vertices: [],
    faces: [],
    normals: [],
    normalFaces: [],
    uv: [],
    materials: [],
    weights: [],
    bones,
  };
  const addFace = (indices, mat = 0) => {
    const [a, b, c] = indices.map((index) => mesh.vertices[index]);
    const u = b.map((value, axis) => value - a[axis]),
      v = c.map((value, axis) => value - a[axis]);
    const cross = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ],
      length = Math.hypot(...cross);
    const normal = mesh.normals.length;
    mesh.normals.push(cross.map((value) => value / length));
    mesh.faces.push(indices);
    mesh.normalFaces.push(indices.map(() => normal));
    mesh.materials.push(mat);
  };
  const box = (center, size, bone, mat = 0) => {
    const start = mesh.vertices.length;
    for (const xyz of [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ]) {
      mesh.vertices.push(
        xyz.map((value, axis) => center[axis] + (value * size[axis]) / 2),
      );
      mesh.weights.push([{ bone, weight: 1 }]);
      mesh.uv.push([(xyz[0] + 1) / 2, 1 - (xyz[1] + 1) / 2]);
    }
    for (const face of [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
      [3, 7, 6, 2],
      [0, 1, 5, 4],
    ])
      addFace(
        face.map((index) => start + index),
        mat,
      );
  };
  box([0, 0.95, 0], [0.34, 0.2, 0.24], "aw_pelvis", 1);
  box([0, 1.22, 0], [0.4, 0.4, 0.24], "aw_back");
  box([0, 1.47, 0], [0.12, 0.08, 0.12], "aw_neck", 1);
  box([0, 1.66, 0.015], [0.25, 0.27, 0.24], "aw_head", 1);
  box([0.25, 1.29, 0], [0.14, 0.15, 0.16], "aw_lfshoulder");
  box([0.25, 0.74, 0.02], [0.14, 0.14, 0.17], "aw_lfwrist", 1);
  box([-0.25, 1.2, 0], [0.14, 0.3, 0.16], "aw_rtshoulder");
  box([-0.25, 0.91, 0], [0.12, 0.28, 0.14], "aw_rtelbow");
  box([-0.25, 0.74, 0.02], [0.14, 0.14, 0.17], "aw_rtwrist", 1);
  for (const [x, side] of [
    [0.1, "lf"],
    [-0.1, "rt"],
  ]) {
    box([x, 0.67, 0], [0.15, 0.37, 0.18], `aw_${side}hip`);
    box([x, 0.29, 0], [0.14, 0.37, 0.16], `aw_${side}knee`);
    box([x, 0.065, 0.06], [0.17, 0.1, 0.28], `aw_${side}ankle`, 1);
  }
  const elbowStart = mesh.vertices.length;
  for (const [ring, y] of [1.2, 1.05, 0.9].entries())
    for (const [corner, [dx, dz]] of [
      [-0.07, -0.07],
      [0.07, -0.07],
      [0.07, 0.07],
      [-0.07, 0.07],
    ].entries()) {
      mesh.vertices.push([0.25 + dx, y, dz]);
      mesh.uv.push([corner / 3, ring / 2]);
      const elbowWeight =
        ring === 0 ? 0 : ring === 2 ? 1 : corner === 1 ? 0.75 : 0.5;
      mesh.weights.push(
        [
          { bone: "aw_lfshoulder", weight: 1 - elbowWeight },
          { bone: "aw_lfelbow", weight: elbowWeight },
        ].filter((value) => value.weight > 0),
      );
    }
  for (let ring = 0; ring < 2; ring++)
    for (let side = 0; side < 4; side++)
      addFace([
        elbowStart + ring * 4 + side,
        elbowStart + ring * 4 + ((side + 1) % 4),
        elbowStart + (ring + 1) * 4 + ((side + 1) % 4),
        elbowStart + (ring + 1) * 4 + side,
      ]);
  addFace([elbowStart + 3, elbowStart + 2, elbowStart + 1, elbowStart]);
  addFace([elbowStart + 8, elbowStart + 9, elbowStart + 10, elbowStart + 11]);
  const frame = (bone) =>
    object("Frame", bone.name, [
      matrix(bone.rest),
      ...bones.filter((value) => value.parent === bone.name).map(frame),
    ]);
  const parent = yQuarter(0.25, 0, 0.5);
  return {
    mesh,
    parent,
    elbowStart,
    records: [
      ...skinTemplates(),
      object("Frame", "OriginalAvatarRoot", [
        matrix(parent),
        frame(bones[0]),
        meshRecord(mesh),
      ]),
    ],
  };
}

function textRecords(records) {
  const lines = [];
  function emit(record, depth) {
    const pad = " ".repeat(depth);
    if (record.kind === "template") {
      lines.push(
        `${pad}template ${record.name} {`,
        `${pad} <${record.guid}>`,
        ...record.members.map(
          ([type, name, count]) =>
            `${pad} ${count ? "array " : ""}${type} ${name}${count ? "[" + count + "]" : ""};`,
        ),
        pad + "}",
      );
    } else if (record.kind === "object") {
      lines.push(
        `${pad}${record.type}${record.name ? " " + record.name : ""} {`,
      );
      record.parts.forEach((part) => emit(part, depth + 1));
      lines.push(pad + "}");
    } else if (record.kind === "reference")
      lines.push(`${pad}{ ${record.name} }`);
    else if (record.kind === "string")
      lines.push(pad + JSON.stringify(record.value) + ";");
    else lines.push(...record.text.split("\n").map((value) => pad + value));
  }
  records.forEach((record) => emit(record, 0));
  return (
    "xof 0303txt 0032\n// Original Wayfarer fixture. CC0. RH, +Y up, authored source units.\n" +
    lines.join("\n") +
    "\n"
  );
}

class BinaryWriter {
  chunks = [];
  constructor(bits, stringTerminatorBytes = 4) {
    this.bits = bits;
    this.stringTerminatorBytes = stringTerminatorBytes;
  }
  number(value, bytes) {
    const data = new Uint8Array(bytes),
      view = new DataView(data.buffer);
    if (bytes === 2) view.setUint16(0, value, true);
    else view.setUint32(0, value, true);
    this.chunks.push(data);
  }
  word(value) {
    this.number(value, 2);
  }
  dword(value) {
    this.number(value, 4);
  }
  name(value) {
    const bytes = strToU8(value);
    this.word(T.name);
    this.dword(bytes.length);
    this.chunks.push(bytes);
  }
  record(record) {
    if (record.kind === "template") {
      this.word(31);
      this.name(record.name);
      this.word(T.open);
      this.word(5);
      const [a, b, c, d, e] = record.guid.split("-");
      this.dword(parseInt(a, 16));
      this.word(parseInt(b, 16));
      this.word(parseInt(c, 16));
      this.chunks.push(
        Uint8Array.from(
          (d + e).match(/../g).map((value) => parseInt(value, 16)),
        ),
      );
      for (const [type, name, count] of record.members) {
        if (count) this.word(52);
        const primitive = { WORD: 40, DWORD: 41, FLOAT: 42, STRING: 49 }[type];
        if (primitive) this.word(primitive);
        else this.name(type);
        this.name(name);
        if (count) {
          this.word(14);
          this.name(count);
          this.word(15);
        }
        this.word(T.semicolon);
      }
      this.word(T.close);
    } else if (record.kind === "object") {
      this.name(record.type);
      if (record.name) this.name(record.name);
      this.word(T.open);
      record.parts.forEach((part) => this.record(part));
      this.word(T.close);
    } else if (record.kind === "reference") {
      this.word(T.open);
      this.name(record.name);
      this.word(T.close);
    } else if (record.kind === "string") {
      const bytes = strToU8(record.value);
      this.word(T.string);
      this.dword(bytes.length);
      this.chunks.push(bytes);
      this.number(T.semicolon, this.stringTerminatorBytes);
    } else {
      this.word(record.kind === "ints" ? T.integerList : T.floatList);
      this.dword(record.values.length);
      for (const value of record.values) {
        if (record.kind === "ints") this.dword(value);
        else {
          const data = new Uint8Array(this.bits / 8),
            view = new DataView(data.buffer);
          if (this.bits === 32) view.setFloat32(0, value, true);
          else view.setFloat64(0, value, true);
          this.chunks.push(data);
        }
      }
    }
  }
  finish(records) {
    records.forEach((record) => this.record(record));
    return concat([strToU8(`xof 0303bin 00${this.bits}`), ...this.chunks]);
  }
}
const concat = (chunks) => {
  const bytes = new Uint8Array(
    chunks.reduce((count, value) => count + value.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};
const binary = (records, bits, terminatorBytes = 4) =>
  new BinaryWriter(bits, terminatorBytes).finish(records);
const zip = (name, bytes) =>
  zipSync({ [name]: [bytes, { mtime: new Date(2000, 0, 1), level: 9 }] });

function cornersPng() {
  const width = 32,
    height = 32,
    raw = new Uint8Array(height * (1 + width * 4));
  const palette = [
    [30, 180, 160],
    [235, 180, 65],
    [95, 100, 220],
    [220, 75, 100],
  ];
  const glyphs = {
    T: ["111", "010", "010", "010", "010"],
    L: ["100", "100", "100", "100", "111"],
    R: ["110", "101", "110", "101", "101"],
    B: ["110", "101", "110", "101", "110"],
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * (width * 4 + 1) + 1 + x * 4;
      raw.set([...palette[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)], 255], p);
    }
  for (const [x, y, label] of [
    [4, 4, "TL"],
    [20, 4, "TR"],
    [4, 20, "BL"],
    [20, 20, "BR"],
  ])
    for (let c = 0; c < 2; c++)
      for (let row = 0; row < 5; row++)
        for (let col = 0; col < 3; col++)
          if (glyphs[label[c]][row][col] === "1") {
            const p = (y + row) * 129 + 1 + (x + c * 4 + col) * 4;
            raw.set([12, 20, 30, 255], p);
          }
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const body = concat([strToU8(name), bytes]),
      header = new Uint8Array(4),
      tail = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, bytes.length);
    new DataView(tail.buffer).setUint32(0, crc(body));
    return concat([header, body, tail]);
  };
  const ihdr = new Uint8Array(13),
    view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concat([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

export function directXFixtureSources() {
  return {
    staticText: textRecords(staticDefinition().records),
    skinnedText: textRecords(skinnedDefinition().records),
  };
}
export function directXFixtureExpectations() {
  const staticModel = staticDefinition(),
    skin = skinnedDefinition();
  return structuredClone({
    source: {
      handedness: "right",
      up: "+Y",
      units:
        "One source unit is one metre in these original fixtures only; historical AW unit parity is unverified.",
    },
    static: {
      vertices: staticModel.mesh.vertices,
      faces: staticModel.mesh.faces,
      materials: staticModel.mesh.materials,
      uv: staticModel.mesh.uv,
      parent: staticModel.parent,
      child: staticModel.child,
      transformedVertices: staticModel.mesh.vertices.map((v) =>
        point(point(v, staticModel.child), staticModel.parent),
      ),
      bounds: { min: [4.75, 0.5, -5], max: [5.75, 2, -3] },
      concaveArea: 2,
    },
    skinned: {
      vertices: skin.mesh.vertices,
      faces: skin.mesh.faces,
      weights: skin.mesh.weights,
      bones: skin.mesh.bones,
      parent: skin.parent,
      bindVertices: skin.mesh.vertices.map((v) => point(v, skin.parent)),
      elbowWitness: {
        index: skin.elbowStart + 10,
        bind: [0.32, 0.9, 0.18],
        rotated90Z: [0.32, 1.12, 0.1],
      },
      blendedWitness: {
        index: skin.elbowStart + 6,
        bind: [0.32, 1.05, 0.18],
        rotated90Z: [0.32, 1.085, 0.215],
      },
    },
    binary: {
      tokenBytes: 2,
      countBytes: 4,
      stringTerminatorBytes: 4,
      endian: "little",
      floatBits: [32, 64],
    },
  });
}
export function directXFixtureAssets() {
  const files = new Map(),
    definitions = [
      ["models/wf-x-marker", staticDefinition()],
      ["avatars/wf-x-voyager", skinnedDefinition()],
    ];
  for (const [stem, definition] of definitions)
    for (const [suffix, bytes] of [
      ["", strToU8(textRecords(definition.records))],
      ["-binary32", binary(definition.records, 32)],
      ["-binary64", binary(definition.records, 64)],
    ]) {
      files.set(stem + suffix + ".x", bytes);
      files.set(
        stem + suffix + ".zip",
        zip(basename(stem + suffix + ".x"), bytes),
      );
    }
  const catalog =
    new TextDecoder().decode(avatarFixtureAssets().get("avatars/avatars.dat")) +
    "avatar\n name=Original DirectX Voyager\n geometry=wf-x-voyager.x\n autolook\n autowalk\n beginimp\n  idle=wf-idle\n  walk=wf-walk\n endimp\n beginexp\n  Wave=wf-wave\n endexp\nendavatar\n";
  files.set("avatars/avatars.dat", strToU8(catalog));
  files.set("avatars/avatars.zip", zip("avatars.dat", strToU8(catalog)));
  files.set("textures/wf-x-corners.png", cornersPng());
  files.set(
    "directx-LICENSE.txt",
    strToU8(
      "Original Wayfarer DirectX geometry, skin weights, numeric fixtures, texture pixels and catalog additions. CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/\nNo Active Worlds or Microsoft sample assets are included. Source coordinates are right-handed and +Y up; fixture authoring units are not proof of historical AW unit scaling.\n",
    ),
  );
  return files;
}
/** Offline-only overlay. Existing RWX studio assets and ordinals remain intact;
 * these exact six entries do not alter the public world-owned asset collection. */
export function studioDirectXFixtureAssets() {
  const positive = directXFixtureAssets(),
    files = new Map();
  // The shared diagnostic model deliberately has a Y90 translated parent. Only
  // the studio presentation removes that stress transform: geometry, named
  // joints, inverse offsets and original SEQ motions remain unchanged.
  const studio = skinnedDefinition();
  const root = studio.records.find(record => record.kind === 'object' && record.name === 'OriginalAvatarRoot');
  root.parts[0] = matrix(identity());
  const geometry = strToU8(textRecords(studio.records));
  files.set('avatars/wf-x-voyager.x', geometry);
  files.set('avatars/wf-x-voyager.zip', zip('wf-x-voyager.x', geometry));
  files.set('textures/wf-x-corners.png', positive.get('textures/wf-x-corners.png'));
  const original = new TextDecoder().decode(
    avatarGestureFixtureAssets().get("avatars/avatars.dat"),
  );
  const catalog =
    original +
    "avatar\n name=Original DirectX Voyager\n geometry=wf-x-voyager.x\n autolook\n autowalk\n beginimp\n  idle=wf-idle\n  wait=wf-idle\n  endwait=wf-idle\n  walk=wf-walk\n  run=wf-walk\n endimp\n beginexp\n  Wave=wf-wave\n  Bow=wf-bow\n endexp\nendavatar\n";
  files.set("avatars/avatars.dat", strToU8(catalog));
  files.set("avatars/avatars.zip", zip("avatars.dat", strToU8(catalog)));
  files.set("avatars/directx-LICENSE.txt", positive.get("directx-LICENSE.txt"));
  return files;
}
/** Studio-only source-space oracle; never changes the stress-model baseline. */
export function studioDirectXFixtureExpectations() {
  const value = directXFixtureExpectations().skinned;
  value.parent = identity();
  value.bindVertices = value.vertices.map(vertex => [...vertex]);
  value.elbowWitness = { index: value.elbowWitness.index, bind: [.32,.9,.07], rotated90Z: [.4,1.12,.07] };
  value.blendedWitness = { index: value.blendedWitness.index, bind: [.32,1.05,.07], rotated90Z: [.285,1.085,.07] };
  return value;
}
export function studioDirectXFixtureJson() {
  return strToU8(
    JSON.stringify(
      Object.fromEntries(
        [...studioDirectXFixtureAssets()].map(([name, bytes]) => [
          name,
          Buffer.from(bytes).toString("base64"),
        ]),
      ),
      null,
      2,
    ) + "\n",
  );
}
export function ensureStudioDirectXFixtures({ check = false } = {}) {
  const path = join(project, "src/renderer/engine/studio-directx-data.json"),
    bytes = studioDirectXFixtureJson();
  if (existsSync(path)) {
    if (
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile() ||
      !readFileSync(path).equals(bytes)
    )
      throw new Error("Preserving modified studio DirectX bundle.");
  } else {
    if (check) throw new Error("Missing studio DirectX bundle.");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  return studioDirectXFixtureAssets().size;
}
export function directXMalformedFixtures() {
  const definition = staticDefinition(),
    skin = skinnedDefinition(),
    source = textRecords(skin.records),
    normal = binary(definition.records, 32);
  const hugeList = concat([
    strToU8("xof 0303bin 0032"),
    Uint8Array.from([7, 0, 255, 255, 255, 127]),
  ]);
  const embedded = [
    ...definition.records,
    object("AnimTicksPerSecond", "", [ints([30])]),
    object("AnimationSet", "OriginalWarningOnly", [
      object("Animation", "", [
        reference("MarkerChild"),
        object("AnimationKey", "", [
          ints([2, 2, 0, 3]),
          floats([1, 0.5, 2]),
          ints([30, 3]),
          floats([2, 0.5, 2]),
        ]),
      ]),
    ]),
  ];
  return new Map([
    ["truncated-binary32.x", normal.slice(0, -3)],
    ["overflow-float-count.x", hugeList],
    [
      "unsupported-compressed.x",
      concat([strToU8("xof 0303bzip0032"), new Uint8Array(8)]),
    ],
    ["missing-bone.x", strToU8(source.replace('"aw_lfelbow"', '"aw_missing"'))],
    [
      "negative-weight.x",
      strToU8(source.replace("1,1,1,1,1,1,1,1;", "-1,1,1,1,1,1,1,1;")),
    ],
    [
      "nonunit-weight.x",
      strToU8(source.replace("1,1,1,1,1,1,1,1;", ".5,1,1,1,1,1,1,1;")),
    ],
    [
      "out-of-range-face.x",
      strToU8(
        textRecords(definition.records).replace(
          "6;0,1,2,3,4,5;",
          "6;0,1,2,3,4,9999;",
        ),
      ),
    ],
    [
      "duplicate-frame-name.x",
      strToU8(source.replace("Frame aw_lfelbow {", "Frame aw_lfshoulder {")),
    ],
    // These are labeled compatibility/warning probes, not necessarily invalid files.
    ["compat-word-string-terminator.x", binary(definition.records, 32, 2)],
    ["warning-embedded-animation.x", strToU8(textRecords(embedded))],
  ]);
}

export function writeDirectXFixtureAssets(destination, { check = false } = {}) {
  const parent = join(project, "tests/fixtures"),
    target = resolve(destination);
  if (
    dirname(target) !== parent ||
    !/^directx(?:-[a-z0-9]+)?$/i.test(basename(target)) ||
    realpathSync(parent) !== parent
  )
    throw new Error(
      "Choose an explicit tests/fixtures/directx[-name] output directory.",
    );
  if (
    existsSync(target) &&
    (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory())
  )
    throw new Error("Fixture output cannot be a link or file.");
  const files = directXFixtureAssets();
  for (const [name, bytes] of directXMalformedFixtures())
    files.set("probes/" + name, bytes);
  for (const [name, bytes] of files) {
    const path = join(target, name);
    let current = dirname(path);
    while (current !== target) {
      if (
        existsSync(current) &&
        (!lstatSync(current).isDirectory() ||
          lstatSync(current).isSymbolicLink())
      )
        throw new Error("Fixture parent cannot be linked.");
      current = dirname(current);
    }
    if (existsSync(path)) {
      if (
        !lstatSync(path).isFile() ||
        lstatSync(path).isSymbolicLink() ||
        !readFileSync(path).equals(bytes)
      )
        throw new Error("Preserving modified DirectX fixture: " + path);
    } else if (check) throw new Error("Missing DirectX fixture: " + path);
  }
  if (!check)
    for (const [name, bytes] of files) {
      const path = join(target, name);
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      }
    }
  return files.size;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    outputs = args.filter((value) => value.startsWith("--output="));
  const studio = args.includes("--studio");
  if (
    outputs.length !== (studio ? 0 : 1) ||
    args.some(
      (value) =>
        value !== "--check" &&
        value !== "--studio" &&
        !value.startsWith("--output="),
    ) ||
    args.filter((value) => value === "--check").length > 1 ||
    args.filter((value) => value === "--studio").length > 1
  )
    throw new Error(
      "Usage: node scripts/directx-fixture-assets.mjs (--output=tests/fixtures/directx | --studio) [--check]",
    );
  const count = studio
    ? ensureStudioDirectXFixtures({ check: args.includes("--check") })
    : writeDirectXFixtureAssets(outputs[0].slice(9), {
        check: args.includes("--check"),
      });
  console.log(
    `${args.includes("--check") ? "Verified" : "Created"} ${count} original ${studio ? "studio " : ""}DirectX fixture files.`,
  );
}
