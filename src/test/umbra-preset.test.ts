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

describe("Umbra preset", () => {
  it("registers the Umbra preset with the exact recipe", () => {
    const umbra = FILTER_PRESETS.find((preset) => preset.id === "umbra");
    expect(umbra).toBeDefined();
    expect(umbra?.name).toBe("Umbra");
    expect(umbra?.category).toBe("Moody");
    // Full default strength so the recipe applies verbatim.
    expect(umbra?.defaultStrength).toBe(1);
    expect(umbra?.adjustments).toEqual({
      brightness: -50,
      shadows: 40,
      contrast: 5,
      saturation: -31,
      temperature: 3,
      tint: -5,
      sharpness: 14,
      clarity: 5,
    } satisfies Partial<Adjustments>);
    // The sidebar and engine resolve by id and display name.
    expect(getFilterPresetById("umbra").id).toBe("umbra");
  });

  it("applies the full recipe at its default strength", () => {
    const source = createImageData(2, 1, [
      128, 110, 96, 255,
      30, 42, 60, 255,
    ]);

    const byDefault = applyFilterToImageData(source, "Umbra", defaultAdjustments, {
      quality: "preview",
      strength: getFilterPresetById("umbra").defaultStrength * 100,
      adaptToScene: false,
    });
    const forced = applyFilterToImageData(source, "Umbra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });

    expect(Array.from(byDefault.data)).toEqual(Array.from(forced.data));
  });

  it("keeps the dark mood while lifting shadows above the raw brilliance drop", () => {
    const source = createImageData(2, 1, [
      120, 110, 100, 255, // midtone
      18, 22, 30, 255, // deep shadow
    ]);

    const umbra = applyFilterToImageData(source, "Umbra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });
    // A raw brightness -50 with no shadow recovery, for comparison.
    const rawDark = applyFilterToImageData(source, "Original", { ...defaultAdjustments, brightness: -50 }, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });

    // Shadows: +40 recovers the near-black pixel well beyond what the
    // raw brilliance drop leaves behind (which is crushed to ~0).
    expect(umbra.data[4]).toBeGreaterThan(rawDark.data[4]);
    expect(umbra.data[5]).toBeGreaterThan(rawDark.data[5]);
    expect(umbra.data[6]).toBeGreaterThan(rawDark.data[6]);

    // Midtones still land in a clearly darker place than the source:
    // the "dark mood" holds despite the shadow lift.
    expect(umbra.data[0] + umbra.data[1] + umbra.data[2]).toBeLessThan(
      source.data[0] + source.data[1] + source.data[2],
    );
  });

  it("renders consistently across the uint8 and float32 pipelines", () => {
    const pixels: number[] = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        pixels.push(20 + x * 28, 24 + x * 26, 30 + x * 24, 255);
      }
    }
    const source = createImageData(8, 4, pixels);

    const uint8 = applyFilterToImageData(source, "Umbra", defaultAdjustments, {
      quality: "preview",
      strength: 100,
      adaptToScene: false,
    });
    const float32 = applyFilterToImageData(source, "Umbra", defaultAdjustments, {
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
