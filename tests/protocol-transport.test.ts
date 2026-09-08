import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { generateKeyPairSync, randomBytes, type Cipheriv } from 'node:crypto';
import { blob, bytes, compressed, decode, encode, frameLength, i32, str, string } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { AxisTransport, decryptStreamKey, encryptStreamKey, publicKeyFromWire, publicKeyToWire, streamCipher } from '../src/main/protocol/transport';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** Minimal scripted peer, not a substitute for scripts/axis/smoke.ts's real C#
 * integration. It forces TCP read boundaries that ordinary smoke tests do not. */
async function peer(chunkSize: number): Promise<{ port: number; sockets: Set<net.Socket> }> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
  const sockets = new Set<net.Socket>(), timers = new Set<ReturnType<typeof setTimeout>>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let incoming: Buffer = Buffer.alloc(0), decrypt: Cipheriv | undefined, encrypt: Cipheriv | undefined;
    const sendChunks = (data: Buffer, at = 0) => {
      if (socket.destroyed) return;
      const count = chunkSize || data.length; socket.write(data.subarray(at, at + count));
      if (at + count < data.length) {
        const timer = setTimeout(() => { timers.delete(timer); sendChunks(data, at + count); }, 1); timers.add(timer);
      }
    };
    socket.on('data', chunk => {
      const wire = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      incoming = Buffer.concat([incoming, decrypt?.update(wire) ?? wire]);
      for (;;) {
        const size = frameLength(incoming); if (!size || size > incoming.length) return;
        const data = incoming.subarray(0, size); incoming = incoming.subarray(size); const hadDecrypt = !!decrypt;
        for (const p of decode(data)) {
          if (p.type === P.PublicKeyRequest) socket.write(encode(P.PublicKeyResponse, [blob(V.EncryptionKey, publicKeyToWire(publicKey))]));
          if (p.type === P.StreamKeyResponse) decrypt = streamCipher(decryptStreamKey(privateKey, bytes(p, V.EncryptionKey)));
          if (p.type === P.PublicKeyResponse) {
            const material = randomBytes(256); encrypt = streamCipher(material);
            const response = encode(P.StreamKeyResponse, [blob(V.EncryptionKey, encryptStreamKey(publicKeyFromWire(bytes(p, V.EncryptionKey)), material))]);
            const payload = compressed([encode(P.WorldList, [str(V.WorldListName, 'Café Haven'), i32(V.WorldListUsers, 7)]), encode(P.WorldListResult, [i32(V.ReasonCode, 0)])], 4);
            // The key response is cleartext and all following bytes encrypted,
            // including when coalesced in the same write.
            sendChunks(Buffer.concat([response, encrypt.update(payload)]));
          }
          if (p.type === P.WorldLookup) socket.end();
        }
        if (!hadDecrypt && decrypt && incoming.length) incoming = decrypt.update(incoming);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { port: (server.address() as net.AddressInfo).port, sockets };
}

describe('Axis socket stream boundaries', () => {
  it.each([0, 1, 7, 64])('handles key-to-cipher transition and compressed v4 frames with %i-byte writes', async chunkSize => {
    const server = await peer(chunkSize), seen: number[] = [];
    const transport = new AxisTransport(p => seen.push(p.type)); cleanup.push(() => transport.close());
    const world = transport.waitFor(p => p.type === P.WorldList), final = transport.waitFor(p => p.type === P.WorldListResult);
    await transport.connect('127.0.0.1', server.port);
    expect(string(await world, V.WorldListName)).toBe('Café Haven'); await final;
    expect(seen.indexOf(P.StreamKeyResponse)).toBeLessThan(seen.indexOf(P.WorldList));
    expect(transport.version).toBe(4); expect(transport.received).toBeGreaterThan(600); expect(transport.sent).toBeGreaterThan(600);
  });
  it('rejects pending requests immediately on peer disconnection', async () => {
    const server = await peer(0), transport = new AxisTransport(() => {}); cleanup.push(() => transport.close());
    await transport.connect('127.0.0.1', server.port);
    await expect(transport.request(P.WorldLookup, [str(V.WorldName, 'Missing')])).rejects.toThrow('Server closed the connection');
  });
  it('cancels a connection before the TCP connect event without waiting for timeout', async () => {
    const server = await peer(0), transport = new AxisTransport(() => {}); cleanup.push(() => transport.close());
    const attempt = transport.connect('127.0.0.1', server.port); transport.close();
    await expect(attempt).rejects.toThrow('Connection closed during setup');
  });
});
