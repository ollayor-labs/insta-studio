import { describe, expect, it } from "vitest";
import {
  injectExifSegment,
  isCompleteJpeg,
  readExifSegment,
} from "@/lib/exif";

// ---------------------------------------------------------------------------
// JPEG fixtures
// ---------------------------------------------------------------------------

// SOI (FFD8) + APP1 (FFE1) with "Exif\0\0" preamble + tiny payload + EOI (FFD9)
function buildJpegWithExif(payload: number[]): Uint8Array {
  const exifMarker = 0xff;
  const exifApp1 = 0xe1;
  const exifPreamble = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  // Segment length includes itself (2 bytes) + payload (preamble + body)
  const segmentLength = 2 + exifPreamble.length + payload.length;
  const bytes: number[] = [
    0xff, 0xd8, // SOI
    exifMarker, exifApp1,
    (segmentLength >> 8) & 0xff,
    segmentLength & 0xff,
    ...exifPreamble,
    ...payload,
    0xff, 0xd9, // EOI
  ];
  return new Uint8Array(bytes);
}

function buildJpegWithoutExif(): Uint8Array {
  // Just SOI + a single APP0 (JFIF) + EOI. No EXIF.
  const app0Length = 2 + 5; // length + 5 bytes of JFIF magic
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, // APP0
    (app0Length >> 8) & 0xff,
    app0Length & 0xff,
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0xff, 0xd9, // EOI
  ]);
}

// ---------------------------------------------------------------------------
// PNG fixtures
// ---------------------------------------------------------------------------

// PNG signature + a single IDAT-like chunk + IEND. The chunk type doesn't
// need to be a real PNG chunk — we only care that the eXIf chunk is
// discoverable / injectable. The "fake" chunk type uses "fAkE" so the
// reader correctly skips it on its way to the eXIf chunk.
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngCrc32(bytes: number[]): number {
  // CRC32 with PNG polynomial 0xedb88320 (reflected). We re-implement it
  // here so the test fixtures can produce valid CRCs without exporting
  // the table from the module.
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
  const length = data.length;
  const typeBytes = Array.from(type).map((c) => c.charCodeAt(0));
  const crc = pngCrc32([...typeBytes, ...data]);
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...typeBytes,
    ...data,
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ];
}

function buildPngWithExif(payload: number[]): Uint8Array {
  // fAkE chunk (just for filler) + eXIf chunk + IEND
  return new Uint8Array([
    ...PNG_SIG,
    ...pngChunk("fAkE", [1, 2, 3, 4]),
    ...pngChunk("eXIf", payload),
    ...pngChunk("IEND", []),
  ]);
}

function buildPngWithoutExif(): Uint8Array {
  return new Uint8Array([
    ...PNG_SIG,
    ...pngChunk("fAkE", [1, 2, 3, 4]),
    ...pngChunk("IEND", []),
  ]);
}

// ---------------------------------------------------------------------------
// WebP fixtures
// ---------------------------------------------------------------------------

function writeLe32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function buildWebpWithExif(payload: number[]): Uint8Array {
  // RIFF header + WEBP + one VP8 chunk (filler) + one EXIF chunk
  const vp8Payload = [0xde, 0xad, 0xbe, 0xef];
  const vp8Chunk = [
    0x56, 0x50, 0x38, 0x20, // "VP8 "
    ...writeLe32(vp8Payload.length),
    ...vp8Payload,
  ];
  const exifChunk = [
    0x45, 0x58, 0x49, 0x46, // "EXIF"
    ...writeLe32(payload.length),
    ...payload,
    // If payload is odd, the writer would pad with a zero byte. We
    // don't exercise that case here — keep the payload even.
  ];
  const riffBody = [
    0x57, 0x45, 0x42, 0x50, // "WEBP"
    ...vp8Chunk,
    ...exifChunk,
  ];
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    ...writeLe32(riffBody.length),
    ...riffBody,
  ]);
}

