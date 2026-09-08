# Internal DirectX compression

The experimental X loader accepts `tzip` (MSZIP-compressed text) and `bzip`
(MSZIP-compressed binary). These are not ordinary ZIP archives or BZIP2 streams.
The existing outer GZIP → ZIP → model unwrapping still applies, including an
internally compressed X member. Filename/header agreement is checked before
internal expansion. Legacy `cmp ` remains explicitly unsupported.

## Boundary and contract

`decompressDirectX(input: Uint8Array, maxBytes = 30_000_000): Uint8Array`
is synchronous, browser-compatible and has no I/O. Uncompressed input is returned
by identity. Compressed X is returned as a fresh array containing the original
version/float-width header, with `tzip` changed to `txt ` or `bzip` to `bin `,
followed by the expanded payload. Caller-owned bytes are never mutated, including
nonzero-offset array views. A smaller caller limit applies to both compressed
input and reconstructed header plus body; invalid limits and limits above 30 MB
are rejected. The animation path uses its tighter 16 MB budget.

The supported little-endian envelope is:

| Offset     | Field                                                           |
| ---------- | --------------------------------------------------------------- |
| 0–15       | `xof 0302` / `xof 0303`, encoding, `0032` / `0064`              |
| 16–19      | Total reconstructed byte length, including the 16-byte X header |
| Each chunk | Expanded WORD length, compressed WORD length, `CK`, raw DEFLATE |

The compressed WORD length includes `CK`; the expanded WORD length does not
include the X header. There is no implicit padding between chunks. The last
32,768 bytes of all prior expanded chunks—not just the most recent short
chunk—form the next dictionary. The X header is not dictionary data.

Limits and validation:

- At most 30,000,000 input and reconstructed bytes, 4,096 MSZIP chunks and
  65,536 aggregate RFC 1951 blocks. These work caps are Wayfarer policies.
- Each chunk expands to 1–32,768 bytes and occupies at most 32,780 compressed
  bytes including its signature. All framing and total sizes are checked before
  allocating the reconstructed buffer.
- Every DEFLATE stream must have a final block and consume its entire framed
  payload. Unused bits in its final partial byte are allowed; extra full bytes,
  a second stream, missing final blocks and chunk trailers are rejected.
- Stored blocks require RFC 1951 `LEN` / `NLEN`; shortened legacy variants that
  omit the complement are not accepted. Reserved block/length/distance codes,
  malformed canonical trees, invalid repeats and missing end markers fail.
- Literal and copy counts must exactly match the declared chunk expansion.
  Back-references may overlap but cannot precede available history or exceed
  the 32 KiB window. Trees reset between DEFLATE blocks; history survives.

MSZIP itself has no checksum here. Structural validation does not authenticate
assets or detect every bit alteration that still describes a valid stream. Outer
GZIP validation remains separate. Successful decompression does not bypass
geometry/animation parser limits or imply every X template is supported.

## Why validation precedes the inflater

The installed `fflate` 0.8.3 public `inflateSync` accepts `dictionary` and a fixed
`out` buffer, but its documented buffer behavior truncates oversized results.
Its public result does not report compressed-byte consumption, and inspection of
the installed implementation showed that stored `NLEN` is not checked. Using
`out` alone would therefore not establish correct expansion or framing.

Wayfarer's independently written RFC 1951 scanner in `engine/deflate.ts` validates the complete stream,
counts output and checks history without allocating expanded payloads. Only then
does the existing `fflate` dependency inflate into the exact bounded output
slice with the exact bounded dictionary. No dependency internals are imported or
patched. This separation deliberately avoids treating successful inflation as
proof of a well-formed model envelope.

## Shared ZIP boundary

Archive review exposed a separate existing problem: a matching local/central
expanded-size lie could make the old ZIP helper return a truncated, valid-looking
model or sequence prefix. Its unchecked CRC did not catch this. A 499-byte
synthetic archive expanded to 110,681 bytes but claimed only the first 89 bytes.
The new `engine/zip.ts` `boundedUnzip` checks actual expansion and consumption
with the shared scanner, then verifies CRC32. The regression also forges the CRC
to match the advertised prefix, proving rejection is not merely a checksum side
effect. Model and texture unwrapping use this shared boundary; catalogs and
sequences use the same API with their existing smaller size budgets.

