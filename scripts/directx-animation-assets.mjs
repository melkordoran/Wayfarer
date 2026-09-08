/** Original CC0 salute animation. Importing performs no I/O or process changes.
 * All encoders consume authored typed records, never a production parser.
 * Coordinates are RH/+Y up; the selected Microsoft X encoding uses WXYZ with
 * conjugated vector components. This is not historical AW exporter evidence.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { zipSync } from 'fflate';
import { studioDirectXFixtureAssets } from './directx-fixture-assets.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(project, 'src/renderer/engine/studio-directx-animation-data.json');
const utf8 = value => new TextEncoder().encode(value);
const decimal = value => Number(value.toFixed(15)).toString();
const concatenate = parts => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
};
const word = value => { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); return bytes; };
const dword = value => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; };

function tracks() {
  const authored = [
    { name: 'aw_pelvis', axis: [0, 0, 1], angles: [[0, 0], [120, 0]] },
    { name: 'aw_shoulder_l', axis: [0, 0, 1], angles: [[0, 0], [30, 0], [42, 55], [48, 90], [72, 90], [84, 75], [102, 30], [120, 0]] },
    { name: 'aw_elbow_l', axis: [0, 0, 1], angles: [[0, 0], [12, 35], [30, 90], [42, 120], [48, 135], [72, 135], [84, 110], [102, 45], [120, 0]] },
    { name: 'aw_head', axis: [1, 0, 0], angles: [[0, 0], [30, 0], [48, 8], [66, 8], [78, 0], [120, 0]] },
  ];
  return authored.map(track => ({
    ...track,
    keys: track.angles.map(([tick, degrees]) => {
      const half = degrees * Math.PI / 360;
      return { tick, values: [Math.cos(half), ...track.axis.map(value => value ? -value * Math.sin(half) : 0)] };
    }),
  }));
}

function textAnimation(definition) {
  const lines = [
    'xof 0303txt 0032',
    '// Original Wayfarer salute. CC0. Selected Microsoft X quaternion encoding.',
    'AnimationSet OriginalWayfarerSalute {',
    '  AnimTicksPerSecond { 30; }',
  ];
  for (const track of definition) {
    lines.push('  Animation {', `    { ${track.name} }`, '    AnimationOptions { 1; 1; }', '    AnimationKey {', '      0;', `      ${track.keys.length};`);
    track.keys.forEach((key, index) => lines.push(`      ${key.tick};4;${key.values.map(decimal).join(',')};;${index === track.keys.length - 1 ? ';' : ','}`));
    lines.push('    }', '  }');
  }
  lines.push('}', '');
  return utf8(lines.join('\r\n'));
}

function binaryAnimation(definition, floatBits) {
  const parts = [utf8(`xof 0303bin 00${floatBits}`)];
  const token = value => parts.push(word(value));
  const name = value => { token(1); const bytes = utf8(value); parts.push(dword(bytes.length), bytes); };
  const integer = value => { token(3); parts.push(dword(value)); };
  const floats = values => {
    token(7); parts.push(dword(values.length));
    const bytes = new Uint8Array(values.length * floatBits / 8), view = new DataView(bytes.buffer);
    values.forEach((value, index) => floatBits === 32 ? view.setFloat32(index * 4, value, true) : view.setFloat64(index * 8, value, true));
    parts.push(bytes);
  };
  const open = (type, label) => { name(type); if (label) name(label); token(10); };
  const close = () => token(11);
  open('AnimationSet', 'OriginalWayfarerSalute');
  open('AnimTicksPerSecond'); integer(30); close();
  for (const track of definition) {
    open('Animation');
    token(10); name(track.name); close();
    open('AnimationOptions'); integer(1); integer(1); close();
    open('AnimationKey'); integer(0); integer(track.keys.length);
    for (const key of track.keys) { integer(key.tick); integer(4); floats(key.values); }
    close(); close();
  }
  close();
  return concatenate(parts);
}

/** Original compressed transport fixtures, first authored with zlib 1.2.12.
 * DEFLATE has no canonical compressor output: official Node 22.22.2's bundled
 * zlib 1.3.1-e00f703 produces different bytes from the same authored input.
 * Preserve the already published original streams rather than silently
 * rewriting studio-directx-animation-data.json for the host compressor.
 * These are NOT retail/sample assets or bytes read from the generated bundle.
 * Each body's SHA-256 and every independently inflated chunk must still match
 * the typed-record serializers; changing the animation requires an
 * explicit new fixture version, not an unchecked reuse of compressed bytes.
 */
