/** Pure, bounded decoder for the pinned Axis attributes.dat persistence format.
 * Read-only QA oracle; never edits files or accepts an endpoint. */
export function decodeWorldAttributeFile(input: Uint8Array): Map<string, { type: number; value: Uint8Array }> {
  if (!(input instanceof Uint8Array) || input.length > 1_000_000) throw new Error('Invalid attribute-file buffer.');
  let cursor = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const integer = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (cursor >= input.length) throw new Error('Truncated attribute-file integer.');
      const byte = input[cursor++]; value += (byte & 127) * 2 ** shift;
      if (value > 0x7fffffff || (shift > 0 && byte === 0)) throw new Error('Invalid attribute-file integer.');
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid attribute-file integer.');
  };
  if (integer() !== 1) throw new Error('Unsupported attribute-file version.');
  const result = new Map<string, { type: number; value: Uint8Array }>();
  while (cursor < input.length) {
    const size = integer();
    if (!size || size > 256 || cursor + size > input.length) throw new Error('Invalid attribute-file name length.');
    const name = decoder.decode(input.subarray(cursor, cursor + size)); cursor += size;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || result.has(name) || result.size >= 1024) throw new Error('Invalid or duplicate attribute-file name.');
    const type = integer(), length = integer();
    if (type < 1 || type > 5 || length > 65535 || cursor + length > input.length) throw new Error('Invalid attribute-file value.');
    result.set(name, { type, value: Uint8Array.from(input.subarray(cursor, cursor + length)) }); cursor += length;
  }
  return result;
}
/** Types 2/3 are little-endian Int32/Single; bool Byte is ASCII0/1 in
 * persistence but Y/N on the network. This is separate from the editor parser. */
export function persistedWorldSetting(entry: { type: number; value: Uint8Array }, kind: string): string {
  const { type, value } = entry;
  if (kind === 'boolean') {
    if (type !== 1 || value.length !== 1 || (value[0] !== 48 && value[0] !== 49)) throw new Error('Unexpected persisted Boolean.');
    return value[0] === 49 ? 'Y' : 'N';
  }
  if (kind === 'integer' || kind === 'color' || kind === 'float') {
    if (type !== (kind === 'float' ? 3 : 2) || value.length !== 4) throw new Error('Unexpected persisted numeric type.');
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const n = kind === 'float' ? view.getFloat32(0, true) : view.getInt32(0, true);
    if (!Number.isFinite(n)) throw new Error('Nonfinite persisted setting.');
    return String(n);
  }
  if (type !== 4) throw new Error('Unexpected persisted text type.');
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}
