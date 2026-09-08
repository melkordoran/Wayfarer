import { inflateSync } from "fflate";
import { validateDeflate } from "./deflate";

const FILE_LIMIT = 30_000_000;
const WINDOW = 32_768;
const MAX_CHUNKS = 4096;

function fail(message: string): never {
  throw new Error(`DirectX MSZIP: ${message}`);
}

/** Decode the X tzip/bzip envelope. Non-compressed inputs are returned by identity.
 * Input and reconstructed header+body are bounded to 30 MB. No I/O or allocations
 * based on unvalidated size fields; prior chunks supply only the last 32 KiB. */
export function decompressDirectX(
  input: Uint8Array,
  maxBytes = FILE_LIMIT,
): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16 || maxBytes > FILE_LIMIT)
    fail("invalid byte limit (16..30000000)");
  if (input.byteLength > maxBytes)
    fail(
      `input exceeds ${maxBytes === FILE_LIMIT ? "30 MB" : maxBytes + " byte"} limit`,
    );
  if (String.fromCharCode(...input.subarray(0, 4)) !== "xof ") return input;
  const header = String.fromCharCode(...input.subarray(0, 16));
  if (!/^xof 030[23](?:txt |bin |tzip|bzip|cmp )(?:0032|0064)$/.test(header))
    fail("unsupported or truncated X header/version");
  const mode = header.slice(8, 12);
  if (mode === "txt " || mode === "bin ") return input;
  if (mode === "cmp ")
    fail("legacy cmp encoding is not supported; export txt/bin/tzip/bzip X");
  if (input.length < 20) fail("truncated compressed X size header");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const expanded = view.getUint32(16, true);
  if (expanded <= 16 || expanded > maxBytes)
    fail("invalid expanded file size or expanded byte limit exceeded");
  const chunks: { offset: number; compressed: number; expanded: number }[] = [];
  let offset = 20,
    total = 16;
  while (offset < input.length) {
    if (chunks.length >= MAX_CHUNKS)
      fail("compressed chunk count exceeds 4096 limit");
    if (offset + 4 > input.length) fail("truncated compressed chunk header");
    const outputSize = view.getUint16(offset, true),
      inputSize = view.getUint16(offset + 2, true);
    offset += 4;
    if (!outputSize || outputSize > WINDOW)
      fail("chunk output must be 1..32768 bytes");
    if (inputSize < 4 || inputSize > WINDOW + 12)
      fail("invalid compressed chunk size");
    if (offset + inputSize > input.length) fail("truncated compressed chunk");
    if (input[offset] !== 0x43 || input[offset + 1] !== 0x4b)
      fail("missing CK chunk signature");
    if ((total += outputSize) > expanded)
      fail("chunks exceed declared expanded file size");
    chunks.push({
      offset: offset + 2,
      compressed: inputSize - 2,
      expanded: outputSize,
    });
    offset += inputSize;
  }
  if (total !== expanded)
    fail("chunks do not match declared expanded file size");
  const result = new Uint8Array(expanded);
  result.set(input.subarray(0, 16));
  result.set(
    mode === "tzip" ? [0x74, 0x78, 0x74, 0x20] : [0x62, 0x69, 0x6e, 0x20],
    8,
  );
  let written = 16;
  const budget = { blocks: 0 };
  for (const chunk of chunks) {
    const source = input.subarray(
      chunk.offset,
      chunk.offset + chunk.compressed,
    );
    const history = Math.min(WINDOW, written - 16);
    validateDeflate(source, chunk.expanded, history, budget);
    const output = result.subarray(written, written + chunk.expanded);
    try {
      const inflated = inflateSync(source, {
        out: output,
        dictionary: result.subarray(written - history, written),
      });
      if (inflated.length !== chunk.expanded)
        fail("inflater output size mismatch");
    } catch (error) {
      fail(
        `invalid compressed payload: ${error instanceof Error ? error.message : "DEFLATE failure"}`,
      );
    }
    written += chunk.expanded;
  }
  return result;
}
