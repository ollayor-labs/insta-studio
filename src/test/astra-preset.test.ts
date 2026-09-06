import { describe, expect, it } from "vitest";
import {
  applyFilterToImageData,
  defaultAdjustments,
  FILTER_PRESETS,
  getFilterPresetById,
  type Adjustments,
} from "@/lib/filterEngine";

function createImageData(width: number, height: number, pixels: number[]): ImageData {
  return new ImageData(Uint8ClampedArray.from(pixels), width, height);
}

describe("Astra preset", () => {
  it("registers the Astra preset with the exact recipe", () => {
    const astra = FILTER_PRESETS.find((preset) => preset.id === "astra");
    expect(astra).toBeDefined();
    expect(astra?.name).toBe("Astra");
    expect(astra?.category).toBe("Glow");
    // Full default strength so the recipe applies verbatim.
    expect(astra?.defaultStrength).toBe(1);
    // Exposure -5, Brilliance -15, and Brightness -5 share the engine's
    // single brightness slider, so they land merged at -25.
    expect(astra?.adjustments).toEqual({
      brightness: -25,
      highlights: -30,
      contrast: 15,
      vibrance: 15,
      temperature: -5,
      tint: 5,
      sharpness: 35,
      clarity: 10,
    } satisfies Partial<Adjustments>);
    // The sidebar and engine resolve by id and display name.
    expect(getFilterPresetById("astra").id).toBe("astra");
  });

  it("applies the full recipe at its default strength", () => {
    const source = createImageData(2, 1, [
      140, 150, 165, 255,
      220, 210, 195, 255,
    ]);

    const byDefault = applyFilterToImageData(source, "Astra", defaultAdjustments, {
      quality: "preview",
      strength: getFilterPresetById("astra").defaultStrength * 100,
      adaptToScene: false,
    });
    const forced = applyFilterToImageData(source, "Astra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });

    expect(Array.from(byDefault.data)).toEqual(Array.from(forced.data));
  });

  it("builds the glow from sharpness and definition without blowing the frame out", () => {
    // 4x1 with a single luminance step between pixels 2 and 3.
    const source = createImageData(4, 1, [
      70, 75, 82, 255,
      70, 75, 82, 255,
      185, 190, 198, 255,
      185, 190, 198, 255,
    ]);

    const full = applyFilterToImageData(source, "Astra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });
    // Manual adjustments are additive on top of the preset, so -35/-10
    // exactly cancels Astra's sharpness/clarity and isolates the detail
    // pass. Everything else (tonal, color, curve) stays identical.
    const noDetail = applyFilterToImageData(source, "Astra", { ...defaultAdjustments, sharpness: -35, clarity: -10 }, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });

    // Edge contrast across the step: full Astra must exceed the
    // detail-cancelled variant — that local micro-contrast *is* the glow.
    const fullEdge = full.data[8] - full.data[4];
    const noDetailEdge = noDetail.data[8] - noDetail.data[4];
    expect(noDetailEdge).toBeGreaterThan(0);
    expect(fullEdge).toBeGreaterThan(noDetailEdge);

    // The merged exposure drop still sets a slightly dark base: total
    // luminance must land below the source despite the glow.
    let outputSum = 0;
    let sourceSum = 0;
    for (let index = 0; index < full.data.length; index += 1) {
      outputSum += full.data[index];
      sourceSum += source.data[index];
    }
    expect(outputSum).toBeLessThan(sourceSum);

    // Highlights: -30 must hold the bright side of the step below the
    // raw 8-bit ceiling so glow never means clipping.
    for (let pixel = 2; pixel < 4; pixel += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(full.data[pixel * 4 + channel]).toBeLessThan(255);
      }
    }
  });

  it("renders consistently across the uint8 and float32 pipelines", () => {
    const pixels: number[] = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        pixels.push(30 + x * 28, 36 + x * 26, 44 + x * 24, 255);
      }
    }
    const source = createImageData(8, 4, pixels);

    const uint8 = applyFilterToImageData(source, "Astra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });
    const float32 = applyFilterToImageData(source, "Astra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
      precision: "float32",
    });

    let total = 0;
    for (let index = 0; index < uint8.data.length; index += 1) {
      total += Math.abs(uint8.data[index] - float32.data[index]);
    }
    const averageDelta = total / uint8.data.length;
    expect(averageDelta).toBeLessThan(12);
  });
});
