import net from 'node:net';
import tls from 'node:tls';
import { constants, createCipheriv, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, type Cipheriv, type KeyObject } from 'node:crypto';
import { blob, bytes, decode, encode, frameLength, type Field, type Packet } from './codec';
import { P, V } from './constants';

/** The Axis legacy handshake is RSA PKCS#1 v1.5 in 48-byte input blocks,
 * followed by continuous AES-256-OFB per direction. These algorithms exist here
 * only for AW protocol interoperability; TLS validates the peer certificate and
 * entirely skips this handshake. Protocol references: Axis.Platform NetConnection,
 * RSAPublicKey, RSAPrivateKey, AesCipher at f18054d5d16e3869d54243788bced30b59cccf05. */
export function browserPassword(password: string): Buffer {
  if (!password) return Buffer.alloc(16);
  if (password.length >= 255) throw new Error('Password exceeds the browser protocol limit');
  // .NET ASCII substitutes '?' for non-ASCII UTF-16 code units.
  const raw = Buffer.from(password.split('').map(c => c.charCodeAt(0) <= 127 ? c.charCodeAt(0) : 63));
  const prefix = Buffer.alloc(4); prefix.writeInt32LE(raw.length);
  return createHash('md5').update(prefix).update(raw.reverse()).digest();
}
export function streamCipher(material: Buffer): Cipheriv {
  if (material.length < 32 || material.length > 1024) throw new Error('Invalid stream key material');
  const key = Buffer.alloc(32);
  for (let i = 0; i < material.length; i++) key[i % 32] = (key[i % 32] + material[material.length - 1 - i]) & 255;
  return createCipheriv('aes-256-ofb', key, material.subarray(16, 32));
}
function trimZero(b: Buffer): Buffer { let at = 0; while (at < b.length - 1 && b[at] === 0) at++; return b.subarray(at); }
export function publicKeyFromWire(wire: Buffer): KeyObject {
  if (wire.length !== 260) throw new Error('Invalid RSA wire key length');
  const n = trimZero(wire.subarray(4, 132)), e = trimZero(wire.subarray(132, 260));
  const exponent = BigInt('0x' + e.toString('hex'));
  if (n.length < 64 || (n.length === 64 && n[0] < 128) || ![3n, 65537n].includes(exponent)) throw new Error('Unsupported legacy RSA key');
  return createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' });
}
export function publicKeyToWire(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }), n = Buffer.from(jwk.n!, 'base64url'), e = Buffer.from(jwk.e!, 'base64url');
  if (n.length > 128 || e.length > 128) throw new Error('RSA key exceeds legacy wire format');
  const wire = Buffer.alloc(260); wire.writeUInt32LE(n.length * 8);
  n.copy(wire, 132 - n.length); e.copy(wire, 260 - e.length); return wire;
}
export function encryptStreamKey(key: KeyObject, material: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (let at = 0; at < material.length; at += 48) blocks.push(publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, material.subarray(at, at + 48)));
  return Buffer.concat(blocks);
}
export function decryptStreamKey(key: KeyObject, encrypted: Buffer): Buffer {
  const blockSize = Math.ceil((key.asymmetricKeyDetails?.modulusLength ?? 512) / 8);
  if (!encrypted.length || encrypted.length > 2048 || encrypted.length % blockSize) throw new Error('Invalid RSA stream-key blocks');
  const output: Buffer[] = [];
  for (let at = 0; at < encrypted.length; at += blockSize) {
    // Node disables PKCS1 private decryption on some OpenSSL builds. Raw RSA is
    // used exclusively to decode this fixed wire handshake, with explicit padding
    // validation. No decrypted bytes or differing failure details are exposed.
    const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, encrypted.subarray(at, at + blockSize));
    const delimiter = block.indexOf(0, 2);
    if (block[0] !== 0 || block[1] !== 2 || delimiter < 10) throw new Error('Invalid RSA stream-key block');
    output.push(block.subarray(delimiter + 1));
  }
  const result = Buffer.concat(output);
  if (result.length < 32 || result.length > 1024) throw new Error('Invalid stream-key length');
  return result;
}
type Waiter = { accept: (p: Packet) => boolean; resolve: (p: Packet) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export class AxisTransport {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private encrypt?: Cipheriv;
  private decrypt?: Cipheriv;
  private privateKey?: KeyObject;
  private publicKey?: KeyObject;
  private secure = false;
  private waiters = new Set<Waiter>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastReceive = Date.now();
  private expectingHeartbeat = false;
  private closed = false;
  version = 3;
  sent = 0;
  received = 0;
  constructor(private onPacket: (p: Packet) => void, private onClose: (error?: Error) => void = () => {}) {}
  async connect(host: string, port: number, secure = false): Promise<void> {
    if (this.socket) throw new Error('Connection already started');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid host or port');
    this.secure = secure;
    if (!secure) { const pair = generateKeyPairSync('rsa', { modulusLength: 512 }); this.privateKey = pair.privateKey; this.publicKey = pair.publicKey; }
    await new Promise<void>((resolve, reject) => {
      const socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, minVersion: 'TLSv1.2' }) : net.connect({ host, port });
      this.socket = socket; socket.setNoDelay(true);
      const timer = setTimeout(() => { reject(new Error('Connection timed out')); this.close(); }, 15000);
      socket.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Connection closed during setup')); });
      socket.on('error', error => this.close(error));
      socket.on('close', () => this.close(new Error('Server closed the connection')));
      socket.on('data', chunk => { try { this.receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); } });
    });
    if (!secure) {
      const ready = this.waitFor(p => p.type === P.StreamKeyResponse);
      this.send(P.PublicKeyRequest, [], 2, 0); await ready;
    }
    this.heartbeat = setInterval(() => {
      const idle = Date.now() - this.lastReceive;
      if (idle > 180000) this.close(new Error('Server heartbeat timed out'));
      else if (idle > 60000 && !this.expectingHeartbeat) { this.expectingHeartbeat = true; this.send(P.Heartbeat, [], 2, 0); }
    }, 25000); this.heartbeat.unref();
  }
  send(type: number, fields: Field[] = [], version = this.version, flags = 2): void {
    if (!this.socket || this.closed || this.socket.destroyed) throw new Error('Not connected');
    const plain = encode(type, fields, version, flags), wire = this.encrypt?.update(plain) ?? plain;
    if (this.socket.writableLength > 2 * 1024 * 1024) { this.close(new Error('Server is not consuming outgoing data')); throw new Error('Connection send queue full'); }
    this.socket.write(wire); this.sent += wire.length;
  }
  request(type: number, fields: Field[], responseType = type, filter?: (p: Packet) => boolean): Promise<Packet> {
    const pending = this.waitFor(p => p.type === responseType && (!filter || filter(p)));
    try { this.send(type, fields); } catch (error) { this.close(error as Error); }
    return pending;
  }
  waitFor(accept: (p: Packet) => boolean, timeout = 15000, signal?: AbortSignal): Promise<Packet> {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    if (signal?.aborted) return Promise.reject(new Error('Axis request cancelled'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(waiter.timer); this.waiters.delete(waiter); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Axis request cancelled')); };
      const waiter: Waiter = { accept, resolve: p => { cleanup(); resolve(p); }, reject: e => { cleanup(); reject(e); }, timer: setTimeout(() => { cleanup(); reject(new Error('Axis request timed out')); }, timeout) };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private receive(chunk: Buffer): void {
    this.lastReceive = Date.now(); this.received += chunk.length;
    this.buffer = Buffer.concat([this.buffer, this.decrypt?.update(chunk) ?? chunk]);
    for (;;) {
      const size = frameLength(this.buffer); if (!size || size > this.buffer.length) return;
      const frame = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size);
      const hadDecrypt = !!this.decrypt;
      // Compressed v4 envelopes may carry legacy sub-packets. Negotiate from
      // the envelope too, before decode expands it into application packets.
      if (frame.readUInt16BE(0) === 16 && frame.readUInt16BE(2) === 4) this.version = 4;
      for (const packet of decode(frame)) {
        if (packet.version === 4) this.version = 4;
        this.handleControl(packet);
        this.onPacket(packet);
        for (const waiter of this.waiters) if (waiter.accept(packet)) {
          clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(packet); break;
        }
      }
      // The plaintext key packet and the first encrypted packet can arrive in
      // one TCP read. Only the remaining buffered bytes switch cipher states.
      if (!hadDecrypt && this.decrypt && this.buffer.length) this.buffer = this.decrypt.update(this.buffer);
    }
  }
  private handleControl(packet: Packet): void {
    if (this.secure && [P.PublicKeyRequest, P.PublicKeyResponse, P.StreamKeyResponse].includes(packet.type as never)) throw new Error('Unexpected key exchange over TLS');
    if (packet.type === P.PublicKeyRequest) {
      if (!this.publicKey) throw new Error('Missing handshake key');
      this.send(P.PublicKeyResponse, [blob(V.EncryptionKey, publicKeyToWire(this.publicKey))]);
    } else if (packet.type === P.PublicKeyResponse) {
      if (this.encrypt || !this.publicKey) throw new Error('Unexpected repeated key exchange');
      const material = randomBytes(256);
      this.send(P.StreamKeyResponse, [blob(V.EncryptionKey, encryptStreamKey(publicKeyFromWire(bytes(packet, V.EncryptionKey)), material))]);
      this.encrypt = streamCipher(material);
      this.send(P.PublicKeyResponse, [blob(V.EncryptionKey, publicKeyToWire(this.publicKey))]); material.fill(0);
    } else if (packet.type === P.StreamKeyResponse) {
      if (this.decrypt || !this.privateKey) throw new Error('Unexpected stream key');
      const material = decryptStreamKey(this.privateKey, bytes(packet, V.EncryptionKey)); this.decrypt = streamCipher(material); material.fill(0);
    } else if (packet.type === P.Heartbeat) {
      if (this.expectingHeartbeat) this.expectingHeartbeat = false;
      else this.send(P.Heartbeat, [], 2, 0);
    }
  }
  close(error?: Error): void {
    if (this.closed) return; this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error ?? new Error('Disconnected')); }
    this.waiters.clear(); this.socket?.destroy(); this.buffer = Buffer.alloc(0);
    this.encrypt = undefined; this.decrypt = undefined; this.privateKey = undefined; this.publicKey = undefined;
    this.onClose(error);
  }
}
