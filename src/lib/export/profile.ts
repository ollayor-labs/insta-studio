// ExportProfile: a strict, declarative spec for a single social
// platform export. The export pipeline reads this object and
// applies the constraints verbatim. The UI shows the resolved
// numbers (e.g. "Instagram Feed · 1350×1620 · sRGB · Sharpened")
// so the user can verify the *contract* before clicking export.
//
// The platform-specific profiles here are *contracts* — they
// match the platform's accepted upload dimensions and quality
// budgets. If a platform changes its spec, we change it here
// and the entire app picks it up. There is no per-screen
// "Instagram magic" anywhere else in the codebase.

export type ExportProfileId =
  | "custom"
  | "instagram-feed"
  | "instagram-square"
  | "instagram-story"
  | "x-feed";

export interface ExportProfile {
  id: ExportProfileId;
  label: string;
  description: string;
  /** Cap the longer edge of the output to this many pixels. null = no resize. */
  maxLongestEdge: number | null;
  /** Target aspect ratio hint (W/H). null = keep the source ratio. */
  aspectRatio: number | null;
  format: "jpeg" | "png" | "webp";
  /** 0..100. Only applied to lossy formats. */
  quality: number;
  /** Convert to sRGB color space before encoding. */
  srgb: boolean;
  /** Drop EXIF metadata on export. */
  stripExif: boolean;
  /** Post-resize unsharp mask strength, 0..1. 0 = off. */
  sharpen: number;
  /** Whether this profile is allowed to be paired with the watermark toggle. */
  watermarkEligible: boolean;
  /**
   * Free-form notes shown in the receipt (e.g. "Resized to 1350px,
   * sRGB, mild sharpening"). Kept in the profile so the receipt
   * is auto-derived from the spec — never edited per-export.
   */
  receiptNotes: string[];
}

export const EXPORT_PROFILES: ExportProfile[] = [
  {
    id: "custom",
    label: "Custom",
    description: "No constraints. Resize, format, and quality are yours to choose.",
    maxLongestEdge: null,
    aspectRatio: null,
    format: "jpeg",
    quality: 95,
    srgb: false,
    stripExif: false,
    sharpen: 0,
    watermarkEligible: true,
    receiptNotes: ["No platform constraints applied"],
  },
  {
    id: "instagram-feed",
    label: "Instagram Feed",
    description: "4:5 portrait · 1350×1620 max · sRGB · mild sharpen",
    maxLongestEdge: 1350,
    aspectRatio: 4 / 5,
    format: "jpeg",
    quality: 92,
    srgb: true,
    stripExif: true,
    sharpen: 0.4,
    watermarkEligible: true,
    receiptNotes: ["Resized to 1350px longest edge", "sRGB color space", "Mild sharpening", "EXIF stripped"],
  },
  {
    id: "instagram-square",
    label: "Instagram Square",
    description: "1:1 square · 1080×1080 max · sRGB",
    maxLongestEdge: 1080,
    aspectRatio: 1,
    format: "jpeg",
    quality: 90,
    srgb: true,
    stripExif: true,
    sharpen: 0.3,
    watermarkEligible: true,
    receiptNotes: ["Resized to 1080px", "sRGB color space", "EXIF stripped"],
  },
  {
    id: "instagram-story",
    label: "Story / Reel",
    description: "9:16 vertical · 1080×1920 max · sRGB",
    maxLongestEdge: 1080,
    aspectRatio: 9 / 16,
    format: "jpeg",
    quality: 90,
    srgb: true,
    stripExif: true,
    sharpen: 0.3,
    watermarkEligible: true,
    receiptNotes: ["Resized to 1080px longest edge", "sRGB color space", "EXIF stripped"],
  },
  {
    id: "x-feed",
    label: "X / Twitter",
    description: "16:9 wide · 1200×675 max · sRGB",
    maxLongestEdge: 1200,
    aspectRatio: 16 / 9,
    format: "jpeg",
    quality: 92,
    srgb: true,
    stripExif: true,
    sharpen: 0.35,
    watermarkEligible: true,
    receiptNotes: ["Resized to 1200px longest edge", "sRGB color space", "Mild sharpening", "EXIF stripped"],
  },
];

export function getExportProfile(id: ExportProfileId): ExportProfile {
  const profile = EXPORT_PROFILES.find((entry) => entry.id === id);
  if (!profile) {
    // "custom" is the safe default — never throw on an unknown
    // id, since the user could have a stale value in localStorage.
    return EXPORT_PROFILES[0];
  }
  return profile;
}

// Resolved target dimensions given a source aspect. The longest
// edge is capped at `maxLongestEdge`; the shorter edge is
// derived from the source ratio.
export function resolveTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  profile: ExportProfile,
): { width: number; height: number; longestEdge: number } {
  if (profile.maxLongestEdge === null) {
    return {
      width: sourceWidth,
      height: sourceHeight,
      longestEdge: Math.max(sourceWidth, sourceHeight),
    };
  }
  const ratio = sourceWidth / sourceHeight;
  let width: number;
  let height: number;
  if (ratio >= 1) {
    width = Math.min(profile.maxLongestEdge, sourceWidth);
    height = Math.round(width / ratio);
  } else {
    height = Math.min(profile.maxLongestEdge, sourceHeight);
    width = Math.round(height * ratio);
  }
  return { width, height, longestEdge: Math.max(width, height) };
}

