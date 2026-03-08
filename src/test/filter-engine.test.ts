import { describe, expect, it } from "vitest";
import {
  analyzeImageData,
  applyFilter,
  defaultAdjustments,
  recommendPresets,
} from "@/lib/filterEngine";

function createImageData(width: number, height: number, pixels: number[]): ImageData {
  return new ImageData(Uint8ClampedArray.from(pixels), width, height);
}

function averageChannelDelta(left: ImageData, right: ImageData): number {
  let total = 0;
  for (let index = 0; index < left.data.length; index += 1) {
    total += Math.abs(left.data[index] - right.data[index]);
  }
  return total / left.data.length;
}

describe("filter engine", () => {
  it("keeps the image unchanged when preset strength is zero", () => {
    const source = createImageData(2, 1, [
      120, 110, 100, 255,
      210, 180, 150, 255,
    ]);

    const result = applyFilter(source, "Minimal Rich", defaultAdjustments, source.width, source.height, {
      strength: 0,
      adaptToScene: false,
    });

    expect(Array.from(result.data)).toEqual(Array.from(source.data));
  });

  it("scales preset impact with strength", () => {
    const source = createImageData(2, 1, [
      102, 96, 90, 255,
      170, 150, 132, 255,
    ]);

    const subtle = applyFilter(source, "Golden Hour", defaultAdjustments, source.width, source.height, {
      strength: 25,
      adaptToScene: false,
    });
    const strong = applyFilter(source, "Golden Hour", defaultAdjustments, source.width, source.height, {
      strength: 90,
      adaptToScene: false,
    });

    expect(averageChannelDelta(strong, source)).toBeGreaterThan(averageChannelDelta(subtle, source));
  });

  it("detects portrait-heavy warm imagery and recommends portrait-friendly presets", () => {
    const source = createImageData(4, 2, [
      212, 162, 132, 255,
      204, 152, 120, 255,
      218, 170, 138, 255,
      210, 160, 128, 255,
      232, 190, 150, 255,
      226, 180, 142, 255,
      235, 192, 156, 255,
      228, 184, 146, 255,
    ]);

    const analysis = analyzeImageData(source);
    const recommendations = recommendPresets(analysis, 2);

    expect(analysis.portraitLikelihood).toBeGreaterThan(0.5);
    expect(recommendations[0]?.presetId).toBe("soft-portrait");
  });

  it("renders premium monochrome without color channel divergence", () => {
    const source = createImageData(2, 1, [
      140, 80, 60, 255,
      60, 120, 180, 255,
    ]);

    const result = applyFilter(source, "Monochrome Premium", defaultAdjustments, source.width, source.height, {
      strength: 100,
      adaptToScene: false,
    });

    expect(result.data[0]).toBe(result.data[1]);
    expect(result.data[1]).toBe(result.data[2]);
    expect(result.data[4]).toBe(result.data[5]);
    expect(result.data[5]).toBe(result.data[6]);
  });
});
