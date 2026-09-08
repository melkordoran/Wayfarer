import { describe, expect, it } from 'vitest';
import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { blob, byte, bytes, compressed, decode, encode, frameLength, i32, num, str, string } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { browserPassword, decryptStreamKey, encryptStreamKey, publicKeyFromWire, publicKeyToWire, streamCipher } from '../src/main/protocol/transport';
import { entryPosition, sectorFromMetres, terrainTile } from '../src/main/protocol/axis-client';

describe('Axis framing and fields', () => {
  it('matches a captured-contract legacy heartbeat header byte for byte', () => {
    expect(encode(P.Heartbeat, [], 2, 0).toString('hex')).toBe('000a0000002500020000');
  });
  it('matches a hand-encoded legacy cell-X integer packet', () => {
    const wire = Buffer.from('0012000200390003000100302004feffffff', 'hex');
    const [packet] = decode(wire); expect(packet.type).toBe(P.Query3X3); expect(num(packet, V.CellX)).toBe(-2);
    expect(encode(P.Query3X3, [i32(V.CellX, -2)])).toEqual(wire);
  });
  it.each([1, 3, 4])('preserves signed integers, binary, Unicode and byte flags in v%i', version => {
    const encoded = encode(P.ObjectAdd, [i32(V.ObjectX, -987654), str(V.ObjectDescription, 'A café 🌲'), blob(V.ObjectData, Buffer.from([0, 255, 0])), byte(V.TerrainNodeMultipleHeights, 1)], version);
    const [packet] = decode(encoded); expect(num(packet, V.ObjectX)).toBe(-987654);
    expect(string(packet, V.ObjectDescription)).toBe('A café 🌲'); expect(bytes(packet, V.ObjectData)).toEqual(Buffer.from([0, 255, 0]));
    expect(num(packet, V.TerrainNodeMultipleHeights)).toBe(1); expect(packet.version).toBe(version);
  });
  it('uses low-word-first big-endian lengths for v4 large data', () => {
    const wire = encode(P.ObjectAdd, [blob(V.ObjectData, Buffer.alloc(70000, 7))], 4);
    expect(wire.subarray(12, 16).toString('hex')).toBe('118c0001');
    expect(wire.subarray(24, 28).toString('hex')).toBe('11700001');
    expect(bytes(decode(wire)[0], V.ObjectData).length).toBe(70000);
  });
  it('forces browser login and key material into version 1 even in a v4 session', () => {
    const packet = decode(encode(P.Login, [str(V.LoginUsername, 'Explorer')], 4))[0];
    expect(packet.version).toBe(1); expect(packet.flags).toBe(0);
  });
  it('detects every partial header without consuming it', () => {
    const wire = encode(P.Query3X3, [i32(V.SectorX, 1)], 4);
    for (let i = 0; i < 16; i++) expect(frameLength(wire.subarray(0, i))).toBeUndefined();
    expect(frameLength(wire.subarray(0, 16))).toBe(wire.length);
  });
  it('expands compressed batches in wire order', () => {
    const wire = compressed([encode(P.CellBegin, [i32(V.CellX, -2)]), encode(P.CellEnd)], 4);
    expect(decode(wire).map(p => p.type)).toEqual([P.CellBegin, P.CellEnd]);
  });
  it('rejects oversized v4 frames before accumulating their bodies', () => {
    const wire = encode(P.CellEnd, [], 4); wire.writeUInt16BE(32, 14);
    expect(() => frameLength(wire)).toThrow('Invalid Axis frame size');
  });
  it('rejects truncated fields and malformed primitive sizes', () => {
    const wire = encode(P.ObjectAdd, [i32(V.ObjectId, 42)]); wire.writeUInt16BE(0x2005, 12);
    expect(() => decode(wire)).toThrow('Truncated field payload');
    wire.writeUInt16BE(0x2003, 12); expect(() => decode(wire)).toThrow('Invalid numeric field length');
  });
  it('rejects compressed bombs with bounded expansion', () => {
    const header = Buffer.from('000a0000ffff00030000', 'hex');
    const zip = deflateSync(Buffer.alloc(5 * 1024 * 1024)); header.writeUInt16BE(10 + zip.length);
    expect(() => decode(Buffer.concat([header, zip]))).toThrow();
  });
  it('rejects truncated frames inside valid compressed streams', () => {
    const header = Buffer.from('000a0000ffff00030000', 'hex'), zip = deflateSync(Buffer.from('000a00', 'hex')); header.writeUInt16BE(10 + zip.length);
    expect(() => decode(Buffer.concat([header, zip]))).toThrow('Truncated compressed subframe');
  });
  it('rejects NUL text and values larger than legacy field limits', () => {
    expect(() => str(V.Message, 'a\0b')).toThrow();
    expect(() => encode(P.ObjectAdd, [blob(V.ObjectData, Buffer.alloc(4096))])).toThrow('legacy packet limit');
  });
  it('caps aggregate expansion across nested compressed packets', () => {
    const payload = encode(P.ObjectAdd, [blob(V.ObjectData, Buffer.alloc(350000))], 4);
    const nested = compressed(Array.from({ length: 6 }, () => compressed([payload, payload], 4)), 4);
    expect(() => decode(nested)).toThrow();
  });
  it('refuses ambiguous legacy16-byte frames', () => {
    expect(() => encode(P.WorldList, [str(V.WorldListName, 'a')])).toThrow('ambiguous');
  });
});

