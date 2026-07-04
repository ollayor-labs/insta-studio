// Apply a crop box to an ImageData, returning a new ImageData that
// is exactly the cropped region. The output is drawn into a fresh
// buffer of the cropped dimensions; the source is never mutated.
//
// We intentionally use 2D canvas `drawImage` (not a raw
// `getImageData` / `putImageData` round-trip) so the browser's
// resampler does the work and we get correct sub-pixel
// positioning for free. The downside is one extra canvas per
// crop, but it's allocated only at export time -- not on every
// frame -- so the cost is acceptable.

import { boxToPixelRect, type CropBox } from "./types";

export interface CropResult {
  /** The cropped pixel data, sized to the crop box. */
  imageData: ImageData;
  /** Pixel-space rect that was cropped from the source. */
  rect: { x: number; y: number; width: number; height: number };
}

export function cropImageData(source: ImageData, box: CropBox): CropResult {
  const rect = boxToPixelRect(box, source.width, source.height);
  if (rect.width <= 0 || rect.height <= 0) {
    return {
      imageData: new ImageData(Math.max(1, rect.width), Math.max(1, rect.height)),
      rect: { ...rect, width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    };
  }
  // Stage the source onto a 2D canvas (one allocation per crop) so
  // we can `drawImage` with a sub-rect, which is the only way the
  // browser will resample for us.
  const stage = document.createElement("canvas");
  stage.width = source.width;
  stage.height = source.height;
  const stageCtx = stage.getContext("2d");
  if (!stageCtx) {
    throw new Error("Could not create staging canvas context for crop");
  }
  stageCtx.putImageData(source, 0, 0);

  // Output canvas sized to the crop rect. The browser's resampler
  // does the scaling if the source rect and destination size ever
  // differ (e.g. if a future caller wants to bake in a 2x scale
  // here -- for now we keep them equal).
  const output = document.createElement("canvas");
  output.width = rect.width;
  output.height = rect.height;
  const outputCtx = output.getContext("2d");
  if (!outputCtx) {
    throw new Error("Could not create output canvas context for crop");
  }
  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = "high";
  outputCtx.drawImage(
    stage,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );
  return { imageData: outputCtx.getImageData(0, 0, rect.width, rect.height), rect };
}

// Offscreen variant for export pipelines. Falls back to a regular
// canvas when OffscreenCanvas is unavailable (older Safari).
export function cropImageDataOffscreen(
  source: ImageData,
  box: CropBox,
): CropResult {
  const rect = boxToPixelRect(box, source.width, source.height);
  if (rect.width <= 0 || rect.height <= 0) {
    return {
      imageData: new ImageData(Math.max(1, rect.width), Math.max(1, rect.height)),
      rect: { ...rect, width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    };
  }
  if (typeof OffscreenCanvas === "undefined") {
    return cropImageData(source, box);
  }
  const stage = new OffscreenCanvas(source.width, source.height);
  const stageCtx = stage.getContext("2d");
  if (!stageCtx) {
    throw new Error("Could not create offscreen staging context for crop");
  }
  stageCtx.putImageData(source, 0, 0);
  const output = new OffscreenCanvas(rect.width, rect.height);
  const outputCtx = output.getContext("2d");
  if (!outputCtx) {
    throw new Error("Could not create offscreen output context for crop");
  }
  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = "high";
  outputCtx.drawImage(
    stage,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );
  return { imageData: outputCtx.getImageData(0, 0, rect.width, rect.height), rect };
}
