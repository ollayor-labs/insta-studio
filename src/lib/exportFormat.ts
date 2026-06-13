// Export format resolution. Lives in its own module so `BottomBar.tsx` can
// stay component-only and keep fast-refresh happy.

export type ExportFormat = "jpeg" | "png" | "webp" | "original";

const EXPORT_FORMAT_MIME: Record<Exclude<ExportFormat, "original">, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const EXPORT_FORMAT_EXTENSION: Record<Exclude<ExportFormat, "original">, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

const SUPPORTED_EXPORT_MIME_TYPES = new Set<string>(Object.values(EXPORT_FORMAT_MIME));

/**
 * Resolve the user-facing `ExportFormat` into a concrete MIME type. When the
 * user picks `original` we honor the source file's MIME if it's a format we
 * can encode (PNG, JPEG, WebP); otherwise we fall back to JPEG so HEIC and
 * other browser-unencodable source formats still get a usable export.
 */
export function resolveExportMime(format: ExportFormat, sourceMimeType: string | null): string {
  if (format !== "original") return EXPORT_FORMAT_MIME[format];
  if (sourceMimeType) {
    const normalized = sourceMimeType.toLowerCase();
    if (SUPPORTED_EXPORT_MIME_TYPES.has(normalized)) {
      return normalized;
    }
  }
  return "image/jpeg";
}

export function resolveExportExtension(format: ExportFormat, sourceMimeType: string | null): string {
  if (format !== "original") return EXPORT_FORMAT_EXTENSION[format];
  const mime = resolveExportMime("original", sourceMimeType);
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}
