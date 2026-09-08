/** Original, deterministic CC0 Wayfarer avatar assets. No third-party geometry or motion.
 * Run `node scripts/axis-avatar-assets.mjs` to create missing generated files.
 * Run with --check to verify reproducibility without writing. Existing edits are preserved.
 * --studio selects a bundled offline JSON collection, never the live public/assets catalog.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(projectRoot, 'public', 'assets');
const studioBundle = join(projectRoot, 'src', 'renderer', 'engine', 'studio-avatar-data.json');
const decimal = n => Number(n.toFixed(6)).toString();
const metres = vector => vector.map(n => decimal(n / 10)).join(' ');

function avatarModel(palette) {
  const lines = ['# Original Wayfarer rigid-clump avatar. CC0 1.0.', 'ModelBegin', 'TextureModes Lit', 'LightSampling Facet', 'Surface .4 .7 .1'];
  const vertexCounts = [];
  const clump = (tag, position, body) => {
    lines.push('ClumpBegin', `Translate ${metres(position)}`, `Tag ${tag}`);
    vertexCounts.push(0); body(); vertexCounts.pop(); lines.push('ClumpEnd');
  };
  const box = (center, size, color) => {
    lines.push(`Color ${color.join(' ')}`);
    const start = vertexCounts.at(-1);
    for (const vertex of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]) {
      lines.push(`Vertex ${metres(vertex.map((v, index) => center[index] + v * size[index] / 2))}`);
    }
    for (const face of [[1,4,3,2],[5,6,7,8],[1,5,8,4],[2,3,7,6],[4,8,7,3],[1,2,6,5]]) lines.push(`Quad ${face.map(n => n + start).join(' ')}`);
    vertexCounts[vertexCounts.length - 1] += 8;
  };
  clump(1, [0, .95, 0], () => {
    box([0, 0, 0], [.34, .22, .24], palette.trousers);
    box([0, .075, .005], [.35, .045, .25], palette.trim);
    clump(2, [0, .12, 0], () => {
      box([0, .19, 0], [.4, .4, .25], palette.shirt);
      box([0, .2, .13], [.028, .34, .015], palette.trim);
      box([.1, .28, .135], [.07, .045, .018], [1, .84, .4]);
      clump(3, [0, .44, 0], () => {
        box([0, .01, 0], [.13, .1, .13], palette.skin);
        clump(4, [0, .06, 0], () => {
          box([0, .12, 0], [.26, .3, .25], palette.skin);
          box([0, .26, -.012], [.28, .08, .27], palette.hair);
          box([-.059, .15, .128], [.035, .031, .013], [.08, .11, .16]);
          box([.059, .15, .128], [.035, .031, .013], [.08, .11, .16]);
          box([0, .065, .128], [.072, .012, .014], [.44, .22, .16]);
        });
      });
      for (const [direction, shoulder, elbow, wrist] of [[-1, 6, 7, 8], [1, 11, 12, 13]]) {
        clump(shoulder, [direction * .255, .35, 0], () => {
          box([0, -.135, 0], [.16, .28, .18], palette.shirt);
          clump(elbow, [0, -.28, 0], () => {
            box([0, -.125, 0], [.13, .25, .15], palette.shirt);
            box([0, -.23, 0], [.14, .04, .16], palette.trim);
            clump(wrist, [0, -.275, 0], () => box([0, -.035, 0], [.135, .13, .14], palette.skin));
          });
        });
      }
    });
    for (const [direction, hip, knee, ankle] of [[-1, 15, 16, 17], [1, 19, 20, 21]]) {
      clump(hip, [direction * .105, -.09, 0], () => {
        box([0, -.185, 0], [.155, .38, .19], palette.trousers);
        clump(knee, [0, -.38, 0], () => {
          box([0, -.18, 0], [.145, .37, .17], palette.trousers);
          clump(ankle, [0, -.38, 0], () => box([0, -.045, .045], [.17, .095, .28], palette.boots));
        });
      });
    }
  });
  lines.push('ModelEnd'); return lines.join('\n') + '\n';
}

class SeqWriter {
  bytes = [];
  u16(n) { this.bytes.push(n >>> 8 & 255, n & 255); }
  u32(n) { this.bytes.push(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255); }
  f32(n) { const buffer = new Uint8Array(4); new DataView(buffer.buffer).setFloat32(0, n); this.bytes.push(...buffer); }
  string(value) { const bytes = strToU8(value); this.u16(bytes.length + 1); this.bytes.push(...bytes, 0); }
}
function binarySequence(frameCount, tracks) {
  const output = new SeqWriter(); output.u32(0x7f7f7f7a); output.u16(frameCount); output.u32(tracks.length); output.string('wayfarer-original'); output.string('pelvis');
  for (const [name, axis, keys] of tracks) {
    output.string(name); output.u32(16); output.u32(keys.length);
    for (const [frame, degrees] of keys) {
      const half = degrees * Math.PI / 360, sine = Math.sin(half);
      output.u32(frame); output.f32(Math.cos(half));
      for (const component of axis) output.f32(component * sine);
    }
  }
  output.u32(3);
  for (let axis = 0; axis < 3; axis++) { output.u32(4); output.u32(1); output.u32(1); output.f32(0); }
  return Uint8Array.from(output.bytes);
}
const cycle = (amplitude, direction = 1) => [[1, 0], [9, amplitude * direction], [16, 0], [24, -amplitude * direction], [31, 0]];
const idle = binarySequence(91, [
  ['back', [1, 0, 0], [[1, 0], [46, 1.5], [91, 0]]],
  ['head', [0, 1, 0], [[1, -2], [46, 2], [91, -2]]],
]);
const walk = binarySequence(31, [
  ['rthip', [1, 0, 0], cycle(26)], ['lfhip', [1, 0, 0], cycle(26, -1)],
  ['rtknee', [1, 0, 0], [[1, 0], [9, -20], [16, 0], [24, 0], [31, 0]]],
  ['lfknee', [1, 0, 0], [[1, 0], [9, 0], [16, 0], [24, -20], [31, 0]]],
  ['rtshoulder', [1, 0, 0], cycle(19, -1)], ['lfshoulder', [1, 0, 0], cycle(19)],
  ['back', [0, 1, 0], cycle(3)],
]);
const waveTimes = [0, 250, 700, 1000, 1300, 1600, 1900, 2200];
const wave = ['AWSQ Version=1 Limbs=3 Duration=2200',
  ...[
    ['lfshoulder', [0, 0, 1], [0, 110, 145, 145, 145, 145, 110, 0]],
    ['lfelbow', [0, 0, 1], [0, 15, -30, 10, -30, 10, 15, 0]],
    ['lfwrist', [0, 1, 0], [0, 0, -22, 22, -22, 22, 0, 0]],
  ].flatMap(([name, axis, angles]) => [`${name} frames=${waveTimes.length}`, ...waveTimes.map((time, index) => `${time} ${axis.join(' ')} ${angles[index]} 0 0 0`)]),
].join('\n') + '\n';

// An original forward bow with a short head nod. Feet and pelvis stay planted;
// every animated joint returns to its exact bind pose before the motion ends.
// This intentionally belongs only to the opt-in gesture fixture profile.
const bowTimes = [0, 200, 500, 900, 1200, 1450, 1750, 2100, 2400];
const bow = ['AWSQ Version=1 Limbs=5 Duration=2400',
  ...[
    ['back', [0, 0, 15, 32, 32, 26, 12, 0, 0]],
    ['neck', [0, 0, 2, 6, 6, 2, 0, 0, 0]],
    ['head', [0, 5, 14, 14, 8, 4, 0, 0, 0]],
    ['lfshoulder', [0, 0, -6, -12, -12, -10, -4, 0, 0]],
    ['rtshoulder', [0, 0, -6, -12, -12, -10, -4, 0, 0]],
  ].flatMap(([name, angles]) => [`${name} frames=${bowTimes.length}`, ...bowTimes.map((time, index) => `${time} 1 0 0 ${angles[index]} 0 0 0`)]),
].join('\n') + '\n';

const catalog = ['# Original Wayfarer catalog, CC0 1.0. Both entries are independently authored.', 'version 3',
  ...[['Wayfarer Voyager', 'wf-voyager.rwx'], ['Haven Keeper', 'wf-keeper.rwx']].flatMap(([name, geometry]) => [
    'avatar', ` name=${name}`, ` geometry=${geometry}`, ' autolook', ' autowalk', ' beginimp',
    '  idle=wf-idle', '  wait=wf-idle', '  endwait=wf-idle', '  walk=wf-walk', '  run=wf-walk',
    ' endimp', ' beginexp', '  Wave=wf-wave', ' endexp', 'endavatar',
  ]),
].join('\n') + '\n';
const voyager = avatarModel({ shirt: [.08, .4, .48], trim: [.05, .18, .25], trousers: [.12, .18, .25], skin: [.75, .47, .31], hair: [.1, .065, .055], boots: [.045, .07, .09] });
const keeper = avatarModel({ shirt: [.78, .4, .14], trim: [.27, .12, .09], trousers: [.27, .29, .23], skin: [.88, .67, .48], hair: [.23, .22, .2], boots: [.12, .085, .07] });
// ZIP encodes local calendar fields; construct the same local date in every time zone.
const zip = (name, bytes) => zipSync({ [name]: [bytes, { mtime: new Date(2000, 0, 1), level: 9 }] });
export function avatarFixtureAssets() {
  const files = new Map([
    ['avatars/avatars.dat', strToU8(catalog)],
    ['avatars/wf-voyager.rwx', strToU8(voyager)], ['avatars/wf-keeper.rwx', strToU8(keeper)],
    ['models/wf-voyager.rwx', strToU8(voyager)], ['models/wf-keeper.rwx', strToU8(keeper)],
    ['seqs/wf-idle.seq', idle], ['seqs/wf-walk.seq', walk], ['seqs/wf-wave.seq', strToU8(wave)],
    ['avatars/LICENSE.txt', strToU8('These Wayfarer avatar figures, catalog, and wf-* animation files are original work dedicated to the public domain under CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/\nNo Active Worlds assets are included.\n')],
  ]);
  for (const [name, bytes] of [...files]) if (/\.(dat|rwx|seq)$/.test(name) && !name.startsWith('models/')) files.set(name.replace(/\.[^.]+$/, '.zip'), zip(name.split('/').at(-1), bytes));
  return files;
}

/** Separate opt-in catalog: never changes the live fixture's gesture ordinals. */
export function avatarGestureFixtureAssets() {
  const files = avatarFixtureAssets();
  const gestureCatalog = catalog.replaceAll('  Wave=wf-wave\n', '  Wave=wf-wave\n  Bow=wf-bow\n');
  files.set('avatars/avatars.dat', strToU8(gestureCatalog));
  files.set('avatars/avatars.zip', zip('avatars.dat', strToU8(gestureCatalog)));
  files.set('seqs/wf-bow.seq', strToU8(bow));
  files.set('seqs/wf-bow.zip', zip('wf-bow.seq', strToU8(bow)));
  return files;
}

