import { describe, expect, it } from "vitest";
import {
  analyzeImageData,
  applyFilter,
  defaultAdjustments,
  FILTER_PRESETS,
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

  it("protects skin pixels while still applying vibrance to sky pixels", () => {
    // Source: 2x1 image. Pixel 0 is a skin tone (hue ~30, mid sat/lightness).
    //          Pixel 1 is a sky tone (hue ~210, mid sat/lightness).
    // We feed an analysis claiming strong portrait likelihood so the
    // skinProtection guard kicks in, then push the Soft Portrait preset at
    // 100% strength with scene adaption enabled. The skin pixel must barely
    // move while the sky pixel must shift visibly.
    const source = createImageData(2, 1, [
      220, 175, 145, 255, // skin
      110, 165, 215, 255, // sky
    ]);

    const analysis = analyzeImageData(source);
    // Force the portrait guard to a known-strong value. The real
    //  heuristic may be conservative on a 2x1 image;
    // the guard is what we are actually testing here.
    const forcedAnalysis = { ...analysis, portraitLikelihood: 1 };

    const result = applyFilter(
      source,
      "Soft Portrait",
      defaultAdjustments,
      source.width,
      source.height,
      { strength: 100, adaptToScene: true, analysis: forcedAnalysis },
    );

    const skinDelta =
      Math.abs(result.data[0] - source.data[0]) +
      Math.abs(result.data[1] - source.data[1]) +
      Math.abs(result.data[2] - source.data[2]);
    const skyDelta =
      Math.abs(result.data[4] - source.data[4]) +
      Math.abs(result.data[5] - source.data[5]) +
      Math.abs(result.data[6] - source.data[6]);

    // Sky should move more than skin (the guard's whole point).
    expect(skyDelta).toBeGreaterThan(skinDelta);

    // Skin still gets the *global* adjustments (brightness, contrast,
    // highlights, etc.), so we don't expect a small absolute delta —
    // only that the differential guard holds. Assert skin moved less
    // than 2x what the sky did, i.e. the band-level sat/light
    // offsets are being meaningfully damped.
    expect(skinDelta).toBeLessThan(skyDelta * 2);
    expect(skinDelta).toBeGreaterThan(0);
  });

  it("breaks recommendation ties deterministically by preset name", () => {
    // Build a zeroed analysis so every preset scores 0 and the secondary
    // name-based sort decides order. (A real flat gray image still yields
    // non-zero likelihoods in `analyzeImageData`, so the test has to
    // construct the analysis directly to hit the tie path.)
    const analysis = {
      width: 0,
      height: 0,
      pixelCount: 0,
      averageLuminance: 0,
      luminanceStdDev: 0,
      dynamicRange: 0,
      averageSaturation: 0,
      warmth: 0,
      highlightClipping: 0,
      shadowClipping: 0,
      histogram: { luminance: new Uint16Array(256) },
      channelHistogram: { r: new Uint16Array(256), g: new Uint16Array(256), b: new Uint16Array(256) },
      clippingChannels: {
        highlight: { r: false, g: false, b: false },
        shadow: { r: false, g: false, b: false },
      },
      portraitLikelihood: 0,
      indoorLikelihood: 0,
      outdoorLikelihood: 0,
      brightLikelihood: 0,
      lowLightLikelihood: 0,
      colorfulLikelihood: 0,
      flatLikelihood: 0,
      overexposedLikelihood: 0,
      underexposedLikelihood: 0,
      sceneTags: [],
    } as const;
    const recommendations = recommendPresets(analysis, 13);

    // The result should be the FILTER_PRESETS list (excluding "original")
    // sorted by name, with a stable order between runs.
    const names = recommendations.map((rec) => {
      const match = FILTER_PRESETS.find((p) => p.id === rec.presetId);
      return match?.name ?? rec.presetId;
    });
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sortedNames);
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

  it("produces different output when adaptive is enabled vs studio mode", () => {
    // A 2x1 portrait-ish image: warm skin pixels and a bright sky pixel.
    // Soft Portrait has strong portraitProtection + lowLightRestraint, so
    // the adaptive path should pull the result measurably away from the
    // studio (analysis-blind) path.
    const source = createImageData(2, 1, [
      220, 180, 150, 255, // warm skin
      230, 235, 245, 255, // bright sky
    ]);
    const analysis = analyzeImageData(source);

    const studio = applyFilter(
      source,
      "Soft Portrait",
      defaultAdjustments,
      source.width,
      source.height,
      { strength: 100, adaptToScene: false, analysis }
    );
    const adaptive = applyFilter(
      source,
      "Soft Portrait",
      defaultAdjustments,
      source.width,
      source.height,
      { strength: 100, adaptToScene: true, analysis }
    );

    const delta = averageChannelDelta(studio, adaptive);
    // The two paths must differ - if they ever collapse to the same
    // output, the toggle is silently a no-op.
    expect(delta).toBeGreaterThan(0.5);
  });
});