// Build a human-readable receipt for the export. The shape is
// "Profile · WxH · sRGB · Sharpened" — concrete, inspectable,
// and reverse-engineerable. The user can paste this into a
// support email and the operator will know exactly what was
// applied.
export function buildExportReceipt(input: {
  profile: ExportProfile;
  actualWidth: number;
  actualHeight: number;
  watermark: boolean;
}): string {
  const { profile, actualWidth, actualHeight, watermark } = input;
  const parts: string[] = [`${profile.label} · ${actualWidth}×${actualHeight}`];
  if (profile.srgb) parts.push("sRGB");
  if (profile.sharpen > 0) parts.push("Sharpened");
  if (profile.stripExif) parts.push("EXIF stripped");
  if (watermark && profile.watermarkEligible) parts.push("Watermarked");
  return parts.join(" · ");
}

// Type aliases for the runtime encoding. The pipeline can use
// `RenderCanvas` everywhere — it's `OffscreenCanvas` when
// available (faster, no DOM), and falls back to a plain
// HTMLCanvasElement otherwise.
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

export function createRenderCanvas(width: number, height: number): RenderCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Resize a source canvas into a new canvas of the target
// dimensions, with high-quality resampling. Used for the
// maxLongestEdge constraint and the sRGB conversion (which is
// a no-op in our 2D-canvas pipeline — the canvas backbuffer is
// always sRGB, so we just resize and let the encoder pick it
// up. We flag it in the receipt so the user knows it happened.)
export function resampleForProfile(
  source: RenderCanvas,
  targetWidth: number,
  targetHeight: number,
): RenderCanvas {
  const output = createRenderCanvas(targetWidth, targetHeight);
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("Could not create output canvas context for export profile");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight);
  return output;
}

// Simple unsharp mask: `result = clamp(original + amount * (original - blurred))`.
// The "blurred" is a small box blur on a luminance-equivalent pass
// over RGB. The amount is profile-driven (0..1). At 0 we skip
// the pass entirely (zero work).
export function applyUnsharpMask(
  canvas: RenderCanvas,
  amount: number,
): void {
  if (amount <= 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  const source = ctx.getImageData(0, 0, width, height);
  const blurred = boxBlurRGB(source, 1);
  const out = source.data;
  const blurredData = blurred.data;
  // Strength curve: 0..1 amount maps to 0..~1.2 effective
  // multiplier. A value of 1 is "strong" but not destructive.
  const strength = amount * 1.2;
  for (let i = 0; i < out.length; i += 4) {
    const dr = out[i] - blurredData[i];
    const dg = out[i + 1] - blurredData[i + 1];
    const db = out[i + 2] - blurredData[i + 2];
    out[i] = clampByte(out[i] + dr * strength);
    out[i + 1] = clampByte(out[i + 1] + dg * strength);
    out[i + 2] = clampByte(out[i + 2] + db * strength);
    // Alpha is preserved.
  }
  ctx.putImageData(source, 0, 0);
}

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

// In-place 1D box blur on each row, then on each column. The
// radius of 1 means a 3x3 blur (one pixel in each direction).
// Sufficient for an unsharp-mask "low-frequency" estimate.
function boxBlurRGB(input: ImageData, radius: number): ImageData {
  const { width, height, data } = input;
  const out = new Uint8ClampedArray(data.length);
  // Horizontal pass.
  const window = radius * 2 + 1;
  const tempRow = new Float32Array(width * 3);
  for (let y = 0; y < height; y += 1) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const rowStart = y * width * 4;
    // Seed the running sum.
    for (let x = -radius; x <= radius; x += 1) {
      const xi = Math.max(0, Math.min(width - 1, x));
      const i = rowStart + xi * 4;
      sumR += data[i];
      sumG += data[i + 1];
      sumB += data[i + 2];
    }
    for (let x = 0; x < width; x += 1) {
      tempRow[x * 3] = sumR / window;
      tempRow[x * 3 + 1] = sumG / window;
      tempRow[x * 3 + 2] = sumB / window;
      const xOut = x + radius;
      const xIn = x - radius - 1;
      const iOut = rowStart + Math.min(width - 1, xOut) * 4;
      const iIn = rowStart + Math.max(0, xIn) * 4;
      sumR += data[iOut] - data[iIn];
      sumG += data[iOut + 1] - data[iIn + 1];
      sumB += data[iOut + 2] - data[iIn + 2];
    }
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + x * 4;
      out[i] = tempRow[x * 3];
      out[i + 1] = tempRow[x * 3 + 1];
      out[i + 2] = tempRow[x * 3 + 2];
      out[i + 3] = data[i + 3];
    }
  }
  // Vertical pass over the horizontal output.
  const finalOut = new Uint8ClampedArray(data.length);
  for (let x = 0; x < width; x += 1) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let y = -radius; y <= radius; y += 1) {
      const yi = Math.max(0, Math.min(height - 1, y));
      const i = (yi * width + x) * 4;
      sumR += out[i];
      sumG += out[i + 1];
      sumB += out[i + 2];
    }
    for (let y = 0; y < height; y += 1) {
      const i = (y * width + x) * 4;
      finalOut[i] = sumR / window;
      finalOut[i + 1] = sumG / window;
      finalOut[i + 2] = sumB / window;
      finalOut[i + 3] = out[i + 3];
      const yOut = y + radius;
      const yIn = y - radius - 1;
      const iOut = (Math.min(height - 1, yOut) * width + x) * 4;
      const iIn = (Math.max(0, yIn) * width + x) * 4;
      sumR += out[iOut] - out[iIn];
      sumG += out[iOut + 1] - out[iIn + 1];
      sumB += out[iOut + 2] - out[iIn + 2];
    }
  }
  return new ImageData(finalOut, width, height);
}
