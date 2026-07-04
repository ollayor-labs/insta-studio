import { describe, expect, it } from "vitest";
import {
  clampBox,
  CROP_RATIOS,
  DEFAULT_CROP_BOX,
  DEFAULT_CROP_STATE,
  detectActiveRatio,
  formatRatioLabel,
  resizeBoxToRatio,
} from "@/lib/crop";

describe("crop / detectActiveRatio", () => {
  it("returns 'free' for an off-grid box", () => {
    expect(detectActiveRatio({ x: 0, y: 0, w: 0.7, h: 0.45 })).toBe("free");
  });

  it("snaps a square box to 1:1", () => {
    expect(detectActiveRatio({ x: 0, y: 0, w: 0.5, h: 0.5 })).toBe("1:1");
  });

  it("snaps a 4:5 box to 4:5", () => {
    expect(detectActiveRatio({ x: 0.1, y: 0.1, w: 0.4, h: 0.5 })).toBe("4:5");
  });

  it("respects the tolerance window", () => {
    expect(detectActiveRatio({ x: 0, y: 0, w: 0.4, h: 0.5 })).toBe("4:5");
    expect(detectActiveRatio({ x: 0, y: 0, w: 0.41, h: 0.5 }, 0.05)).toBe("4:5");
  });

  it("returns the closest preset when the box is off-grid", () => {
    expect(detectActiveRatio({ x: 0, y: 0, w: 0.5, h: 0.6 }, 0.05)).toBe("4:5");
  });
});

describe("crop / clampBox", () => {
  it("keeps a valid box untouched", () => {
    expect(clampBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: 0.4,
    });
  });

  it("clamps negative origins and oversize widths", () => {
    expect(clampBox({ x: -0.1, y: -0.1, w: 1.2, h: 1.2 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it("forces a minimum positive area", () => {
    expect(clampBox({ x: 0, y: 0, w: 0, h: 0 })).toEqual({
      x: 0,
      y: 0,
      w: 0.001,
      h: 0.001,
    });
  });

  it("clamps the box to the image bounds when it overflows", () => {
    expect(clampBox({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 })).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
  });
});

describe("crop / resizeBoxToRatio", () => {
  it("is a no-op when the box is already at the target ratio", () => {
    const box = { x: 0, y: 0, w: 0.4, h: 0.5 };
    expect(resizeBoxToRatio(box, 4 / 5)).toEqual(box);
  });

  it("snaps a 1:1 (1.0x1.0) box to 4:5 anchored at the center", () => {
    // 1:1 -> 4:5 means the box gets narrower. The taller axis (h)
    // stays 1.0 and the width becomes 0.8.
    const result = resizeBoxToRatio({ x: 0, y: 0, w: 1, h: 1 }, 4 / 5);
    expect(result.w).toBeCloseTo(0.8, 5);
    expect(result.h).toBeCloseTo(1, 5);
    expect(result.x + result.w / 2).toBeCloseTo(0.5, 5);
    expect(result.y + result.h / 2).toBeCloseTo(0.5, 5);
  });

  it("returns the clamped box when ratio is null (freeform)", () => {
    const box = { x: -0.5, y: 0, w: 1, h: 0.5 };
    expect(resizeBoxToRatio(box, null)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it("clamps to image bounds when the new ratio can't fit", () => {
    // 9:16 is taller than 1.0; only feasible at h=1.0 w=0.5625.
    const result = resizeBoxToRatio({ x: 0, y: 0, w: 1, h: 1 }, 9 / 16);
    expect(result.h).toBe(1);
    expect(result.w).toBeCloseTo(9 / 16, 5);
  });
});

describe("crop / constants", () => {
  it("exposes the expected ratio specs", () => {
    const ids = CROP_RATIOS.map((entry) => entry.id);
    expect(ids).toContain("free");
    expect(ids).toContain("1:1");
    expect(ids).toContain("4:5");
    expect(ids).toContain("9:16");
  });

  it("exports a default state that is the full image at 'free'", () => {
    expect(DEFAULT_CROP_STATE).toEqual({ box: DEFAULT_CROP_BOX, ratio: "free" });
  });
});

describe("crop / formatRatioLabel", () => {
  it("labels freeform boxes", () => {
    expect(formatRatioLabel("free")).toBe("Freeform");
  });
  it("labels locked boxes", () => {
    expect(formatRatioLabel("4:5")).toBe("Locked: 4:5");
  });
});
