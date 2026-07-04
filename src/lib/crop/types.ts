// Crop engine types and pure helpers. The crop state lives in
// `CropState` (in normalized 0..1 image coordinates) and is derived
// from the displayed crop box. The active ratio is computed from
// the box's width/height ratio -- the buttons in the UI just read
// the derived value and highlight themselves. The canvas drives the
// state; the buttons only mirror it (the "Source of Truth" pattern).

export type CropRatio =
  | "free"
  | "1:1"
  | "4:5"
  | "3:4"
  | "9:16"
  | "16:9"
  | "3:2"
  | "2:3";

export interface CropRatioSpec {
  id: CropRatio;
  label: string;
  /** Width/height ratio, e.g. 1 for square, 4/5 for portrait. */
  ratio: number | null;
  description: string;
}

export const CROP_RATIOS: CropRatioSpec[] = [
  { id: "free", label: "Free", ratio: null, description: "Drag any rectangle" },
  { id: "1:1", label: "1:1", ratio: 1, description: "Square" },
  { id: "4:5", label: "4:5", ratio: 4 / 5, description: "Instagram feed" },
  { id: "3:4", label: "3:4", ratio: 3 / 4, description: "Portrait" },
  { id: "9:16", label: "9:16", ratio: 9 / 16, description: "Story / Reel" },
  { id: "16:9", label: "16:9", ratio: 16 / 9, description: "Wide" },
  { id: "3:2", label: "3:2", ratio: 3 / 2, description: "DSLR" },
  { id: "2:3", label: "2:3", ratio: 2 / 3, description: "Classic print" },
];

// A crop box in normalized image coordinates (0..1).
// `x`, `y` are the top-left corner; `w`, `h` are the size. All four
// values are clamped to [0, 1] and `x + w <= 1`, `y + h <= 1`.
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Crop state owns the box and the currently-locked ratio. The
// active ratio is *not* the source of truth -- the box is. The
// ratio is just a hint that locks the box's aspect on the next
// resize/move.
export interface CropState {
  box: CropBox;
  ratio: CropRatio;
}

export const DEFAULT_CROP_BOX: CropBox = { x: 0, y: 0, w: 1, h: 1 };
export const DEFAULT_CROP_STATE: CropState = { box: DEFAULT_CROP_BOX, ratio: "free" };

// Compute the active ratio id from a box's width/height. Returns
// "free" when the box doesn't match any preset within the tolerance.
// This is the function the UI reads to highlight buttons.
export function detectActiveRatio(box: CropBox, tolerance = 0.02): CropRatio {
  if (box.w <= 0 || box.h <= 0) return "free";
  const measured = box.w / box.h;
  let bestMatch: CropRatio = "free";
  let bestDelta = Infinity;
  for (const spec of CROP_RATIOS) {
    if (spec.ratio === null) continue;
    const delta = Math.abs(measured - spec.ratio) / spec.ratio;
    if (delta <= tolerance && delta < bestDelta) {
      bestDelta = delta;
      bestMatch = spec.id;
    }
  }
  return bestMatch;
}

// Clamp a box to the [0, 1] image bounds and ensure positive area.
export function clampBox(box: CropBox): CropBox {
  const w = Math.max(0.001, Math.min(1, box.w));
  const h = Math.max(0.001, Math.min(1, box.h));
  const x = Math.max(0, Math.min(1 - w, box.x));
  const y = Math.max(0, Math.min(1 - h, box.y));
  return { x, y, w, h };
}

// Resize a box to a target ratio, anchored at the given pivot point
// (`0..1` within the box; 0.5, 0.5 = center). Used when the user
// changes the ratio selector and the box needs to snap.
export function resizeBoxToRatio(
  box: CropBox,
  ratio: number | null,
  pivotX = 0.5,
  pivotY = 0.5,
): CropBox {
  if (ratio === null || ratio <= 0) return clampBox(box);
  const current = box.w / box.h;
  if (Math.abs(current - ratio) / ratio < 0.001) return clampBox(box);
  let nextW: number;
  let nextH: number;
  if (current > ratio) {
    nextH = box.h;
    nextW = box.h * ratio;
  } else {
    nextW = box.w;
    nextH = box.w / ratio;
  }
  if (nextW > 1) {
    nextW = 1;
    nextH = 1 / ratio;
  }
  if (nextH > 1) {
    nextH = 1;
    nextW = ratio;
  }
  const anchorX = box.x + box.w * pivotX;
  const anchorY = box.y + box.h * pivotY;
  const nextX = Math.max(0, Math.min(1 - nextW, anchorX - nextW * pivotX));
  const nextY = Math.max(0, Math.min(1 - nextH, anchorY - nextH * pivotY));
  return clampBox({ x: nextX, y: nextY, w: nextW, h: nextH });
}

// Project a box to pixel coordinates on a specific image size.
export function boxToPixelRect(
  box: CropBox,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(box.x * imageWidth),
    y: Math.round(box.y * imageHeight),
    width: Math.round(box.w * imageWidth),
    height: Math.round(box.h * imageHeight),
  };
}

// Human-readable ratio label (e.g. "4:5" or "Freeform").
export function formatRatioLabel(ratio: CropRatio): string {
  if (ratio === "free") return "Freeform";
  return `Locked: ${ratio}`;
}