function ensureAssetFiles(files, destination, check) {
  // Preflight the complete set before creating anything. Modified or missing
  // files in check mode must not produce a partially refreshed fixture tree.
  for (const [name, bytes] of files) {
    const target = join(destination, name);
    if (existsSync(target)) {
      if (!readFileSync(target).equals(bytes)) throw new Error(`Preserving modified avatar fixture: ${target}`);
    } else if (check) throw new Error(`Missing avatar fixture: ${target}`);
  }
  if (!check) for (const [name, bytes] of files) {
    const target = join(destination, name);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' });
    }
  }
  return files.size;
}
export function ensureAvatarAssets({ check = false } = {}) {
  return ensureAssetFiles(avatarFixtureAssets(), fixtureRoot, check);
}
export function ensureStudioAvatarAssets({ check = false } = {}) {
  const files = avatarGestureFixtureAssets();
  const bytes = Buffer.from(JSON.stringify(Object.fromEntries(
    [...files].map(([name, content]) => [name, Buffer.from(content).toString('base64')]),
  ), null, 2) + '\n');
  if (existsSync(studioBundle)) {
    if (!readFileSync(studioBundle).equals(bytes)) throw new Error(`Preserving modified studio avatar bundle: ${studioBundle}`);
  } else {
    if (check) throw new Error(`Missing studio avatar bundle: ${studioBundle}`);
    mkdirSync(dirname(studioBundle), { recursive: true }); writeFileSync(studioBundle, bytes, { flag: 'wx' });
  }
  return files.size;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check'), studio = process.argv.includes('--studio');
  const count = (studio ? ensureStudioAvatarAssets : ensureAvatarAssets)({ check });
  console.log(`${check ? 'Verified' : 'Ready'}: ${count} original ${studio ? 'studio avatar bundled' : 'avatar fixture'} assets`);
}