`boundedUnzip(bytes, { maxBytes, maxEntries, filter? })` returns a null-prototype
record of selected files. Its filter receives immutable name, original size,
compressed size, compression method and CRC32 metadata. Limits apply to the
aggregate selected expansion; skipped file payloads are not inflated. Every
entry, including skipped entries, undergoes structural checks. Input is capped
at 30 MB; callers may select an expanded budget no larger than that and at most
4,096 entries. The model/texture callers choose 1,024 entries.

The independently implemented ZIP profile follows the ordinary record structure
in [PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
It accepts stored/DEFLATE entries, nested paths, UTF-8 names and ASCII legacy
names, comments, bounded extra fields, and signed or unsigned 32-bit data
descriptors. All local/central fields that determine decoding must agree;
descriptor fields must match the central record. Indexed byte ranges cannot
overlap, leave gaps, hide unindexed local records or extend into the directory.
Central ordering need not match physical ordering. Selected entries must match
their actual byte count and checksum before any result is returned.

ZIP64, split/self-extracting archives, encryption, other compression methods,
newer extraction features and unmarked non-ASCII legacy filenames are explicitly
unsupported. Unsafe paths and case-folded duplicate names are rejected. Nothing
is extracted to disk; no archive entry can create files, links or network
requests. This is an asset-archive profile, not a general-purpose ZIP utility.

## Primary references and original evidence

- Microsoft's [D3DXF format flags](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dxf)
  specify compression combined with either text or binary X data. The
  [X file reference](https://learn.microsoft.com/en-us/windows/win32/direct3d9/dx9-graphics-reference-x-file-format)
  supplies the underlying format context, not a complete compressed-envelope
  byte specification.
- Microsoft's [MS-MCI block structure](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-mci/3048c471-f739-4d30-bcb3-a962cfe84a69)
  specifies `CK`, RFC 1951 blocks, final-stream marking, retained history and
  the 32 KiB / 32 KiB + 12 byte limits.
- [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951) is the primary source for
  bit packing, canonical Huffman alphabets, stored blocks and length/distance
  operations. The scanner and hand-authored tests were written independently
  from those format rules; no decoder implementation was copied or ported.
- The envelope layout was checked against Microsoft's own
  [Dwarf.x SDK sample at commit 07e3eaa](https://github.com/microsoft/DirectX-SDK-Samples/blob/07e3eaa10e7dd026ec9d95fe326db2d5c4227e1b/Media/Dwarf/Dwarf.x)
  on September 7, 2026. This was a read-only, in-memory research check; the
  vendor model was not saved in the repository, copied into fixtures, packaged
  or used as Wayfarer artwork.

The Microsoft sample is 198,228 bytes, `xof 0303bzip0032`, SHA-256
`069023a0fe66818d0f30cdabad010728f34df07b982a600538e7523488fa6572`.
It contains 24 chunks: 23 × 32,768 expanded bytes plus 10,797 bytes. Its declared
and reconstructed lengths both equal 764,477 bytes including the X header.
Wayfarer's expanded body matched a separate Node `zlib.inflateRawSync` history
decode byte-for-byte, with body SHA-256
`3a334068a812299e861029a0d9f13faaa8d9f93c5c8f7443d4cb21c86a149b67`.
This proves that sample's decompression, not its renderer, animation or AW
compatibility.

Automated fixtures are original and generated in memory. The compression suite
uses an independent Node zlib encoder plus hand-authored fixed/dynamic/stored
bitstreams. It covers text and binary32/64, version preservation, arbitrary view
offsets, short-chunk cumulative history, exact 32 KiB distances, overlapping
copies, deterministic strategy/data variation, malformed trees, all truncated
prefixes, declared-size lies, framing ambiguity and work caps. Model-asset tests
cover raw/ZIP/GZIP combinations and avatar geometry dispatch. A supplementary
read-only 2,000 single-bit-mutation comparison accepted 929 structurally valid
streams and rejected 1,071; every accepted result matched independent zlib output
(zero mismatches). These synthetic results are not a claim of universal exporter
compatibility.