function buildWebpWithoutExif(): Uint8Array {
  const vp8Payload = [0xde, 0xad, 0xbe, 0xef];
  const vp8Chunk = [
    0x56, 0x50, 0x38, 0x20, // "VP8 "
    ...writeLe32(vp8Payload.length),
    ...vp8Payload,
  ];
  const riffBody = [
    0x57, 0x45, 0x42, 0x50, // "WEBP"
    ...vp8Chunk,
  ];
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    ...writeLe32(riffBody.length),
    ...riffBody,
  ]);
}

// ---------------------------------------------------------------------------
// JPEG tests
// ---------------------------------------------------------------------------

describe("EXIF read/parse (JPEG)", () => {
  it("returns null for non-JPEG input", () => {
    const pngHeader = new Uint8Array(PNG_SIG);
    expect(readExifSegment(pngHeader, "image/png")).toBeNull();
  });

  it("returns null for a JPEG without an EXIF segment", () => {
    expect(readExifSegment(buildJpegWithoutExif(), "image/jpeg")).toBeNull();
  });

  it("returns null for a JPEG that's truncated mid-segment", () => {
    const bytes = buildJpegWithExif([1, 2, 3, 4]);
    const truncated = bytes.subarray(0, bytes.length - 4);
    expect(readExifSegment(truncated, "image/jpeg")).toBeNull();
  });

  it("extracts the bare TIFF payload (no JPEG marker, length, or preamble)", () => {
    const payload = [0xaa, 0xbb, 0xcc, 0xdd];
    const jpeg = buildJpegWithExif(payload);
    const segment = readExifSegment(jpeg, "image/jpeg");
    expect(segment).not.toBeNull();
    // The bare TIFF payload is just the 4 bytes we stuffed in.
    expect(segment!.length).toBe(payload.length);
    expect(Array.from(segment!)).toEqual(payload);
  });

  it("walks past other APP segments to find EXIF", () => {
    const exifPayload = [0x10, 0x20, 0x30];
    const app0Preamble = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
    const app0Length = 2 + app0Preamble.length;
    const app1Preamble = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    const app1Length = 2 + app1Preamble.length + exifPayload.length;
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0,
      (app0Length >> 8) & 0xff,
      app0Length & 0xff,
      ...app0Preamble,
      0xff, 0xe1,
      (app1Length >> 8) & 0xff,
      app1Length & 0xff,
      ...app1Preamble,
      ...exifPayload,
      0xff, 0xd9,
    ]);
    const segment = readExifSegment(jpeg, "image/jpeg");
    expect(segment).not.toBeNull();
    expect(Array.from(segment!)).toEqual(exifPayload);
  });

  it("strips the legacy JPEG preamble if a stored payload has one", () => {
    // Simulate the migration case: a recent was stored with the old
    // shape (APP1 segment bytes, preamble included). The new
    // format-agnostic API expects bare TIFF. Build the segment and
    // hand it back through injectExifSegment — the output should
    // match what a bare-TIFF round-trip would produce.
    const payload = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]; // "II" + 0x002A + IFD offset
    const legacySegment = new Uint8Array([0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...payload]);
    const bare = new Uint8Array(payload);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fromLegacy = injectExifSegment(jpeg, "image/jpeg", legacySegment);
    const fromBare = injectExifSegment(jpeg, "image/jpeg", bare);
    // Both injections should produce identical bytes: the legacy
    // preamble is normalized away before splicing.
    expect(Array.from(fromLegacy)).toEqual(Array.from(fromBare));
  });
});

