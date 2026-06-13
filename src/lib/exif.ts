// Format-agnostic EXIF read/write. The internal storage shape is the
// bare TIFF payload (no JPEG "Exif\0\0" preamble) so the same bytes can
// be re-injected into JPEG, PNG, or WebP exports.
//
// We deliberately do NOT parse the IFDs (TIFF tree) in depth. The full
// EXIF spec is enormous; we only care about preserving the raw bytes
// so the user's orientation tag, camera info, etc. survive the trip
// through the editor. Tools that consume EXIF (the OS, a phone, a photo
// library) will see the same metadata as the original file.

// JPEG-specific markers
const JPEG_SOI_MARKER = [0xff, 0xd8];
const JPEG_EOI_MARKER = [0xff, 0xd9];
const JPEG_APP1_MARKER = 0xe1;
// "Exif\0\0" preamble (6 bytes) that prefixes the TIFF payload in JPEG APP1.
const EXIF_PREAMBLE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

// PNG-specific constants
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_EXIF_CHUNK_TYPE = [0x65, 0x58, 0x49, 0x66]; // "eXIf"
const PNG_IEND_CHUNK_TYPE = [0x49, 0x45, 0x4e, 0x44]; // "IEND"

// WebP-specific constants
const WEBP_SIGNATURE_RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE_WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const WEBP_EXIF_CHUNK_FOURCC = [0x45, 0x58, 0x49, 0x46]; // "EXIF"

function bytesEqualAt(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset + 3] ?? 0) << 24) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 1] ?? 0) << 8) |
    (bytes[offset] ?? 0)
  );
}

function writeUint32BigEndian(value: number): [number, number, number, number] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// CRC32 (PNG-style polynomial 0xedb88320) for PNG chunk integrity. We
// compute this on every chunk we emit because the PNG spec requires the
// CRC to match the type+data. WebP doesn't use a per-chunk CRC.
const PNG_CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Normalize the storage shape. Accepts either:
 *   - The bare TIFF payload (no preamble) — the new format-agnostic shape.
 *   - The JPEG APP1 segment bytes (with "Exif\0\0" preamble) — the old
 *     shape that some recents may still have on disk. We strip the
 *     preamble if we see it.
 * Returns null for inputs that don't look like either.
 */
export function normalizeExifPayload(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 0) return null;
  // The bare-TIFF shape: starts with "Exif\0\0" (the 6-byte preamble
  // that JPEG APP1 segments prepend to the TIFF payload).
  if (bytesEqualAt(bytes, 0, EXIF_PREAMBLE)) {
    return bytes.subarray(EXIF_PREAMBLE.length);
  }
  // The legacy APP1-segment shape: 0xFF 0xE1, 2-byte big-endian
  // length, then "Exif\0\0" preamble, then the TIFF payload. We
  // accept this so the inject path is symmetric with the read path
  // for any payload shape callers may pass. Per the JPEG spec the
  // length field counts itself, so the payload ends at `2 + length`
  // — but stored payloads sometimes use a different convention
  // (the length field measures the preamble + body). To stay robust
  // to either, we always trust the actual buffer end: the buffer
  // itself is the source of truth for "where does the payload end".
  if (
    bytes.length >= 10 &&
    bytes[0] === 0xff &&
    bytes[1] === JPEG_APP1_MARKER &&
    bytesEqualAt(bytes, 4, EXIF_PREAMBLE)
  ) {
    const payloadStart = 4 + EXIF_PREAMBLE.length;
    if (bytes.length <= payloadStart) return null;
    return bytes.subarray(payloadStart);
  }
  // The TIFF header starts with either "II" (little-endian) or "MM"
  // (big-endian) followed by 0x002A. We accept either.
  if (bytes.length >= 4) {
    const byteOrder = (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
    const magicHi = bytes[2];
    const magicLo = bytes[3];
    if (byteOrder && magicHi === 0x00 && magicLo === 0x2a) {
      return bytes;
    }
  }
  return null;
}