const COMPRESSED_ANIMATION_FIXTURES = Object.freeze({
  tzip: Object.freeze({
    sha256: '30727a40e7844324441434341e768f7ec87e385748388a1c79c723ecc32bbcd8',
    chunks: Object.freeze([
      'rVJdS8NAEHwv9D/sD6hxb++bPEkfRSpU0LcSk2sNxqQmqaUU/7vXxNS0iMVS7jiW2Zm5PeaGg+trmJTpIs2jDB6jzTwqXQlVlK1qF8B4jAFMXebi2iVwl8ZlURXzGp7gfRXVrszTIgeXx0WS5otgOLjJ07eo9uDU1XvbznXamMJ2OADYER/S+LW697iLizyBLXAM4bPrNjYtGXwvWs+WLvtIq5bR40yWu7PyHBbu9nH/1m06GwAMu4rCH0yEbIS7FYajDmV0gH+zG/M/ZqxeilWWuHKWXWpOc2JO/jssyMMYGKORoeGcaUNEDe0KA6GYFkYxTlwiF32daXQaNUOlDWNGSWE63SGsezpN5+mMaHWWc8m5QLLMz9TpFBqtmCCLviDWjwfbC62SlqQhRcai2l/oIcMsCul58lB4Vq4uey7WlwvVnvx87eMk10xZiT4sIt09jiNqlNr6hiDNjz/Df1L4Ag==',
      'rZRRCgIxDESv1CaTSXIcQcH7n8Cs7haq+2MV+hWYMp15zUzLyD3Iyg1NPQDNTz60Eg9F8UNrechSNLxMi/UucYLHt7KdDnM1J5RafYLDZc9u0gCJyJQzOuabR4CTjZ/huN8u13+RwcXv/qol041oVuVlCLa3Nj5nrg50sTcduabzWFiadR4=',
    ]),
  }),
  bzip: Object.freeze({
    sha256: '751e4b0735e1d27ee05c722c81bce735344e6091c7c429c5251900dea75fa178',
    chunks: Object.freeze([
      'Y2TgYWBgcMzLzE0syczPC04tYWQQA4r4F2WmZ+Yl5oQnVqYlFqUWBSfmlJakcjEwMghB1YdkJmcXBwBlUpPz81K4GJgZ5IAy3EAVnMgmcjFwQYUSy+MLUnPKMotBagSQ1fgXgMhikBmMQHEICVKF4jbv1EqQCgawCiYwCWGzAEl2MMnA0GDPgAANzAwVBFRw43IxL8TFxRn5pTkpqUXxOdRwNQeRrpYjqEILTYWKcDJcRUDWm33MDAZoKj6zmMJVANn7mRk8CKoIQVNhIukNV3HqujRQRRqaildu5XAV75pb9lEQA1yQGEjNScovp07wcxIZ/DxoKk6rlcBVyHybuQ8zgjCDTgvDFga4iuubY/djRpDo+8N2MBVxzTlYIghTBXoEvbgqhHDH5kAsEQTUB1cBNA8A',
      'oySC2CERlJGamEKN2GHDFzsNMOfgzBxIKtBDNiah3r76Tt9ehAongir8CNpSQUAFNxgCAA==',
    ]),
  }),
});