describe("EXIF inject (JPEG)", () => {
  it("inserts the segment right after the SOI marker", () => {
    const exif = new Uint8Array([0x49, 0x49, 0x2a, 0x00]); // bare TIFF header
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const merged = injectExifSegment(jpeg, "image/jpeg", exif);
    // 2 (SOI) + 2 (APP1 marker) + 2 (length) + 6 (preamble) + 4 (payload) + 2 (EOI) = 18
    expect(merged.length).toBe(2 + 2 + 2 + 6 + exif.length + 2);
    expect(merged[0]).toBe(0xff);
    expect(merged[1]).toBe(0xd8);
    expect(merged[2]).toBe(0xff);
    expect(merged[3]).toBe(0xe1);
    // The original EOI is now at the end.
    expect(merged[merged.length - 2]).toBe(0xff);
    expect(merged[merged.length - 1]).toBe(0xd9);
    // The "Exif\0\0" preamble should be present right after the length.
    expect(Array.from(merged.subarray(6, 12))).toEqual([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  });

  it("returns the original input unchanged when it isn't a JPEG", () => {
    const notJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const exif = new Uint8Array([1, 2, 3]);
    expect(injectExifSegment(notJpeg, "image/jpeg", exif)).toBe(notJpeg);
  });

  it("round-trips: readExif(injectExif(jpeg, tiff)) === tiff", () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50]);
    const stripped = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // JPEG without EXIF
    const reInjected = injectExifSegment(stripped, "image/jpeg", tiff);
    const roundTrip = readExifSegment(reInjected, "image/jpeg");
    expect(roundTrip).not.toBeNull();
    expect(Array.from(roundTrip!)).toEqual(Array.from(tiff));
  });
});

// ---------------------------------------------------------------------------
// PNG tests
// ---------------------------------------------------------------------------

describe("EXIF read/parse (PNG)", () => {
  it("returns null for non-PNG input", () => {
    const jpeg = buildJpegWithoutExif();
    expect(readExifSegment(jpeg, "image/png")).toBeNull();
  });

  it("returns null for a PNG without an eXIf chunk", () => {
    expect(readExifSegment(buildPngWithoutExif(), "image/png")).toBeNull();
  });

  it("extracts the eXIf chunk payload", () => {
    const payload = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00];
    const png = buildPngWithExif(payload);
    const segment = readExifSegment(png, "image/png");
    expect(segment).not.toBeNull();
    expect(Array.from(segment!)).toEqual(payload);
  });

  it("round-trips: readExif(injectExif(png, tiff)) === tiff", () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
    const png = buildPngWithoutExif();
    const reInjected = injectExifSegment(png, "image/png", tiff);
    const roundTrip = readExifSegment(reInjected, "image/png");
    expect(roundTrip).not.toBeNull();
    expect(Array.from(roundTrip!)).toEqual(Array.from(tiff));
  });
});

describe("EXIF inject (PNG)", () => {
  it("inserts the eXIf chunk just before IEND and writes a valid CRC", () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const png = buildPngWithoutExif();
    const merged = injectExifSegment(png, "image/png", tiff);
    // The new file should be original + 12 bytes of chunk overhead
    // (4 length + 4 type + 4 CRC, plus the payload).
    expect(merged.length).toBe(png.length + 12 + tiff.length);
    // Last 12 bytes should still be the IEND chunk.
    const iendStart = merged.length - 12;
    expect(Array.from(merged.subarray(iendStart + 4, iendStart + 8))).toEqual([0x49, 0x45, 0x4e, 0x44]);
    // Walk the chunks and validate the eXIf CRC.
    let offset = PNG_SIG.length;
    let foundExif = false;
    while (offset + 12 <= merged.length) {
      const length = ((merged[offset] ?? 0) << 24) | ((merged[offset + 1] ?? 0) << 16) | ((merged[offset + 2] ?? 0) << 8) | (merged[offset + 3] ?? 0);
      const type = Array.from(merged.subarray(offset + 4, offset + 8)).map((b) => String.fromCharCode(b)).join("");
      if (type === "eXIf") {
        foundExif = true;
        const data = Array.from(merged.subarray(offset + 8, offset + 8 + length));
        const crcBytes = Array.from(merged.subarray(offset + 8 + length, offset + 12 + length));
        const expectedCrc = pngCrc32([...merged.subarray(offset + 4, offset + 8 + length)]);
        const actualCrc = ((crcBytes[0]! << 24) | (crcBytes[1]! << 16) | (crcBytes[2]! << 8) | crcBytes[3]!) >>> 0;
        expect(actualCrc).toBe(expectedCrc);
        // The data we stored is the bare TIFF payload.
        expect(data).toEqual(Array.from(tiff));
      }
      if (type === "IEND") break;
      offset += 12 + length;
    }
    expect(foundExif).toBe(true);
  });

  it("appends a fresh eXIf chunk when the PNG has no IEND", () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    // No IEND in this fixture.
    const png = new Uint8Array([...PNG_SIG, ...pngChunk("fAkE", [1, 2, 3])]);
    const merged = injectExifSegment(png, "image/png", tiff);
    const roundTrip = readExifSegment(merged, "image/png");
    expect(roundTrip).not.toBeNull();
    expect(Array.from(roundTrip!)).toEqual(Array.from(tiff));
  });
});

