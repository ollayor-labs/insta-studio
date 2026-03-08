import { analyzeImageData } from "./analysis";
import { getFilterPreset } from "./presets";
import type {
  Adjustments,
  FilterPresetDefinition,
  HslBandAdjustment,
  ImageAnalysis,
  RenderOptions,
  ResolvedFilterSettings,
  SplitToneSettings,
  ToneCurve,
} from "./types";
import {
  addAdjustments,
  boxBlurGray,
  buildCurveLut,
  clamp,
  clamp01,
  clampAdjustment,
  hashNoise,
  hslToRgb,
  hueDistance,
  lerp,
  luminance,
  mixToward,
  rgbToHsl,
  scaleAdjustments,
  scaleCurve,
  smoothstep,
} from "./utils";
import { defaultAdjustments } from "./types";

interface CurveLuts {
  master: Uint8Array | null;
  r: Uint8Array | null;
  g: Uint8Array | null;
  b: Uint8Array | null;
}

function scaleSplitTone(splitTone: SplitToneSettings | undefined, amount: number): SplitToneSettings | undefined {
  if (!splitTone) return undefined;

  return {
    balance: splitTone.balance * amount,
    shadows: {
      hue: splitTone.shadows.hue,
      saturation: splitTone.shadows.saturation * amount,
    },
    highlights: {
      hue: splitTone.highlights.hue,
      saturation: splitTone.highlights.saturation * amount,
    },
  };
}

function scaleHslBands(bands: HslBandAdjustment[] | undefined, amount: number): HslBandAdjustment[] {
  return (bands ?? []).map((band) => ({
    ...band,
    hueShift: band.hueShift * amount,
    saturation: band.saturation * amount,
    lightness: band.lightness * amount,
  }));
}

function applySceneAdaptation(
  adjustments: Adjustments,
  preset: FilterPresetDefinition,
  analysis: ImageAnalysis | null,
): Adjustments {
  if (!analysis) return adjustments;

  const adaptive = {
    portraitProtection: 0.72,
    saturationGuard: 0.68,
    highlightRecovery: 0.7,
    shadowSafety: 0.64,
    lowLightRestraint: 0.68,
    indoorCorrection: 0.55,
    outdoorModeration: 0.5,
    ...preset.adaptive,
  };

  const result = { ...adjustments };

  const portraitGuard = analysis.portraitLikelihood * adaptive.portraitProtection;
  const colorGuard = analysis.colorfulLikelihood * adaptive.saturationGuard;
  const overexposedGuard = analysis.overexposedLikelihood * adaptive.highlightRecovery;
  const underexposedGuard = analysis.underexposedLikelihood * adaptive.shadowSafety;
  const lowLightGuard = analysis.lowLightLikelihood * adaptive.lowLightRestraint;
  const indoorGuard = analysis.indoorLikelihood * adaptive.indoorCorrection;
  const outdoorGuard = analysis.outdoorLikelihood * adaptive.outdoorModeration;

  result.saturation = clampAdjustment(
    "saturation",
    result.saturation - colorGuard * 12 - portraitGuard * 5,
  );
  result.vibrance = clampAdjustment(
    "vibrance",
    result.vibrance - colorGuard * 10 - portraitGuard * 6,
  );
  result.temperature = clampAdjustment(
    "temperature",
    result.temperature - outdoorGuard * Math.max(0, result.temperature) * 0.3 - indoorGuard * Math.min(0, result.temperature) * 0.3,
  );
  result.tint = clampAdjustment(
    "tint",
    result.tint - portraitGuard * result.tint * 0.15 + indoorGuard * 2,
  );
  result.highlights = clampAdjustment(
    "highlights",
    result.highlights - overexposedGuard * 14,
  );
  result.whites = clampAdjustment("whites", result.whites - overexposedGuard * 10);
  result.brightness = clampAdjustment(
    "brightness",
    result.brightness - overexposedGuard * 6 + underexposedGuard * 4,
  );
  result.shadows = clampAdjustment("shadows", result.shadows + underexposedGuard * 12);
  result.blacks = clampAdjustment("blacks", result.blacks + underexposedGuard * 8);
  result.clarity = clampAdjustment("clarity", result.clarity - lowLightGuard * 10 - portraitGuard * 6);
  result.sharpness = clampAdjustment("sharpness", result.sharpness - lowLightGuard * 8 - portraitGuard * 5);
  result.grain = clampAdjustment("grain", result.grain - lowLightGuard * 6);
  result.bloom = clampAdjustment(
    "bloom",
    result.bloom + analysis.brightLikelihood * 4 - lowLightGuard * 4,
  );

  if (analysis.flatLikelihood > 0.48) {
    result.contrast = clampAdjustment("contrast", result.contrast + 4);
    result.clarity = clampAdjustment("clarity", result.clarity + 3);
  }

  return result;
}