/** Assemble the original X envelopes from bounded, independently verified
 * chunks. No production decoder/validator or platform compressor is used.
 * Small chunks retain the original cross-chunk dictionary witness.
 */
function compressedAnimation(bytes, mode) {
  const header = bytes.slice(0, 16);
  header.set(utf8(mode), 8);
  const body = bytes.subarray(16), parts = [header, dword(bytes.length)];
  const fixture = COMPRESSED_ANIMATION_FIXTURES[mode];
  if (!fixture || createHash('sha256').update(body).digest('hex') !== fixture.sha256) {
    throw new Error('Original compressed animation fixture does not match authored input; review and version the fixture.');
  }
  for (let offset = 0; offset < body.length; offset += 1024) {
    const chunk = body.subarray(offset, offset + 1024);
    const compressed = Buffer.from(fixture.chunks[offset / 1024], 'base64');
    const decoded = inflateRawSync(compressed, {
      maxOutputLength: chunk.length,
      ...(offset ? { dictionary: body.subarray(Math.max(0, offset - 32768), offset) } : {}),
    });
    if (!decoded.equals(Buffer.from(chunk))) throw new Error('Original compressed animation chunk differs from authored input.');
    parts.push(word(chunk.length), word(compressed.length + 2), Uint8Array.of(0x43, 0x4b), compressed);
  }
  return concatenate(parts);
}

export function directXAnimationAssets() {
  const definition = tracks(), text = textAnimation(definition), binary32 = binaryAnimation(definition, 32), binary64 = binaryAnimation(definition, 64);
  const variants = [
    ['wf-x-salute', text],
    ['wf-x-salute-binary32', binary32],
    ['wf-x-salute-binary64', binary64],
    ['wf-x-salute-tzip', compressedAnimation(text, 'tzip')],
    ['wf-x-salute-bzip', compressedAnimation(binary32, 'bzip')],
  ];
  const files = new Map();
  for (const [stem, bytes] of variants) {
    files.set(`seqs/${stem}.x`, bytes);
    files.set(`seqs/${stem}.zip`, zipSync({ [`${stem}.x`]: [bytes, { mtime: new Date(2000, 0, 1), level: 9 }] }));
  }
  // A distinct raw SEQ basename avoids a ZIP-first .seq request finding the
  // base .x member and correctly rejecting its explicitly different extension.
  files.set('seqs/wf-x-salute-seq.seq', text.slice());
  files.set('seqs/directx-animation-LICENSE.txt', utf8('Original Wayfarer salute animation, typed records, encoders and numerical oracles. CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/\nNo ActiveWorlds or Microsoft sample assets are included. Right-handed +Y-up, original one-metre authoring units and selected Microsoft X quaternion encoding do not establish historical AW exporter parity.\n'));
  return files;
}

export function directXAnimationExpectations() {
  return {
    durationMs: 4000, ticksPerSecond: 30, keyCount: 25,
    tracks: tracks().map(({ name, axis, angles }) => ({ name, axis: [...axis], angles: angles.map(pair => [...pair]) })),
    witness: {
      timeMs: 1000, joint: 'lfelbow', physicalAxis: [0, 0, 1], physicalDegrees: 90,
      sourceWXYZ: [Math.SQRT1_2, 0, 0, -Math.SQRT1_2],
      sourceSpacePivot: [0.25, 1.05, 0],
      sourceSpacePoint: [0.32, 0.9, 0.07], sourceSpaceResult: [0.4, 1.12, 0.07],
      sourceSpaceBlendedPoint: [0.32, 1.05, 0.07], sourceSpaceBlendedResult: [0.285, 1.085, 0.07],
      stressRootPoint: [0.32, 0.9, 0.18], stressRootResult: [0.32, 1.12, 0.1],
    },
    hold: { fromMs: 1600, toMs: 2200, shoulderDegrees: 90, elbowDegrees: 135, headDegrees: 8 },
    final: { timeMs: 4000, allRotationsIdentity: true, allTranslationsZero: true },
  };
}