// ---------------------------------------------------------------------------
// WebP tests
// ---------------------------------------------------------------------------

describe("EXIF read/parse (WebP)", () => {
  it("returns null for non-WebP input", () => {
    const jpeg = buildJpegWithoutExif();
    expect(readExifSegment(jpeg, "image/webp")).toBeNull();
  });

  it("returns null for a WebP without an EXIF chunk", () => {
    expect(readExifSegment(buildWebpWithoutExif(), "image/webp")).toBeNull();
  });

  it("extracts the EXIF chunk payload", () => {
    const payload = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00];
    const webp = buildWebpWithExif(payload);
    const segment = readExifSegment(webp, "image/webp");
    expect(segment).not.toBeNull();
    expect(Array.from(segment!)).toEqual(payload);
  });

  it("round-trips: readExif(injectExif(webp, tiff)) === tiff", () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
    const webp = buildWebpWithoutExif();
    const reInjected = injectExifSegment(webp, "image/webp", tiff);
    const roundTrip = readExifSegment(reInjected, "image/webp");
    expect(roundTrip).not.toBeNull();
    expect(Array.from(roundTrip!)).toEqual(Array.from(tiff));
  });
});

describe("EXIF inject (WebP)", () => {
  it("inserts the EXIF chunk after the WEBP signature and updates the RIFF size header", () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const webp = buildWebpWithoutExif();
    const merged = injectExifSegment(webp, "image/webp", tiff);
    // 8 bytes of EXIF chunk overhead (FourCC + LE32 length) plus the payload.
    expect(merged.length).toBe(webp.length + 8 + tiff.length);
    // RIFF size header is at offset 4 (LE32). It should equal merged.length - 8.
    const riffSize = (merged[4]!) | (merged[5]! << 8) | (merged[6]! << 16) | (merged[7]! << 24);
    expect(riffSize).toBe(merged.length - 8);
    // The first chunk after WEBP signature should now be "EXIF".
    const firstChunkFourcc = Array.from(merged.subarray(12, 16)).map((b) => String.fromCharCode(b)).join("");
    expect(firstChunkFourcc).toBe("EXIF");
    // The length field of that EXIF chunk should match the tiff payload.
    const exifLen = (merged[16]!) | (merged[17]! << 8) | (merged[18]! << 16) | (merged[19]! << 24);
    expect(exifLen).toBe(tiff.length);
  });

  it("pads odd-length EXIF payloads with a zero byte", () => {
    // Three-byte payload → odd → writer should append a 0x00 pad byte.
    const tiff = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const webp = buildWebpWithoutExif();
    const merged = injectExifSegment(webp, "image/webp", tiff);
    // 8 bytes overhead + 3 bytes payload + 1 byte padding = 12 bytes added.
    expect(merged.length).toBe(webp.length + 12);
    // The padding byte sits at offset 12 + 8 + 3 = 23.
    expect(merged[23]).toBe(0x00);
    // The reader should still find the 3-byte payload (not the pad).
    const roundTrip = readExifSegment(merged, "image/webp");
    expect(roundTrip).not.toBeNull();
    expect(roundTrip!.length).toBe(3);
    expect(Array.from(roundTrip!)).toEqual([0xaa, 0xbb, 0xcc]);
  });
});

