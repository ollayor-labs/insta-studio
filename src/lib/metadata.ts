// Metadata / EXIF utilities for the Metadata tool.
//
// Reading is handled by `exifr` (rich, format-agnostic parsing). Writing /
// stripping is handled by `piexifjs`, which operates on base64 JPEG data URLs
// and only understands JPEG. Every strip helper is defensive: if the input is
// not a JPEG, carries no EXIF, or piexif throws for any reason, we return the
// original data URL unchanged so callers can pipe any format through safely.

import exifr from "exifr";
import piexif from "piexifjs";

export type MetadataPrivacy = "keep" | "strip-gps" | "strip-all";

export interface ImageMeta {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  fNumber?: number;
  exposureTime?: number;
  focalLength?: number;
  dateTime?: string;
  width?: number;
  height?: number;
  lat?: number;
  lon?: number;
  hasGps: boolean;
  artist?: string;
  copyright?: string;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toStringField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toDateTime(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return toStringField(value);
}

/**
 * Read camera / authorship / location metadata from an image blob using exifr.
 * Returns null if the input carries no EXIF or parsing fails.
 */
export async function readImageMetadata(input: File | Blob): Promise<ImageMeta | null> {
  try {
    // exifr always parses IFD0 (its types note it "cannot be disabled"),
    // so it must not be listed here — requesting it with a boolean is a
    // type error and has no effect.
    const raw = await exifr.parse(input, {
      tiff: true,
      exif: true,
      gps: true,
      iptc: true,
    });
    if (!raw) return null;

    const lat = toNumber(raw.latitude);
    const lon = toNumber(raw.longitude);

    const meta: ImageMeta = {
      make: toStringField(raw.Make),
      model: toStringField(raw.Model),
      lens: toStringField(raw.LensModel),
      iso: toNumber(raw.ISO),
      fNumber: toNumber(raw.FNumber),
      exposureTime: toNumber(raw.ExposureTime),
      focalLength: toNumber(raw.FocalLength),
      dateTime: toDateTime(raw.DateTimeOriginal ?? raw.CreateDate),
      width: toNumber(raw.ExifImageWidth),
      height: toNumber(raw.ExifImageHeight),
      lat,
      lon,
      hasGps: lat != null && lon != null,
      artist: toStringField(raw.Artist),
      copyright: toStringField(raw.Copyright),
    };

    return meta;
  } catch {
    return null;
  }
}

/**
 * Strip ALL metadata from a base64 JPEG data URL. Returns the input unchanged
 * if it is not a JPEG / has no EXIF / piexif throws.
 */
export function stripAllFromJpegDataUrl(dataUrl: string): string {
  try {
    return piexif.remove(dataUrl);
  } catch {
    return dataUrl;
  }
}

/**
 * Strip only GPS metadata from a base64 JPEG data URL, preserving camera and
 * other EXIF. Returns the input unchanged on any failure.
 */
export function stripGpsFromJpegDataUrl(dataUrl: string): string {
  try {
    const exifObj = piexif.load(dataUrl);
    // Drop the GPS IFD entirely, keep everything else.
    exifObj.GPS = {};
    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, dataUrl);
  } catch {
    return dataUrl;
  }
}

/**
 * Apply a privacy policy to a base64 JPEG data URL. Safe for any input:
 * non-JPEG / EXIF-less data URLs are returned unchanged.
 */
export function applyPrivacyToJpegDataUrl(dataUrl: string, privacy: MetadataPrivacy): string {
  switch (privacy) {
    case "strip-all":
      return stripAllFromJpegDataUrl(dataUrl);
    case "strip-gps":
      return stripGpsFromJpegDataUrl(dataUrl);
    case "keep":
    default:
      return dataUrl;
  }
}

/**
 * Format a shutter/exposure time (in seconds) for display. Sub-second values
 * render as a reciprocal fraction ("1/250s"); values >= 1s render as decimals
 * ("2s", "1.3s").
 */
export function formatExposure(t?: number): string {
  if (t == null || !Number.isFinite(t) || t <= 0) return "—";
  if (t >= 1) {
    // Trim trailing ".0" for whole seconds.
    const rounded = Math.round(t * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}s`;
  }
  const denominator = Math.round(1 / t);
  return `1/${denominator}s`;
}

/** Format an f-number as an aperture string, e.g. "f/2.8". */
export function formatFNumber(f?: number): string {
  if (f == null || !Number.isFinite(f)) return "—";
  const rounded = Math.round(f * 10) / 10;
  return `f/${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}`;
}

/** Format a focal length in millimetres, e.g. "35mm". */
export function formatFocalLength(mm?: number): string {
  if (mm == null || !Number.isFinite(mm)) return "—";
  return `${Math.round(mm)}mm`;
}

/** Join make + model into a single readable camera name. */
export function formatCamera(make?: string, model?: string): string {
  const parts: string[] = [];
  if (make) parts.push(make);
  // Avoid "Canon Canon EOS" style duplication.
  if (model && (!make || !model.toLowerCase().startsWith(make.toLowerCase()))) {
    parts.push(model);
  } else if (model) {
    parts.push(model);
  }
  const joined = parts.join(" ").trim();
  return joined.length ? joined : "—";
}