function resolveFilterSettings(
  filterName: string,
  manualAdjustments: Partial<Adjustments>,
  options: RenderOptions,
  fallbackAnalysis?: ImageAnalysis,
): ResolvedFilterSettings {
  const preset = getFilterPreset(filterName);
  const strength = clamp01((options.strength ?? preset.defaultStrength * 100) / 100);
  const quality = options.quality ?? "preview";
  const analysis = options.analysis ?? fallbackAnalysis ?? null;

  const presetAdjustments = scaleAdjustments(preset.adjustments, strength);
  const withPreset = addAdjustments(defaultAdjustments, presetAdjustments);
  const mergedAdjustments = addAdjustments(withPreset, manualAdjustments);
  const adjusted = options.adaptToScene === false
    ? mergedAdjustments
    : applySceneAdaptation(mergedAdjustments, preset, analysis);

  return {
    preset,
    strength,
    quality,
    analysis,
    adjustments: adjusted,
    curve: scaleCurve(preset.curve, strength),
    splitTone: scaleSplitTone(preset.splitTone, strength),
    hsl: scaleHslBands(preset.hsl, strength),
  };
}

function buildCurveLuts(curve?: ToneCurve): CurveLuts {
  return {
    master: buildCurveLut(curve?.master),
    r: buildCurveLut(curve?.r),
    g: buildCurveLut(curve?.g),
    b: buildCurveLut(curve?.b),
  };
}

function applyToneCurve(value: number, channelLut: Uint8Array | null, masterLut: Uint8Array | null): number {
  const rounded = Math.round(value);
  const masterValue = masterLut ? masterLut[rounded] : rounded;
  return channelLut ? channelLut[masterValue] : masterValue;
}

function bandCenter(minHue: number, maxHue: number): number {
  if (minHue <= maxHue) return (minHue + maxHue) / 2;
  const wrappedMax = maxHue + 360;
  const center = (minHue + wrappedMax) / 2;
  return center >= 360 ? center - 360 : center;
}

function bandWidth(minHue: number, maxHue: number): number {
  if (minHue <= maxHue) return maxHue - minHue;
  return 360 - minHue + maxHue;
}

function bandInfluence(hue: number, band: HslBandAdjustment): number {
  const width = Math.max(8, bandWidth(band.minHue, band.maxHue));
  const center = bandCenter(band.minHue, band.maxHue);
  const softness = band.softness ?? 18;
  const distance = hueDistance(hue, center);
  const hardRadius = Math.max(1, width / 2);
  return 1 - smoothstep(hardRadius, hardRadius + softness, distance);
}

function applyHslAdjustments(
  r: number,
  g: number,
  b: number,
  settings: ResolvedFilterSettings,
  skinProtection: number,
): [number, number, number] {
  const adjustments = settings.adjustments;
  let [hue, saturation, lightness] = rgbToHsl(r, g, b);
  const baseHue = hue;

  const vibranceBoost = adjustments.vibrance / 100;
  const saturationBoost = adjustments.saturation / 100;
  const skinLike =
    baseHue >= 16 &&
    baseHue <= 54 &&
    saturation >= 0.12 &&
    saturation <= 0.7 &&
    lightness >= 0.18 &&
    lightness <= 0.86;
  const skinGuard = skinLike ? 1 - skinProtection * 0.55 : 1;

  saturation = clamp01(saturation * (1 + saturationBoost * skinGuard));
  if (vibranceBoost !== 0) {
    const headroom = vibranceBoost > 0 ? 1 - saturation : saturation;
    const direction = vibranceBoost > 0 ? 1 : -1;
    saturation = clamp01(saturation + headroom * Math.abs(vibranceBoost) * 0.75 * skinGuard * direction);
  }

  for (const band of settings.hsl) {
    const influence = bandInfluence(baseHue, band);
    if (influence <= 0.001) continue;

    hue += band.hueShift * influence;
    const satDelta = band.saturation / 100;
    const lightDelta = band.lightness / 100;
    saturation = clamp01(saturation * (1 + satDelta * influence));
    lightness = clamp01(lightness + lightDelta * influence * 0.6);
  }

  return hslToRgb(hue, saturation, lightness);
}

