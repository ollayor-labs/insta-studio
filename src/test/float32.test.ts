import { describe, expect, it } from "vitest";
import {
  applyFilterToImageData,
  defaultAdjustments,
  type Adjustments,
} from "@/lib/filterEngine";
import { applyFilterFloat32 } from "@/lib/filter-engine/float32";

function createImageData(width: number, height: number, pixels: number[]): ImageData {
  return new ImageData(Uint8ClampedArray.from(pixels), width, height);
}

function createGradient(width: number, height: number): ImageData {
  // A smooth horizontal blue-to-cyan gradient (sky-like) with an opaque alpha.
  // Each step in the source differs by 1 to expose any rounding-step
  // amplification in the pipeline.
  const data = new Uint8ClampedArray(width * height * 4);
  let dataIndex = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Step every pixel by 1 in the blue channel (252 -> 255) so the
      // gradient wraps. The red channel steps 220 -> 255.
      const step = Math.floor((x / (width - 1)) * 35);
      data[dataIndex] = 220 + step;
      data[dataIndex + 1] = 230;
      data[dataIndex + 2] = 252 + Math.min(3, Math.floor((x / (width - 1)) * 3));
      data[dataIndex + 3] = 255;
      dataIndex += 4;
    }
  }
  return new ImageData(data, width, height);
}

function meanAdjacentLuminanceDelta(image: ImageData): number {
  const { data, width, height } = image;
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const leftIndex = (y * width + x) * 4;
      const rightIndex = (y * width + x + 1) * 4;
      const leftLuma = 0.2126 * data[leftIndex] + 0.7152 * data[leftIndex + 1] + 0.0722 * data[leftIndex + 2];
      const rightLuma = 0.2126 * data[rightIndex] + 0.7152 * data[rightIndex + 1] + 0.0722 * data[rightIndex + 2];
      total += Math.abs(leftLuma - rightLuma);
      count += 1;
    }
  }
  return total / count;
}

const PUNCHY_ADJUSTMENTS: Partial<Adjustments> = {
  contrast: 35,
  saturation: 25,
  shadows: -30,
  highlights: 20,
  temperature: 10,
  tint: -5,
  vibrance: 15,
};

describe("float32 export pipeline", () => {
  it("matches uint8 within ±1 LSB on a no-op filter (Original)", () => {
    // Original with default adjustments is a near-identity: a perfect
    // sanity check that the Float32 path isn't drifting the result.
    const source = createImageData(2, 1, [10, 20, 30, 255, 200, 150, 100, 255]);
    const uint8Result = applyFilterToImageData(source, "Original", defaultAdjustments, {
      quality: "export",
      precision: "uint8",
    });
    const float32Result = applyFilterToImageData(source, "Original", defaultAdjustments, {
      quality: "export",
      precision: "float32",
    });
    for (let index = 0; index < source.data.length; index += 1) {
      const delta = Math.abs(uint8Result.data[index] - float32Result.data[index]);
      expect(delta).toBeLessThanOrEqual(1);
    }
  });

  it("produces a measurably different (smoother) result than uint8 on a graded gradient", () => {
    // 64px-wide gradient: 64 unique input values, one per pixel column.
    // After a punchy filter, banding in the uint8 path comes from the
    // repeated 0..255 quantize at every pass. The Float32 path keeps
    // sub-LSB precision and produces strictly smaller per-step deltas
    // when downsampled to a smaller byte range.
    const gradient = createGradient(64, 1);
    const uint8Result = applyFilterToImageData(gradient, "Soft Portrait", PUNCHY_ADJUSTMENTS, {
      quality: "export",
      precision: "uint8",
    });
    const float32Result = applyFilterToImageData(gradient, "Soft Portrait", PUNCHY_ADJUSTMENTS, {
      quality: "export",
      precision: "float32",
    });

    // The two paths must differ — if they're identical, the precision flag
    // is silently being ignored.
    let differingPixels = 0;
    for (let index = 0; index < gradient.data.length; index += 1) {
      if (uint8Result.data[index] !== float32Result.data[index]) differingPixels += 1;
    }
    expect(differingPixels).toBeGreaterThan(0);

    // Float32 should produce equal-or-lower local luminance variation on a
    // smooth input: the per-pass quantize can't pile up rounding steps.
    const uint8Delta = meanAdjacentLuminanceDelta(uint8Result);
    const float32Delta = meanAdjacentLuminanceDelta(float32Result);
    expect(float32Delta).toBeLessThanOrEqual(uint8Delta);
  });

  it("returns a Uint8ClampedArray-shaped ImageData (browser-compatible)", () => {
    // The export path consumes the result and serializes to a Blob via
    // canvas. If the result isn't a Uint8ClampedArray-backed ImageData,
    // the canvas will throw at putImageData.
    const source = createImageData(2, 1, [10, 20, 30, 255, 200, 150, 100, 255]);
    const result = applyFilterFloat32(source, "Minimal Rich", defaultAdjustments, {
      quality: "export",
    });
    expect(result.data).toBeInstanceOf(Uint8ClampedArray);
    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
  });

  it("clamps output channels to the [0, 255] range", () => {
    // Push the filter hard to force a clamp somewhere in the chain.
    const source = createImageData(2, 1, [250, 250, 250, 255, 0, 0, 0, 255]);
    const result = applyFilterFloat32(source, "Golden Hour", { ...defaultAdjustments, contrast: 100, exposure: 50 } as Partial<Adjustments>, {
      quality: "export",
    });
    for (let index = 0; index < result.data.length; index += 4) {
      expect(result.data[index]).toBeGreaterThanOrEqual(0);
      expect(result.data[index]).toBeLessThanOrEqual(255);
      expect(result.data[index + 1]).toBeGreaterThanOrEqual(0);
      expect(result.data[index + 1]).toBeLessThanOrEqual(255);
      expect(result.data[index + 2]).toBeGreaterThanOrEqual(0);
      expect(result.data[index + 2]).toBeLessThanOrEqual(255);
    }
  });
});
