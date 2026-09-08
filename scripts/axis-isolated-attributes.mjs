/** Pure, narrowly scoped transformation of a freshly seeded fixture's attribute
 * bytes. No filesystem or process access. Pinned Axis WorldAttributes.cs format:
 * version1, LEB128 name length/name, PacketVarType, byte length/value. Booleans
 * are PacketVarType.Byte=1 with ASCII '1'/'0'. Never a generic world editor. */
export function restrictFixtureMovement(input) {
  if (!(input instanceof Uint8Array) || input.byteLength > 1_000_000) throw new Error('Invalid original fixture attribute buffer.');
  const output = new Uint8Array(input), targets = new Set(['AllowFlying', 'AllowTeleport']);
  const found = new Set(), offsets = [];
  let cursor = 0;
  function integer() {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (cursor >= output.length) throw new Error('Truncated fixture attribute integer.');
      const byte = output[cursor++]; value += (byte & 127) * 2 ** shift;
      if (value > 0x7fffffff) throw new Error('Oversized fixture attribute integer.');
      if (!(byte & 128)) {
        if (shift && byte === 0) throw new Error('Noncanonical fixture attribute integer.');
        return value;
      }
    }
    throw new Error('Invalid fixture attribute integer.');
  }
  if (integer() !== 1) throw new Error('Unknown fixture attribute file version.');
  while (cursor < output.length) {
    const size = integer();
    if (size < 1 || size > 256 || cursor + size > output.length) throw new Error('Invalid fixture attribute name length.');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(cursor, cursor + size)); cursor += size;
    const type = integer(), length = integer();
    if (type < 1 || type > 5 || length > 65535 || cursor + length > output.length) throw new Error('Invalid fixture attribute value.');
    if (targets.has(name)) {
      if (found.has(name) || type !== 1 || length !== 1 || output[cursor] !== 49) throw new Error('Expected one enabled Boolean for each original fixture movement rule.');
      found.add(name); offsets.push(cursor);
    }
    cursor += length;
  }
  if (found.size !== 2) throw new Error('Original fixture movement attributes are missing.');
  offsets.forEach(offset => { output[offset] = 48; });
  return output;
}