function applySplitTone(
  r: number,
  g: number,
  b: number,
  splitTone: SplitToneSettings | undefined,
): [number, number, number] {
  if (!splitTone) return [r, g, b];

  const lum = luminance(r, g, b);
  const balancePivot = 0.5 + splitTone.balance / 200;
  const shadowMask = 1 - smoothstep(0.08, balancePivot, lum);
  const highlightMask = smoothstep(balancePivot, 0.98, lum);

  const [shadowR, shadowG, shadowB] = hslToRgb(splitTone.shadows.hue, splitTone.shadows.saturation / 100, 0.5);
  const [highlightR, highlightG, highlightB] = hslToRgb(splitTone.highlights.hue, splitTone.highlights.saturation / 100, 0.5);

  const shadowAmount = shadowMask * (splitTone.shadows.saturation / 100) * 0.35;
  const highlightAmount = highlightMask * (splitTone.highlights.saturation / 100) * 0.35;

  return [
    clamp(lerp(r, shadowR, shadowAmount) + (highlightR - r) * highlightAmount * 0.6),
    clamp(lerp(g, shadowG, shadowAmount) + (highlightG - g) * highlightAmount * 0.6),
    clamp(lerp(b, shadowB, shadowAmount) + (highlightB - b) * highlightAmount * 0.6),
  ];
}

function applyFade(channel: number, amount: number): number {
  if (amount <= 0) return channel;

  const fade = amount / 100;
  const normalized = channel / 255;
  const lifted = lerp(normalized, 0.13 + normalized * 0.82, fade);
  return clamp(lifted * 255);
}

function computeLuminanceBuffer(data: Uint8ClampedArray): Float32Array {
  const luminanceBuffer = new Float32Array(data.length / 4);
  for (let pixelIndex = 0; pixelIndex < luminanceBuffer.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    luminanceBuffer[pixelIndex] = luminance(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2]) * 255;
  }
  return luminanceBuffer;
}

function applyDetailPass(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  clarity: number,
  sharpness: number,
  quality: "preview" | "export",
): void {
  if (clarity === 0 && sharpness === 0) return;

  const luma = computeLuminanceBuffer(data);
  const clarityRadius = quality === "preview" ? 1 : 2;
  const sharpRadius = 1;
  const clarityBlur = boxBlurGray(luma, width, height, clarityRadius);
  const sharpBlur = sharpness !== 0 ? boxBlurGray(luma, width, height, sharpRadius) : clarityBlur;
  const clarityStrength = clarity / 100;
  const sharpStrength = sharpness / 100;

  for (let pixelIndex = 0; pixelIndex < luma.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const baseLuma = luma[pixelIndex];
    const clarityDetail = baseLuma - clarityBlur[pixelIndex];
    const sharpDetail = baseLuma - sharpBlur[pixelIndex];
    const midtoneMask = 1 - Math.abs(baseLuma / 255 - 0.5) * 1.8;
    const clarityDelta = clarityDetail * clarityStrength * clamp01(midtoneMask) * 0.65;
    const sharpDelta = sharpDetail * sharpStrength * 0.85;
    const delta = clarityDelta + sharpDelta;

    data[dataIndex] = clamp(data[dataIndex] + delta);
    data[dataIndex + 1] = clamp(data[dataIndex + 1] + delta);
    data[dataIndex + 2] = clamp(data[dataIndex + 2] + delta);
  }
}

function applyBloomPass(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bloom: number,
  quality: "preview" | "export",
): void {
  if (bloom <= 0) return;

  const brightPass = new Float32Array(width * height);
  for (let pixelIndex = 0; pixelIndex < brightPass.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const lum = luminance(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2]);
    brightPass[pixelIndex] = lum > 0.68 ? (lum - 0.68) / 0.32 * 255 : 0;
  }

  const radius = quality === "preview" ? 2 : 4;
  const blurred = boxBlurGray(brightPass, width, height, radius);
  const amount = bloom / 100;

  for (let pixelIndex = 0; pixelIndex < blurred.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const glow = blurred[pixelIndex] * amount * 0.22;
    data[dataIndex] = clamp(data[dataIndex] + glow * 1.05);
    data[dataIndex + 1] = clamp(data[dataIndex + 1] + glow * 0.9);
    data[dataIndex + 2] = clamp(data[dataIndex + 2] + glow * 0.75);
  }
}