/** Mirrors the existing Studio JSON convention: exact relative URL -> base64.
 * MIME can be obtained separately without adding a second incompatible schema.
 */
export function withDirectXAnimationCatalog(base) {
  const original = base.get('avatars/avatars.dat');
  if (!(original instanceof Uint8Array) || original.length > 1_000_000) throw new Error('Expected a bounded original avatar catalog.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(original);
  const blocks = [...source.matchAll(/^avatar[ \t]*\r?\n[\s\S]*?^endavatar[ \t]*(?:\r?\n|$)/gm)];
  if (blocks.length !== 3 || !/^\s*geometry=wf-x-voyager\.x[ \t]*$/m.test(blocks[2][0])) throw new Error('Expected original DirectX avatar at declaration ordinal 2.');
  const target = blocks[2][0];
  const endings = [...target.matchAll(/^([ \t]*)endexp[ \t]*(\r?\n|$)/gm)];
  if (endings.length !== 1 || !/^\s*beginexp[ \t]*$/m.test(target)) throw new Error('Expected one original explicit gesture section.');
  const existing = [...target.matchAll(/^[ \t]*X Salute=(.*)$/gm)];
  if (existing.length > 1 || (existing.length && existing[0][1].trim() !== 'wf-x-salute.x')) throw new Error('Preserving conflicting original X Salute gesture.');
  const updatedTarget = existing.length ? target : target.replace(/^([ \t]*)endexp[ \t]*(\r?\n|$)/m,
    (line, indent, ending) => `${indent} X Salute=wf-x-salute.x${ending || '\n'}${line}`);
  const updated = source.slice(0, blocks[2].index) + updatedTarget + source.slice(blocks[2].index + target.length);
  const result = new Map([...base].map(([name, bytes]) => [name, bytes.slice()]));
  const catalog = utf8(updated);
  result.set('avatars/avatars.dat', catalog);
  result.set('avatars/avatars.zip', zipSync({ 'avatars.dat': [catalog, { mtime: new Date(2000, 0, 1), level: 9 }] }));
  return result;
}

export function directXAnimationStudioBundle() {
  const catalog = withDirectXAnimationCatalog(studioDirectXFixtureAssets());
  return Object.fromEntries([
    ...directXAnimationAssets(),
    ['avatars/avatars.dat', catalog.get('avatars/avatars.dat')],
    ['avatars/avatars.zip', catalog.get('avatars/avatars.zip')],
  ].map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]));
}

export function directXAnimationContentType(name) {
  return name.endsWith('.zip') ? 'application/zip' : /\.(?:x|seq)$/.test(name) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
}

export function directXAnimationStudioJson() {
  return JSON.stringify(directXAnimationStudioBundle(), null, 2) + '\n';
}

/** Read-only exact-path verification. Initial creation/intentional regeneration
 * uses the --studio JSON output through apply_patch; no CLI option overwrites
 * an existing bundle or selects an arbitrary destination.
 */
export function checkDirectXAnimationStudioBundle() {
  if (realpathSync(dirname(bundlePath)) !== dirname(bundlePath)) throw new Error('Studio animation bundle parent must not be linked.');
  const state = lstatSync(bundlePath);
  if (!state.isFile() || state.isSymbolicLink() || state.size > 100_000) throw new Error('Invalid Studio animation bundle file.');
  if (readFileSync(bundlePath, 'utf8') !== directXAnimationStudioJson()) throw new Error('Preserving modified Studio animation bundle.');
  return Object.keys(directXAnimationStudioBundle()).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--studio') process.stdout.write(directXAnimationStudioJson());
  else if (args.length === 2 && args[0] === '--studio' && args[1] === '--check') console.log(`Verified ${checkDirectXAnimationStudioBundle()} original DirectX animation Studio assets.`);
  else throw new Error('Usage: node scripts/directx-animation-assets.mjs --studio [--check]');
}