/**
 * Read the EXIF TIFF payload from a JPEG byte array. Walks the APP
 * segments and returns the bytes that follow the "Exif\0\0" preamble
 * inside the APP1 segment. Returns null if no EXIF is present.
 */
export function readExifFromJpeg(jpegBytes: Uint8Array): Uint8Array | null {
  if (!bytesEqualAt(jpegBytes, 0, JPEG_SOI_MARKER)) return null;
  let offset = 2;
  while (offset + 4 <= jpegBytes.length) {
    if (jpegBytes[offset] !== 0xff) return null;
    const marker = jpegBytes[offset + 1] ?? 0;
    if (marker === JPEG_APP1_MARKER) {
      const high = jpegBytes[offset + 2] ?? 0;
      const low = jpegBytes[offset + 3] ?? 0;
      const length = (high << 8) | low;
      if (length < 2) return null;
      // Bounds check the segment *before* reading the preamble: a
      // truncated JPEG can carry a valid-looking length field that
      // points past the end of the buffer. Returning null here
      // keeps the read surface honest for malformed input.
      if (offset + 2 + length > jpegBytes.length) return null;
      if (bytesEqualAt(jpegBytes, offset + 4, EXIF_PREAMBLE)) {
        return jpegBytes.subarray(offset + 4 + EXIF_PREAMBLE.length, offset + 2 + length);
      }
    }
    // Standalone markers (no length) advance by 2; everything else
    // steps forward by 2 + length.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentHigh = jpegBytes[offset + 2] ?? 0;
    const segmentLow = jpegBytes[offset + 3] ?? 0;
    const segmentLength = (segmentHigh << 8) | segmentLow;
    if (segmentLength < 2) return null;
    // Bounds check: a malformed or truncated JPEG can carry a segment
    // length that points past the end of the buffer. Returning null
    // here keeps the read surface honest.
    if (offset + 2 + segmentLength > jpegBytes.length) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Splice an EXIF TIFF payload back into a JPEG byte array. The payload
 * is wrapped in an APP1 segment (with the "Exif\0\0" preamble) and
 * inserted right after the SOI marker.
 */
export function injectExifIntoJpeg(jpegBytes: Uint8Array, tiffPayload: Uint8Array): Uint8Array {
  if (!bytesEqualAt(jpegBytes, 0, JPEG_SOI_MARKER)) {
    return jpegBytes;
  }
  // Accept either shape (bare TIFF or legacy APP1-with-preamble) so
  // migration is symmetric with `normalizeExifPayload` on the read side.
  const normalized = normalizeExifPayload(tiffPayload);
  const payload = normalized ?? tiffPayload;
  // Segment length includes itself (2 bytes) + preamble + payload.
  const segmentLength = 2 + EXIF_PREAMBLE.length + payload.length;
  const segment = new Uint8Array(2 + segmentLength);
  segment[0] = 0xff;
  segment[1] = JPEG_APP1_MARKER;
  segment[2] = (segmentLength >> 8) & 0xff;
  segment[3] = segmentLength & 0xff;
  segment.set(EXIF_PREAMBLE, 4);
  segment.set(payload, 4 + EXIF_PREAMBLE.length);
  const output = new Uint8Array(jpegBytes.length + segment.length);
  output.set(jpegBytes.subarray(0, 2), 0);
  output.set(segment, 2);
  output.set(jpegBytes.subarray(2), 2 + segment.length);
  return output;
}

/**
 * Read the EXIF TIFF payload from a PNG byte array. Walks the chunks
 * looking for an `eXIf` ancillary chunk and returns its data.
 */
export function readExifFromPng(pngBytes: Uint8Array): Uint8Array | null {
  if (!bytesEqualAt(pngBytes, 0, PNG_SIGNATURE)) return null;
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= pngBytes.length) {
    const length = readUint32BigEndian(pngBytes, offset);
    const typeOffset = offset + 4;
    if (bytesEqualAt(pngBytes, typeOffset, PNG_EXIF_CHUNK_TYPE)) {
      const dataOffset = typeOffset + 4;
      return pngBytes.subarray(dataOffset, dataOffset + length);
    }
    // Critical chunk `IEND` ends the search; further chunks would be after
    // the image, which is unusual but not impossible.
    if (bytesEqualAt(pngBytes, typeOffset, PNG_IEND_CHUNK_TYPE)) {
      return null;
    }
    // 4 (length) + 4 (type) + length (data) + 4 (CRC) = length + 12
    offset = typeOffset + 4 + length + 4;
  }
  return null;
}

/**
 * Insert an `eXIf` chunk into a PNG byte array, right before the IEND
 * chunk. The TIFF payload becomes the chunk's data; the CRC is computed
 * over the type+data.
 */
export function injectExifIntoPng(pngBytes: Uint8Array, tiffPayload: Uint8Array): Uint8Array {
  if (!bytesEqualAt(pngBytes, 0, PNG_SIGNATURE)) {
    return pngBytes;
  }
  // Accept either shape (bare TIFF or legacy APP1-with-preamble).
  const normalized = normalizeExifPayload(tiffPayload);
  const payload = normalized ?? tiffPayload;
  // Find IEND so we can insert just before it.
  let iendOffset = -1;
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= pngBytes.length) {
    const length = readUint32BigEndian(pngBytes, offset);
    const typeOffset = offset + 4;
    if (bytesEqualAt(pngBytes, typeOffset, PNG_IEND_CHUNK_TYPE)) {
      iendOffset = offset;
      break;
    }
    offset = typeOffset + 4 + length + 4;
  }
  // No IEND found? Append a fresh one.
  const insertOffset = iendOffset >= 0 ? iendOffset : pngBytes.length;
  // Build the new chunk: 4 length + 4 type + payload + 4 CRC
  const chunk = new Uint8Array(12 + payload.length);
  const [b0, b1, b2, b3] = writeUint32BigEndian(payload.length);
  chunk[0] = b0;
  chunk[1] = b1;
  chunk[2] = b2;
  chunk[3] = b3;
  chunk.set(PNG_EXIF_CHUNK_TYPE, 4);
  chunk.set(payload, 8);
  // CRC over type + data
  const crcInput = chunk.subarray(4, 8 + payload.length);
  const crc = pngCrc32(crcInput);
  const [c0, c1, c2, c3] = writeUint32BigEndian(crc);
  chunk[8 + payload.length] = c0;
  chunk[9 + payload.length] = c1;
  chunk[10 + payload.length] = c2;
  chunk[11 + payload.length] = c3;
  const output = new Uint8Array(pngBytes.length + chunk.length);
  output.set(pngBytes.subarray(0, insertOffset), 0);
  output.set(chunk, insertOffset);
  output.set(pngBytes.subarray(insertOffset), insertOffset + chunk.length);
  return output;
}