function finalPass(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  adjustments: Adjustments,
): void {
  const vignette = adjustments.vignette / 100;
  const fade = adjustments.fade;
  const grain = adjustments.grain / 100;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = Math.sqrt(centerX ** 2 + centerY ** 2);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const dataIndex = pixelIndex * 4;
      const r = data[dataIndex];
      const g = data[dataIndex + 1];
      const b = data[dataIndex + 2];
      const lum = luminance(r, g, b);

      if (vignette > 0) {
        const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / maxDistance;
        const vignetteMask = smoothstep(0.42, 1, distance);
        const amount = vignetteMask * vignette * 0.38;
        data[dataIndex] = clamp(r * (1 - amount));
        data[dataIndex + 1] = clamp(g * (1 - amount));
        data[dataIndex + 2] = clamp(b * (1 - amount));
      }

      if (fade > 0) {
        data[dataIndex] = applyFade(data[dataIndex], fade);
        data[dataIndex + 1] = applyFade(data[dataIndex + 1], fade);
        data[dataIndex + 2] = applyFade(data[dataIndex + 2], fade);
      }

      if (grain > 0) {
        const tonalWeight = clamp01(1 - Math.abs(lum - 0.5) * 1.25);
        const baseNoise = hashNoise(x, y, 17) - 0.5;
        const chromaNoise = hashNoise(x, y, 41) - 0.5;
        const amount = grain * tonalWeight * 14;
        data[dataIndex] = clamp(data[dataIndex] + baseNoise * amount * 1.05);
        data[dataIndex + 1] = clamp(data[dataIndex + 1] + (baseNoise * 0.85 + chromaNoise * 0.15) * amount);
        data[dataIndex + 2] = clamp(data[dataIndex + 2] + (baseNoise * 0.7 - chromaNoise * 0.2) * amount);
      }
    }
  }
}

