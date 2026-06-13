import { describe, expect, it } from "vitest";
import { resolveExportExtension, resolveExportMime } from "@/lib/exportFormat";

describe("export format resolution", () => {
  it("returns the explicit MIME for jpeg/png/webp", () => {
    expect(resolveExportMime("jpeg", null)).toBe("image/jpeg");
    expect(resolveExportMime("png", null)).toBe("image/png");
    expect(resolveExportMime("webp", null)).toBe("image/webp");
  });

  it("returns the matching extension for jpeg/png/webp", () => {
    expect(resolveExportExtension("jpeg", null)).toBe("jpg");
    expect(resolveExportExtension("png", null)).toBe("png");
    expect(resolveExportExtension("webp", null)).toBe("webp");
  });

  it("'original' honors the source MIME when it is a supported export type", () => {
    expect(resolveExportMime("original", "image/jpeg")).toBe("image/jpeg");
    expect(resolveExportMime("original", "image/png")).toBe("image/png");
    expect(resolveExportMime("original", "image/webp")).toBe("image/webp");
    expect(resolveExportExtension("original", "image/jpeg")).toBe("jpg");
    expect(resolveExportExtension("original", "image/png")).toBe("png");
    expect(resolveExportExtension("original", "image/webp")).toBe("webp");
  });

  it("'original' falls back to JPEG when the source MIME is not encodable", () => {
    // HEIC, AVIF, TIFF, etc - the browser can't encode them as canvas.toBlob
    // output. We degrade to JPEG so the user still gets a usable export.
    expect(resolveExportMime("original", "image/heic")).toBe("image/jpeg");
    expect(resolveExportMime("original", "image/avif")).toBe("image/jpeg");
    expect(resolveExportMime("original", "image/tiff")).toBe("image/jpeg");
    expect(resolveExportMime("original", null)).toBe("image/jpeg");
    expect(resolveExportMime("original", "")).toBe("image/jpeg");
    expect(resolveExportExtension("original", "image/heic")).toBe("jpg");
  });

  it("'original' is case-insensitive on the source MIME (browsers normalize)", () => {
    // Browsers normalize MIME types to lowercase, but defensively accept
    // mixed case so we don't break if a Blob.type is unusual.
    expect(resolveExportMime("original", "Image/JPEG")).toBe("image/jpeg");
    expect(resolveExportMime("original", "IMAGE/PNG")).toBe("image/png");
  });
});