/**
 * Read the EXIF TIFF payload from a WebP byte array. WebP's RIFF
 * container holds chunks keyed by FourCC; we look for the "EXIF" chunk
 * and return its contents.
 */
export function readExifFromWebp(webpBytes: Uint8Array): Uint8Array | null {
  if (webpBytes.length < 12) return null;
  if (!bytesEqualAt(webpBytes, 0, WEBP_SIGNATURE_RIFF)) return null;
  // bytes 8..11 should be "WEBP"
  if (!bytesEqualAt(webpBytes, 8, WEBP_SIGNATURE_WEBP)) return null;
  // WebP chunks start at offset 12.
  let offset = 12;
  while (offset + 8 <= webpBytes.length) {
    const length = readUint32LittleEndian(webpBytes, offset + 4);
    if (bytesEqualAt(webpBytes, offset, WEBP_EXIF_CHUNK_FOURCC)) {
      const dataOffset = offset + 8;
      return webpBytes.subarray(dataOffset, dataOffset + length);
    }
    // Chunks are padded to even length. The data length is rounded up.
    const paddedLength = length + (length & 1);
    offset += 8 + paddedLength;
  }
  return null;
}

/**
 * Insert an "EXIF" chunk into a WebP byte array. The RIFF file size
 * header is updated to reflect the new total.
 */