// ---------------------------------------------------------------------------
// Format-agnostic dispatch
// ---------------------------------------------------------------------------

describe("EXIF format dispatch", () => {
  it("returns null for an unsupported MIME type", () => {
    const bytes = buildJpegWithExif([1, 2, 3]);
    expect(readExifSegment(bytes, "image/gif")).toBeNull();
    expect(injectExifSegment(bytes, "image/gif", new Uint8Array([1]))).toBe(bytes);
  });
});

// ---------------------------------------------------------------------------
// isCompleteJpeg
// ---------------------------------------------------------------------------

describe("isCompleteJpeg", () => {
  it("accepts a minimal SOI + EOI pair", () => {
    expect(isCompleteJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
  });

  it("rejects non-JPEG bytes", () => {
    expect(isCompleteJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it("rejects a JPEG without an EOI", () => {
    expect(isCompleteJpeg(new Uint8Array([0xff, 0xd8, 0x00, 0x01]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

import {
  buildJpegWithExif,
} from "./helpers/test-fixtures";


// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

import { getExifOrientation } from "@/lib/exif";

// Hand-rolled TIFF payload with IFD0 containing a single Orientation tag.
// Layout: 8-byte TIFF header + 2-byte entry count + 12-byte entry +
// 4-byte next-IFD offset. The entry stores a SHORT (type 3) at value
// offset 0 (which means the value lives in the entry's value field).
function buildTiffWithOrientation(orientation: number): Uint8Array {
  const littleEndian = true;
  const bytes: number[] = [];

  // TIFF header
  bytes.push(0x49, 0x49); // "II" (little endian)
  bytes.push(0x2a, 0x00); // magic 0x002A (LE)
  bytes.push(0x08, 0x00, 0x00, 0x00); // IFD0 at offset 8

  // IFD0
  bytes.push(0x01, 0x00); // 1 entry
  // Entry: tag 0x0112 (Orientation), type 3 (SHORT), count 1, value = orientation
  bytes.push(0x12, 0x01); // tag (LE)
  bytes.push(0x03, 0x00); // type SHORT
  bytes.push(0x01, 0x00, 0x00, 0x00); // count 1
  bytes.push(orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00); // value (LE) + 2 padding
  // Next IFD offset = 0 (no more IFDs)
  bytes.push(0x00, 0x00, 0x00, 0x00);

  void littleEndian;
  return new Uint8Array(bytes);
}

describe("EXIF orientation", () => {
  it("returns 1 (the safe default) for an empty payload", () => {
    expect(getExifOrientation(new Uint8Array(0))).toBe(1);
  });

  it("returns 1 when the TIFF header is malformed", () => {
    // Wrong magic.
    expect(getExifOrientation(new Uint8Array([0x49, 0x49, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]))).toBe(1);
    // Wrong byte order.
    expect(getExifOrientation(new Uint8Array([0x00, 0x00, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]))).toBe(1);
  });

  it("returns 1 when the IFD has no Orientation tag", () => {
    // Empty IFD (zero entries). Tag 0x0112 is missing → default 1.
    const tiff = new Uint8Array([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x00, 0x00, // 0 entries
      0x00, 0x00, 0x00, 0x00, // next IFD offset
    ]);
    expect(getExifOrientation(tiff)).toBe(1);
  });

  it("returns 6 for a TIFF with an Orientation = 6 (90° CW) tag", () => {
    const tiff = buildTiffWithOrientation(6);
    expect(getExifOrientation(tiff)).toBe(6);
  });

  it("returns 8 for an Orientation = 8 (90° CCW) tag", () => {
    const tiff = buildTiffWithOrientation(8);
    expect(getExifOrientation(tiff)).toBe(8);
  });

  it("clamps out-of-range values to 1", () => {
    const tiff = buildTiffWithOrientation(42);
    expect(getExifOrientation(tiff)).toBe(1);
  });

  it("returns 1 for a real JPEG that has no EXIF segment", () => {
    // Just SOI + EOI.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(getExifOrientation(jpeg)).toBe(1);
  });
});
