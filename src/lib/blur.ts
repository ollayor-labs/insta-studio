// Pure canvas / ImageData blur utilities. No React, no external libraries.
//
// The core primitive is a fast separable box blur run three times, which
// closely approximates a true Gaussian blur while staying O(1) per pixel per
// pass thanks to a running-sum sliding window.

export type BlurOptions =
  | { type: "whole"; strength: number }
  | { type: "tilt"; strength: number; center: number; halfWidth: number; feather: number }
  | { type: "radial"; strength: number; cx: number; cy: number; inner: number; outer: number }
  | { type: "background"; strength: number; subjectMask: { data: Uint8Array; w: number; h: number } };

/** Smoothstep as defined by GLSL: 0 below edge0, 1 above edge1, cubic in-between. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Convert a Gaussian sigma (in pixels) to an equivalent box-blur radius. */
function radiusFromSigma(sigmaPx: number): number {
  return Math.max(0, Math.round(sigmaPx * Math.sqrt(3)));
}

/**
 * One horizontal box-blur pass over an RGBA buffer using a running sum.
 * `src` and `dst` must be distinct buffers of length w*h*4.
 */
function boxBlurH(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, radius: number): void {
  if (radius <= 0) {
    dst.set(src);
    return;
  }
  const window = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    // Prime the window with clamped left-edge samples.
    for (let k = -radius; k <= radius; k++) {
      const x = Math.min(w - 1, Math.max(0, k));
      const i = row + x * 4;
      sumR += src[i];
      sumG += src[i + 1];
      sumB += src[i + 2];
      sumA += src[i + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      dst[o] = sumR / window;
      dst[o + 1] = sumG / window;
      dst[o + 2] = sumB / window;
      dst[o + 3] = sumA / window;
      // Slide the window: add the incoming pixel, drop the outgoing one.
      const addX = Math.min(w - 1, x + radius + 1);
      const remX = Math.max(0, x - radius);
      const ai = row + addX * 4;
      const ri = row + remX * 4;
      sumR += src[ai] - src[ri];
      sumG += src[ai + 1] - src[ri + 1];
      sumB += src[ai + 2] - src[ri + 2];
      sumA += src[ai + 3] - src[ri + 3];
    }
  }
}

/**
 * One vertical box-blur pass over an RGBA buffer using a running sum.
 */
function boxBlurV(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, radius: number): void {
  if (radius <= 0) {
    dst.set(src);
    return;
  }
  const window = radius * 2 + 1;
  const stride = w * 4;
  for (let x = 0; x < w; x++) {
    const col = x * 4;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = Math.min(h - 1, Math.max(0, k));
      const i = y * stride + col;
      sumR += src[i];
      sumG += src[i + 1];
      sumB += src[i + 2];
      sumA += src[i + 3];
    }
    for (let y = 0; y < h; y++) {
      const o = y * stride + col;
      dst[o] = sumR / window;
      dst[o + 1] = sumG / window;
      dst[o + 2] = sumB / window;
      dst[o + 3] = sumA / window;
      const addY = Math.min(h - 1, y + radius + 1);
      const remY = Math.max(0, y - radius);
      const ai = addY * stride + col;
      const ri = remY * stride + col;
      sumR += src[ai] - src[ri];
      sumG += src[ai + 1] - src[ri + 1];
      sumB += src[ai + 2] - src[ri + 2];
      sumA += src[ai + 3] - src[ri + 3];
    }
  }
}

/**
 * Blur an ImageData in place-ish (returns a new ImageData) using three
 * box-blur passes (≈ Gaussian). All four RGBA channels are blurred together.
 */
function gaussianBlurImageData(image: ImageData, sigmaPx: number): ImageData {
  const { width: w, height: h } = image;
  const radius = radiusFromSigma(sigmaPx);
  if (radius <= 0 || w === 0 || h === 0) {
    return new ImageData(new Uint8ClampedArray(image.data), w, h);
  }
  const a = new Uint8ClampedArray(image.data);
  const b = new Uint8ClampedArray(a.length);
  // Three passes of separable box blur (H then V each) ≈ Gaussian.
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, b, w, h, radius);
    boxBlurV(b, a, w, h, radius);
  }
  return new ImageData(a, w, h);
}

/** Create a 2D canvas of the given size with a non-null context. */
function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("blur: unable to acquire 2D canvas context");
  return { canvas, ctx };
}

/**
 * Blur an arbitrary image source into a fresh canvas of the requested size.
 */
export function gaussianBlurCanvas(
  source: CanvasImageSource,
  w: number,
  h: number,
  sigmaPx: number,
): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (sigmaPx > 0) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const blurred = gaussianBlurImageData(image, sigmaPx);
    ctx.putImageData(blurred, 0, 0);
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Analytic masks. Each returns a value in 0..1 where 1 = fully blurred.
// Coordinates are normalized (0..1). `aspect` = w / h for aspect-correct dist.
// ---------------------------------------------------------------------------

/** Tilt-shift: a sharp horizontal band centered at `center` (y, 0..1). */
export function tiltMask(
  y: number,
  params: { center: number; halfWidth: number; feather: number },
): number {
  const d = Math.abs(y - params.center);
  return smoothstep(params.halfWidth, params.halfWidth + Math.max(1e-4, params.feather), d);
}