export function injectExifIntoWebp(webpBytes: Uint8Array, tiffPayload: Uint8Array): Uint8Array {
  if (webpBytes.length < 12) return webpBytes;
  if (!bytesEqualAt(webpBytes, 0, WEBP_SIGNATURE_RIFF)) return webpBytes;
  if (!bytesEqualAt(webpBytes, 8, WEBP_SIGNATURE_WEBP)) return webpBytes;
  // Accept either shape (bare TIFF or legacy APP1-with-preamble).
  const normalized = normalizeExifPayload(tiffPayload);
  const payload = normalized ?? tiffPayload;
  // Find insertion point: after the VP8 / VP8L / VP8X / etc. first chunk.
  // The first chunk always starts at offset 12.
  const firstChunkOffset = 12;
  // RIFF chunks are padded to an even length. If tiffPayload is odd,
  // we need one extra byte of pad so the next chunk stays aligned.
  const paddedSize = payload.length + (payload.length & 1);
  const exifChunk = new Uint8Array(8 + paddedSize);
  exifChunk.set(WEBP_EXIF_CHUNK_FOURCC, 0);
  exifChunk[4] = payload.length & 0xff;
  exifChunk[5] = (payload.length >> 8) & 0xff;
  exifChunk[6] = (payload.length >> 16) & 0xff;
  exifChunk[7] = (payload.length >> 24) & 0xff;
  exifChunk.set(payload, 8);
  // Zero-fill any padding byte (only the first one is ever set, but
  // Uint8Array is zero-initialized so we just leave the rest alone).
  if (paddedSize > payload.length) {
    exifChunk[8 + payload.length] = 0;
  }
  const output = new Uint8Array(webpBytes.length + exifChunk.length);
  output.set(webpBytes.subarray(0, firstChunkOffset), 0);
  output.set(exifChunk, firstChunkOffset);
  output.set(webpBytes.subarray(firstChunkOffset), firstChunkOffset + exifChunk.length);
  // Update the RIFF file size (bytes 4..7, little-endian). RIFF size
  // excludes the "RIFF" + size field itself (8 bytes) but includes the
  // "WEBP" + all chunks.
  const newRiffSize = output.length - 8;
  output[4] = newRiffSize & 0xff;
  output[5] = (newRiffSize >> 8) & 0xff;
  output[6] = (newRiffSize >> 16) & 0xff;
  output[7] = (newRiffSize >> 24) & 0xff;
  return output;
}

// ---------------------------------------------------------------------------
// Format-agnostic public API. This is the surface used by the rest of the
// app; the per-format functions above are implementation details.
// ---------------------------------------------------------------------------

/**
 * Read the EXIF payload from a JPEG, PNG, or WebP byte array. Returns
 * the bare TIFF payload (no JPEG preamble) in a format-agnostic shape,
 * or null if the input doesn't carry EXIF.
 */
export function readExifSegment(bytes: Uint8Array, mimeType: string): Uint8Array | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") {
    return readExifFromJpeg(bytes);
  }
  if (normalized === "image/png") {
    return readExifFromPng(bytes);
  }
  if (normalized === "image/webp") {
    return readExifFromWebp(bytes);
  }
  return null;
}

/**
 * Splice an EXIF TIFF payload into a JPEG, PNG, or WebP byte array.
 * Returns the input unchanged if the format isn't supported.
 */
export function injectExifSegment(bytes: Uint8Array, mimeType: string, tiffPayload: Uint8Array): Uint8Array {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") {
    return injectExifIntoJpeg(bytes, tiffPayload);
  }
  if (normalized === "image/png") {
    return injectExifIntoPng(bytes, tiffPayload);
  }
  if (normalized === "image/webp") {
    return injectExifIntoWebp(bytes, tiffPayload);
  }
  return bytes;
}

/**
 * Convenience: pull the EXIF TIFF payload out of a `Blob` (e.g., a
 * recently-imported file). Returns null for unsupported formats or
 * when the input doesn't carry EXIF. The result is in the format-
 * agnostic shape: bare TIFF, no JPEG preamble.
 */
