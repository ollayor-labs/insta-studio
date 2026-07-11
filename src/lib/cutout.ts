// Pure canvas compositing helpers for the Cutout tool. No React.

export type CutoutBackground =
  | { kind: "transparent" }
  | { kind: "color"; color: string };

type CutoutSource = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

function sourceSize(source: CutoutSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
    };
  }
  return { width: source.width, height: source.height };
}

/**
 * Upscale a single-channel mask (maskW x maskH, 0..255) to the target size by
 * painting it into a small canvas and letting drawImage do the (bilinear)
 * scaling. Returns the resampled alpha as a Uint8ClampedArray of length w*h.
 */
function scaleMaskToSize(
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  // Paint mask into a grayscale RGBA buffer.
  const small = document.createElement("canvas");
  small.width = maskW;
  small.height = maskH;
  const sctx = small.getContext("2d")!;
  const smallData = sctx.createImageData(maskW, maskH);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    const o = i * 4;
    smallData.data[o] = v;
    smallData.data[o + 1] = v;
    smallData.data[o + 2] = v;
    smallData.data[o + 3] = 255;
  }
  sctx.putImageData(smallData, 0, 0);

  // Scale up with smoothing for softer edges.
  const big = document.createElement("canvas");
  big.width = width;
  big.height = height;
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, width, height);

  const bigData = bctx.getImageData(0, 0, width, height).data;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) out[i] = bigData[i * 4]; // red channel
  return out;
}

/**
 * Lightly feather (blur) a single-channel alpha map in place-ish so cutout
 * edges aren't harsh. A cheap separable box blur with a 1px radius.
 */
function featherAlpha(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const radius = 1;
  const tmp = new Uint8ClampedArray(alpha.length);
  const out = new Uint8ClampedArray(alpha.length);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        sum += alpha[row + nx];
        count++;
      }
      tmp[row + x] = sum / count;
    }
  }
  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        sum += tmp[ny * width + x];
        count++;
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * Apply the mask to the source image's alpha, optionally over a background.
 * Returns a NEW source-sized HTMLCanvasElement.
 */
export function compositeCutout(
  source: CutoutSource,
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  background: CutoutBackground,
): HTMLCanvasElement {
  const { width, height } = sourceSize(source);

  // Draw source at native size.
  const cutout = document.createElement("canvas");
  cutout.width = width;
  cutout.height = height;
  const ctx = cutout.getContext("2d")!;
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);

  // Resample + feather the mask to source size.
  const scaled = scaleMaskToSize(mask, maskW, maskH, width, height);
  const alpha = featherAlpha(scaled, width, height);

  // Multiply source alpha by the mask (respect any existing transparency).
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < alpha.length; i++) {
    const existing = data[i * 4 + 3];
    data[i * 4 + 3] = (existing * alpha[i]) / 255;
  }
  ctx.putImageData(imageData, 0, 0);

  if (background.kind === "color") {
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const octx = out.getContext("2d")!;
    octx.fillStyle = background.color;
    octx.fillRect(0, 0, width, height);
    octx.drawImage(cutout, 0, 0);
    return out;
  }

  return cutout;
}

/**
 * Convert a canvas to an HTMLImageElement (awaitable) so it can replace the
 * editor's source image.
 */
export function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const dataUrl = canvas.toDataURL("image/png");
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load composited image."));
    img.src = dataUrl;
  });
}