/** Radial: sharp center, blur ramps up between `inner` and `outer` radius. */
export function radialMask(
  x: number,
  y: number,
  aspect: number,
  params: { cx: number; cy: number; inner: number; outer: number },
): number {
  const dx = (x - params.cx) * aspect;
  const dy = y - params.cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return smoothstep(params.inner, Math.max(params.inner + 1e-4, params.outer), dist);
}

/** Map strength (0..100) to a max sigma scaled by image size. */
function sigmaFromStrength(strength: number, w: number, h: number): number {
  const clamped = Math.min(100, Math.max(0, strength));
  return (clamped / 100) * (Math.min(w, h) / 25);
}

/**
 * Build a per-pixel mask (Float32, length w*h, values 0..1) for the given
 * blur options. 1 = fully blurred, 0 = fully sharp.
 */
function buildMask(options: BlurOptions, w: number, h: number): Float32Array {
  const mask = new Float32Array(w * h);
  const aspect = w / h;

  if (options.type === "whole") {
    mask.fill(1);
    return mask;
  }

  if (options.type === "tilt") {
    for (let y = 0; y < h; y++) {
      const ny = (y + 0.5) / h;
      const v = tiltMask(ny, options);
      const row = y * w;
      for (let x = 0; x < w; x++) mask[row + x] = v;
    }
    return mask;
  }

  if (options.type === "radial") {
    for (let y = 0; y < h; y++) {
      const ny = (y + 0.5) / h;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const nx = (x + 0.5) / w;
        mask[row + x] = radialMask(nx, ny, aspect, options);
      }
    }
    return mask;
  }

  // background: blur everything except the subject. Subject mask 255 = subject.
  const sub = options.subjectMask;
  const sw = sub.w;
  const sh = sub.h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / h) * sh));
    const row = y * w;
    const srow = sy * sw;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / w) * sw));
      const subjectVal = sub.data[srow + sx] / 255; // 1 = subject
      mask[row + x] = 1 - subjectVal; // subject stays sharp, background blurs
    }
  }
  // Feather the subject-mask edge a little with a small blur over the mask.
  featherMask(mask, w, h, Math.max(1, Math.round(Math.min(w, h) / 200)));
  return mask;
}

/** Small separable box blur over a single-channel Float mask, in place. */
function featherMask(mask: Float32Array, w: number, h: number, radius: number): void {
  if (radius <= 0) return;
  const window = radius * 2 + 1;
  const tmp = new Float32Array(w * h);
  // Horizontal.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += mask[row + Math.min(w - 1, Math.max(0, k))];
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / window;
      const add = row + Math.min(w - 1, x + radius + 1);
      const rem = row + Math.max(0, x - radius);
      sum += mask[add] - mask[rem];
    }
  }
  // Vertical.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    }
    for (let y = 0; y < h; y++) {
      mask[y * w + x] = sum / window;
      const add = Math.min(h - 1, y + radius + 1) * w + x;
      const rem = Math.max(0, y - radius) * w + x;
      sum += tmp[add] - tmp[rem];
    }
  }
}

/**
 * Apply a baked blur to `source`, producing a new canvas of size w×h.
 *
 * A fully-blurred copy is computed once, then blended against the sharp
 * original per pixel using the analytic / subject mask.
 */
export function applyBlur(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  w: number,
  h: number,
  options: BlurOptions,
): HTMLCanvasElement {
  const sigma = sigmaFromStrength(options.strength, w, h);

  // Sharp copy.
  const { canvas: out, ctx } = makeCanvas(w, h);
  ctx.drawImage(source, 0, 0, out.width, out.height);
  const sharp = ctx.getImageData(0, 0, out.width, out.height);

  if (sigma <= 0) {
    return out; // nothing to blur
  }

  // Fully-blurred copy.
  const blurredCanvas = gaussianBlurCanvas(source, out.width, out.height, sigma);
  const blurCtx = blurredCanvas.getContext("2d");
  if (!blurCtx) throw new Error("blur: unable to read blurred canvas");
  const blurred = blurCtx.getImageData(0, 0, out.width, out.height);

  // whole → just return the blurred copy directly.
  if (options.type === "whole") {
    ctx.putImageData(blurred, 0, 0);
    return out;
  }

  const mask = buildMask(options, out.width, out.height);
  const sd = sharp.data;
  const bd = blurred.data;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const m = mask[i];
    const inv = 1 - m;
    sd[p] = sd[p] * inv + bd[p] * m;
    sd[p + 1] = sd[p + 1] * inv + bd[p + 1] * m;
    sd[p + 2] = sd[p + 2] * inv + bd[p + 2] * m;
    sd[p + 3] = sd[p + 3] * inv + bd[p + 3] * m;
  }
  ctx.putImageData(sharp, 0, 0);
  return out;
}

/** Round-trip a canvas through a data URL into a decoded HTMLImageElement. */
export function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("blur: failed to decode canvas image"));
    img.src = canvas.toDataURL("image/png");
  });
}