export async function readExifFromBlob(blob: Blob): Promise<Uint8Array | null> {
  const buffer = await blob.arrayBuffer();
  const raw = readExifSegment(new Uint8Array(buffer), blob.type);
  if (!raw) return null;
  return normalizeExifPayload(raw);
}

/**
 * Convenience: produce a new `Blob` with the original EXIF payload
 * re-injected. The payload is in the format-agnostic shape (bare TIFF)
 * and the injection is format-specific (JPEG gets the "Exif\0\0"
 * preamble, PNG / WebP don't).
 */
export async function withExifInjected(blob: Blob, tiffPayload: Uint8Array | null): Promise<Blob> {
  if (!tiffPayload) return blob;
  const buffer = await blob.arrayBuffer();
  const merged = injectExifSegment(new Uint8Array(buffer), blob.type, tiffPayload);
  if (merged === buffer) return blob;
  return new Blob([merged], { type: blob.type });
}

/**
 * Returns true when the input bytes look like a complete, well-formed JPEG
 * (start with SOI, end with EOI).
 */
/**
 * EXIF Orientation tag value (1..8). 1 = upright; values 2..8 encode
 * mirror / rotate combinations. Returns 1 (the safe default) when the
 * tag is missing or the IFD can't be parsed. Best-effort: we walk the
 * TIFF structure by hand to avoid pulling in a full EXIF parser.
 */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function isOrientation(value: number): value is ExifOrientation {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (littleEndian) {
    return ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
  }
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (littleEndian) {
    return (
      ((bytes[offset + 3] ?? 0) << 24) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 1] ?? 0) << 8) |
      (bytes[offset] ?? 0)
    ) >>> 0;
  }
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

/**
 * Parse the EXIF Orientation tag (0x0112) out of a bare TIFF payload.
 * Returns 1 when the tag is absent or the structure can't be parsed.
 */
export function getExifOrientation(tiffBytes: Uint8Array | null): ExifOrientation {
  if (!tiffBytes || tiffBytes.length < 8) return 1;
  // Byte order marker: "II" (little) or "MM" (big).
  const littleEndian = tiffBytes[0] === 0x49 && tiffBytes[1] === 0x49;
  const isBig = tiffBytes[0] === 0x4d && tiffBytes[1] === 0x4d;
  if (!littleEndian && !isBig) return 1;
  // Magic 0x002A follows the byte order marker.
  const magic = readUint16(tiffBytes, 2, littleEndian);
  if (magic !== 0x002a) return 1;
  // Offset to IFD0.
  const ifdOffset = readUint32(tiffBytes, 4, littleEndian);
  if (ifdOffset + 2 > tiffBytes.length) return 1;
  const entryCount = readUint16(tiffBytes, ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > tiffBytes.length) return 1;
    const tag = readUint16(tiffBytes, entryOffset, littleEndian);
    if (tag === 0x0112) {
      // Type SHORT (3) at entryOffset+2, count at +4, value at +8.
      const value = readUint16(tiffBytes, entryOffset + 8, littleEndian);
      return isOrientation(value) ? (value as ExifOrientation) : 1;
    }
  }
  return 1;
}

/**
 * Convenience: pull the Orientation tag out of a Blob (e.g. a recently
 * imported file). Returns 1 when the file doesn't carry EXIF, can't be
 * read, or doesn't have an Orientation tag.
 */
export async function getExifOrientationFromBlob(blob: Blob): Promise<ExifOrientation> {
  try {
    const buffer = await blob.arrayBuffer();
    const tiff = readExifSegment(new Uint8Array(buffer), blob.type);
    return getExifOrientation(tiff);
  } catch {
    return 1;
  }
}

export function isCompleteJpeg(bytes: Uint8Array): boolean {
  if (!bytesEqualAt(bytes, 0, JPEG_SOI_MARKER)) return false;
  if (bytes.length < 4) return false;
  const lastTwo = bytes.length - 2;
  return bytesEqualAt(bytes, lastTwo, JPEG_EOI_MARKER);
}