function renderBasePass(sourceData: ImageData, settings: ResolvedFilterSettings): Uint8ClampedArray {
  const output = new Uint8ClampedArray(sourceData.data);
  const curveLuts = buildCurveLuts(settings.curve);
  const adjustments = settings.adjustments;
  const skinProtection = (settings.analysis?.portraitLikelihood ?? 0) * (settings.preset.adaptive?.portraitProtection ?? 0.72);

  for (let index = 0; index < output.length; index += 4) {
    const originalR = output[index];
    const originalG = output[index + 1];
    const originalB = output[index + 2];
    let r = originalR / 255;
    let g = originalG / 255;
    let b = originalB / 255;

    const lum = luminance(originalR, originalG, originalB);
    const shadowMask = 1 - smoothstep(0.08, 0.52, lum);
    const highlightMask = smoothstep(0.48, 0.96, lum);
    const whiteMask = smoothstep(0.7, 1, lum);
    const blackMask = 1 - smoothstep(0.0, 0.28, lum);

    r += adjustments.brightness / 100 * 0.16;
    g += adjustments.brightness / 100 * 0.16;
    b += adjustments.brightness / 100 * 0.16;

    const contrastFactor = 1 + adjustments.contrast / 100 * 0.82;
    r = (r - 0.5) * contrastFactor + 0.5;
    g = (g - 0.5) * contrastFactor + 0.5;
    b = (b - 0.5) * contrastFactor + 0.5;

    const highlightAmount = adjustments.highlights / 100;
    const shadowAmount = adjustments.shadows / 100;
    const whitesAmount = adjustments.whites / 100;
    const blacksAmount = adjustments.blacks / 100;

    r = mixToward(r, highlightAmount >= 0 ? 1 : 0, Math.abs(highlightAmount) * highlightMask * 0.22) + (highlightAmount < 0 ? highlightMask * highlightAmount * 0.08 : 0);
    g = mixToward(g, highlightAmount >= 0 ? 1 : 0, Math.abs(highlightAmount) * highlightMask * 0.22) + (highlightAmount < 0 ? highlightMask * highlightAmount * 0.08 : 0);
    b = mixToward(b, highlightAmount >= 0 ? 1 : 0, Math.abs(highlightAmount) * highlightMask * 0.22) + (highlightAmount < 0 ? highlightMask * highlightAmount * 0.08 : 0);

    r = mixToward(r, shadowAmount >= 0 ? 1 : 0, Math.abs(shadowAmount) * shadowMask * 0.18) + (shadowAmount < 0 ? shadowMask * shadowAmount * 0.08 : 0);
    g = mixToward(g, shadowAmount >= 0 ? 1 : 0, Math.abs(shadowAmount) * shadowMask * 0.18) + (shadowAmount < 0 ? shadowMask * shadowAmount * 0.08 : 0);
    b = mixToward(b, shadowAmount >= 0 ? 1 : 0, Math.abs(shadowAmount) * shadowMask * 0.18) + (shadowAmount < 0 ? shadowMask * shadowAmount * 0.08 : 0);

    r = mixToward(r, whitesAmount >= 0 ? 1 : 0, Math.abs(whitesAmount) * whiteMask * 0.28) + (whitesAmount < 0 ? whiteMask * whitesAmount * 0.12 : 0);
    g = mixToward(g, whitesAmount >= 0 ? 1 : 0, Math.abs(whitesAmount) * whiteMask * 0.28) + (whitesAmount < 0 ? whiteMask * whitesAmount * 0.12 : 0);
    b = mixToward(b, whitesAmount >= 0 ? 1 : 0, Math.abs(whitesAmount) * whiteMask * 0.28) + (whitesAmount < 0 ? whiteMask * whitesAmount * 0.12 : 0);

    r = mixToward(r, blacksAmount >= 0 ? 0.08 : 0, Math.abs(blacksAmount) * blackMask * 0.26) + (blacksAmount < 0 ? blackMask * blacksAmount * 0.09 : 0);
    g = mixToward(g, blacksAmount >= 0 ? 0.08 : 0, Math.abs(blacksAmount) * blackMask * 0.26) + (blacksAmount < 0 ? blackMask * blacksAmount * 0.09 : 0);
    b = mixToward(b, blacksAmount >= 0 ? 0.08 : 0, Math.abs(blacksAmount) * blackMask * 0.26) + (blacksAmount < 0 ? blackMask * blacksAmount * 0.09 : 0);

    const temperature = adjustments.temperature / 100;
    const tint = adjustments.tint / 100;
    r += temperature * 0.08 + tint * 0.035;
    g += temperature * 0.012 - tint * 0.05;
    b -= temperature * 0.09 - tint * 0.02;

    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);

    let channelR = clamp(r * 255);
    let channelG = clamp(g * 255);
    let channelB = clamp(b * 255);

    [channelR, channelG, channelB] = applyHslAdjustments(channelR, channelG, channelB, settings, skinProtection);

    channelR = applyToneCurve(channelR, curveLuts.r, curveLuts.master);
    channelG = applyToneCurve(channelG, curveLuts.g, curveLuts.master);
    channelB = applyToneCurve(channelB, curveLuts.b, curveLuts.master);

    [channelR, channelG, channelB] = applySplitTone(channelR, channelG, channelB, settings.splitTone);

    output[index] = channelR;
    output[index + 1] = channelG;
    output[index + 2] = channelB;
  }

  return output;
}

export function applyFilterToImageData(
  sourceData: ImageData,
  filterName: string,
  manualAdjustments: Partial<Adjustments> = defaultAdjustments,
  options: RenderOptions = {},
): ImageData {
  const analysis = options.analysis ?? analyzeImageData(sourceData);
  const settings = resolveFilterSettings(filterName, manualAdjustments, options, analysis);
  const output = renderBasePass(sourceData, settings);

  applyDetailPass(
    output,
    sourceData.width,
    sourceData.height,
    settings.adjustments.clarity,
    settings.adjustments.sharpness,
    settings.quality,
  );
  applyBloomPass(
    output,
    sourceData.width,
    sourceData.height,
    settings.adjustments.bloom,
    settings.quality,
  );
  finalPass(output, sourceData.width, sourceData.height, settings.adjustments);

  return new ImageData(output, sourceData.width, sourceData.height);
}

export function getResolvedFilterSettings(
  filterName: string,
  manualAdjustments: Partial<Adjustments>,
  options: RenderOptions = {},
): ResolvedFilterSettings {
  return resolveFilterSettings(filterName, manualAdjustments, options);
}