describe('Axis legacy encryption interoperability', () => {
  it('matches fixed browser-password hash vectors', () => {
    expect(browserPassword('password').toString('hex')).toBe('29b6395f6cbdca60c3aa89d25793205b');
    expect(browserPassword('WayfarerLocal42!').toString('hex')).toBe('46aeaa804df8581b7ae935b70e0ef69f');
    expect(browserPassword('')).toEqual(Buffer.alloc(16));
  });
  it('encodes fixed-width RSA public-key fields and decrypts six legacy blocks', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
    const wire = publicKeyToWire(publicKey); expect(wire.length).toBe(260); expect(wire.readUInt32LE()).toBe(512);
    const material = randomBytes(256), encrypted = encryptStreamKey(publicKeyFromWire(wire), material);
    expect(encrypted.length).toBe(384); expect(decryptStreamKey(privateKey, encrypted)).toEqual(material);
    expect(() => decryptStreamKey(privateKey, encrypted.subarray(0, 383))).toThrow();
  });
  it('rejects invalid peer exponent and undersized modulus', () => {
    const wire = Buffer.alloc(260); wire[68] = 128; wire[259] = 5;
    expect(() => publicKeyFromWire(wire)).toThrow('Unsupported legacy RSA key');
    wire[259] = 3; wire[68] = 1; expect(() => publicKeyFromWire(wire)).toThrow('Unsupported legacy RSA key');
  });
  it('folds reversed stream material and preserves OFB state across chunks', () => {
    const material = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    // First lane is 255+223+191+159+127+95+63+31 = 1144 mod 256 = 120.
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (120 - i * 8) & 255));
    const reference = createCipheriv('aes-256-ofb', key, material.subarray(16, 32));
    const actual = streamCipher(material), message = Buffer.from('fragmented continuous cipher data across boundaries');
    expect(Buffer.concat([actual.update(message.subarray(0, 3)), actual.update(message.subarray(3, 19)), actual.update(message.subarray(19))])).toEqual(reference.update(message));
  });
});

describe('world coordinate and terrain contracts', () => {
  it.each([[-40, 0], [-40.01, -1], [-29, 0], [39.99, 0], [40, 1], [-120, -1], [-120.01, -2]])('maps centered sectors at %s m to %s', (metres, expected) => {
    expect(sectorFromMetres(metres)).toBe(expected);
  });
  it('parses AW cardinal coordinates, altitude and yaw', () => {
    expect(entryPosition('2.9S 4.5E 1.2a 90')).toEqual({ x: -45, y: 12, z: -29, yaw: Math.PI / 2 });
  });
  it('decodes flat terrain scalar arrays and size radius', () => {
    const packet = decode(encode(P.TerrainData, [byte(V.TerrainNodeSize, 16), i32(V.TerrainNodeHeights, -125), i32(V.TerrainNodeTextures, 7), i32(V.TerrainPageX, -1), byte(V.TerrainNodeX, 32)]))[0];
    expect(terrainTile(packet)).toMatchObject({ pageX: -1, nodeX: 32, size: 32, heights: [-1.25], textures: [7] });
  });
  it('decodes variable height int32 and texture uint16 buffers', () => {
    const heights = Buffer.alloc(16), textures = Buffer.alloc(8);
    [0, -125, 250, 375].forEach((n, i) => heights.writeInt32LE(n, i * 4)); [0, 1, 32769, 65535].forEach((n, i) => textures.writeUInt16LE(n, i * 2));
    const packet = decode(encode(P.TerrainData, [byte(V.TerrainNodeSize, 1), byte(V.TerrainNodeMultipleHeights, 1), byte(V.TerrainNodeMultipleTextures, 1), blob(V.TerrainNodeHeights, heights), blob(V.TerrainNodeTextures, textures)]))[0];
    expect(terrainTile(packet)).toMatchObject({ size: 2, heights: [0, -1.25, 2.5, 3.75], textures: [0, 1, 32769, 65535] });
  });
});
