import { analyzeImageData } from "../filter-engine/analysis";
import type {
  Adjustments,
  CurveLuts,
  FilterPresetDefinition,
  HslBandAdjustment,
  ImageAnalysis,
  RenderOptions,
  ResolvedFilterSettings,
  SplitToneSettings,
  ToneCurve,
} from "../filter-engine/types";
import { defaultAdjustments } from "../filter-engine/types";
import {
  addAdjustments,
  boxBlurGray,
  buildCurveLut,
  clamp,
  clamp01,
  clampAdjustment,
  hslToRgb,
  hueDistance,
  lerp,
  luminance,
  mixToward,
  rgbToHsl,
  scaleAdjustments,
  scaleCurve,
  smoothstep,
} from "../filter-engine/utils";
import { getFilterPreset } from "./presets";

interface LabColor {
  l: number;
  a: number;
  b: number;
}

interface SplitToneTargets {
  shadow: LabColor;
  highlight: LabColor;
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

  result.saturation = clampAdjustment("saturation", result.saturation - colorGuard * 12 - portraitGuard * 5);
  result.vibrance = clampAdjustment("vibrance", result.vibrance - colorGuard * 10 - portraitGuard * 6);
  result.temperature = clampAdjustment(
    "temperature",
    result.temperature - outdoorGuard * Math.max(0, result.temperature) * 0.3 - indoorGuard * Math.min(0, result.temperature) * 0.3,
  );
  result.tint = clampAdjustment("tint", result.tint - portraitGuard * result.tint * 0.15 + indoorGuard * 2);
  result.highlights = clampAdjustment("highlights", result.highlights - overexposedGuard * 14);
  result.whites = clampAdjustment("whites", result.whites - overexposedGuard * 10);
  result.brightness = clampAdjustment("brightness", result.brightness - overexposedGuard * 6 + underexposedGuard * 4);
  result.shadows = clampAdjustment("shadows", result.shadows + underexposedGuard * 12);
  result.blacks = clampAdjustment("blacks", result.blacks + underexposedGuard * 8);
  result.clarity = clampAdjustment("clarity", result.clarity - lowLightGuard * 10 - portraitGuard * 6);
  result.sharpness = clampAdjustment("sharpness", result.sharpness - lowLightGuard * 8 - portraitGuard * 5);
  result.grain = clampAdjustment("grain", result.grain - lowLightGuard * 6);
  result.bloom = clampAdjustment("bloom", result.bloom + analysis.brightLikelihood * 4 - lowLightGuard * 4);

  if (analysis.flatLikelihood > 0.48) {
    result.contrast = clampAdjustment("contrast", result.contrast + 4);
    result.clarity = clampAdjustment("clarity", result.clarity + 3);
  }

  return result;
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

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const value = clamp01(channel);
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp(Math.round(encoded * 255));
}

function rgbToLab(r: number, g: number, b: number): LabColor {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883;

  const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function labToRgb(lab: LabColor): [number, number, number] {
  const fy = (lab.l + 16) / 116;
  const fx = lab.a / 500 + fy;
  const fz = fy - lab.b / 200;

  const x3 = fx ** 3;
  const y3 = fy ** 3;
  const z3 = fz ** 3;

  const x = 0.95047 * (x3 > 0.008856 ? x3 : (fx - 16 / 116) / 7.787);
  const y = y3 > 0.008856 ? y3 : (fy - 16 / 116) / 7.787;
  const z = 1.08883 * (z3 > 0.008856 ? z3 : (fz - 16 / 116) / 7.787);

  const lr = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const lg = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const lb = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

function getSplitToneTargets(splitTone: SplitToneSettings | undefined): SplitToneTargets | null {
  if (!splitTone) return null;

  const [shadowR, shadowG, shadowB] = hslToRgb(splitTone.shadows.hue, splitTone.shadows.saturation / 100, 0.48);
  const [highlightR, highlightG, highlightB] = hslToRgb(
    splitTone.highlights.hue,
    splitTone.highlights.saturation / 100,
    0.58,
  );

  return {
    shadow: rgbToLab(shadowR, shadowG, shadowB),
    highlight: rgbToLab(highlightR, highlightG, highlightB),
  };
}

function applySplitTone(
  r: number,
  g: number,
  b: number,
  splitTone: SplitToneSettings | undefined,
  targets: SplitToneTargets | null,
): [number, number, number] {
  if (!splitTone || !targets) return [r, g, b];

  const lum = luminance(r, g, b);
  const balancePivot = 0.5 + splitTone.balance / 200;
  const shadowMask = 1 - smoothstep(0.08, balancePivot, lum);
  const highlightMask = smoothstep(balancePivot, 0.98, lum);
  const shadowAmount = shadowMask * (splitTone.shadows.saturation / 100) * 0.32;
  const highlightAmount = highlightMask * (splitTone.highlights.saturation / 100) * 0.28;

  const lab = rgbToLab(r, g, b);
  const toned: LabColor = {
    l: lab.l + highlightAmount * 1.4 - shadowAmount * 0.8,
    a:
      lab.a +
      (targets.shadow.a - lab.a) * shadowAmount * 0.65 +
      (targets.highlight.a - lab.a) * highlightAmount * 0.55,
    b:
      lab.b +
      (targets.shadow.b - lab.b) * shadowAmount * 0.65 +
      (targets.highlight.b - lab.b) * highlightAmount * 0.55,
  };

  return labToRgb(toned);
}

function getTemperatureScale(amount: number): [number, number, number] {
  if (amount >= 0) {
    return [lerp(1, 1.1, amount), lerp(1, 1.02, amount), lerp(1, 0.9, amount)];
  }

  const coolAmount = Math.abs(amount);
  return [lerp(1, 0.9, coolAmount), lerp(1, 0.97, coolAmount), lerp(1, 1.12, coolAmount)];
}

function applyFade(channel: number, amount: number): number {
  if (amount <= 0) return channel;
  const lift = clamp01(amount / 100);
  return clamp(channel * (1 - lift) + lift * 255);
}

function sineNoise(x: number, y: number): number {
  const raw = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return raw - Math.floor(raw);
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
    brightPass[pixelIndex] = lum > 0.68 ? ((lum - 0.68) / 0.32) * 255 : 0;
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
        const vignetteMask = smoothstep(0.4, 1, distance);
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
        const baseNoise = sineNoise(x, y) - 0.5;
        const chromaNoise = sineNoise(x + 23.17, y + 11.13) - 0.5;
        const amount = grain * tonalWeight * 14;
        data[dataIndex] = clamp(data[dataIndex] + baseNoise * amount * 1.05);
        data[dataIndex + 1] = clamp(data[dataIndex + 1] + (baseNoise * 0.85 + chromaNoise * 0.15) * amount);
        data[dataIndex + 2] = clamp(data[dataIndex + 2] + (baseNoise * 0.7 - chromaNoise * 0.2) * amount);
      }
    }
  }
}

function renderBasePass(
  source: Uint8ClampedArray,
  output: Uint8ClampedArray,
  width: number,
  height: number,
  settings: ResolvedFilterSettings,
): void {
  const { curveLuts } = settings;
  const adjustments = settings.adjustments;
  const skinProtection =
    (settings.analysis?.portraitLikelihood ?? 0) * (settings.preset.adaptive?.portraitProtection ?? 0.72);
  const splitToneTargets = getSplitToneTargets(settings.splitTone);
  const [temperatureR, temperatureG, temperatureB] = getTemperatureScale(adjustments.temperature / 100);
  const tint = adjustments.tint / 100;
  void width;
  void height;

  for (let index = 0; index < output.length; index += 4) {
    const originalR = source[index];
    const originalG = source[index + 1];
    const originalB = source[index + 2];
    let r = originalR / 255;
    let g = originalG / 255;
    let b = originalB / 255;

    const lum = luminance(originalR, originalG, originalB);
    const shadowMask = 1 - smoothstep(0.08, 0.52, lum);
    const highlightMask = smoothstep(0.48, 0.96, lum);
    const whiteMask = smoothstep(0.7, 1, lum);
    const blackMask = 1 - smoothstep(0, 0.28, lum);

    r += (adjustments.brightness / 100) * 0.16;
    g += (adjustments.brightness / 100) * 0.16;
    b += (adjustments.brightness / 100) * 0.16;

    const contrastFactor = 1 + (adjustments.contrast / 100) * 0.82;
    r = (r - 0.5) * contrastFactor + 0.5;
    g = (g - 0.5) * contrastFactor + 0.5;
    b = (b - 0.5) * contrastFactor + 0.5;

    const highlightAmount = adjustments.highlights / 100;
    const shadowAmount = adjustments.shadows / 100;
    const whitesAmount = adjustments.whites / 100;
    const blacksAmount = adjustments.blacks / 100;

    r =
      mixToward(r, highlightAmount >= 0 ? 1 : 0, Math.abs(highlightAmount) * highlightMask * 0.22) +
      (highlightAmount < 0 ? highlightMask * highlightAmount * 0.08 : 0);
    g =
      mixToward(g, highlightAmount >= 0 ? 1 : 0, Math.abs(highlightAmount) * highlightMask * 0.22) +
      (highlightAmount < 0 ? highlightMask * highlightAmount * 0.08 : 0);
    b =
      mixToward(b, highlightAmount >= 0 ? 1 : 0, Math.abs(highlightAmount) * highlightMask * 0.22) +
      (highlightAmount < 0 ? highlightMask * highlightAmount * 0.08 : 0);

    r =
      mixToward(r, shadowAmount >= 0 ? 1 : 0, Math.abs(shadowAmount) * shadowMask * 0.18) +
      (shadowAmount < 0 ? shadowMask * shadowAmount * 0.08 : 0);
    g =
      mixToward(g, shadowAmount >= 0 ? 1 : 0, Math.abs(shadowAmount) * shadowMask * 0.18) +
      (shadowAmount < 0 ? shadowMask * shadowAmount * 0.08 : 0);
    b =
      mixToward(b, shadowAmount >= 0 ? 1 : 0, Math.abs(shadowAmount) * shadowMask * 0.18) +
      (shadowAmount < 0 ? shadowMask * shadowAmount * 0.08 : 0);

    r =
      mixToward(r, whitesAmount >= 0 ? 1 : 0, Math.abs(whitesAmount) * whiteMask * 0.28) +
      (whitesAmount < 0 ? whiteMask * whitesAmount * 0.12 : 0);
    g =
      mixToward(g, whitesAmount >= 0 ? 1 : 0, Math.abs(whitesAmount) * whiteMask * 0.28) +
      (whitesAmount < 0 ? whiteMask * whitesAmount * 0.12 : 0);
    b =
      mixToward(b, whitesAmount >= 0 ? 1 : 0, Math.abs(whitesAmount) * whiteMask * 0.28) +
      (whitesAmount < 0 ? whiteMask * whitesAmount * 0.12 : 0);

    r =
      mixToward(r, blacksAmount >= 0 ? 0.08 : 0, Math.abs(blacksAmount) * blackMask * 0.26) +
      (blacksAmount < 0 ? blackMask * blacksAmount * 0.09 : 0);
    g =
      mixToward(g, blacksAmount >= 0 ? 0.08 : 0, Math.abs(blacksAmount) * blackMask * 0.26) +
      (blacksAmount < 0 ? blackMask * blacksAmount * 0.09 : 0);
    b =
      mixToward(b, blacksAmount >= 0 ? 0.08 : 0, Math.abs(blacksAmount) * blackMask * 0.26) +
      (blacksAmount < 0 ? blackMask * blacksAmount * 0.09 : 0);

    r *= temperatureR;
    g *= temperatureG;
    b *= temperatureB;

    r += tint * 0.02;
    g -= tint * 0.03;
    b += tint * 0.012;

    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);

    let channelR = clamp(r * 255);
    let channelG = clamp(g * 255);
    let channelB = clamp(b * 255);

    [channelR, channelG, channelB] = applyHslAdjustments(channelR, channelG, channelB, settings, skinProtection);

    if (settings.adjustments.saturation <= -100 && settings.adjustments.vibrance <= -100) {
      const grayscale = clamp(luminance(channelR, channelG, channelB) * 255);
      channelR = grayscale;
      channelG = grayscale;
      channelB = grayscale;
    }

    channelR = applyToneCurve(channelR, curveLuts.r, curveLuts.master);
    channelG = applyToneCurve(channelG, curveLuts.g, curveLuts.master);
    channelB = applyToneCurve(channelB, curveLuts.b, curveLuts.master);

    [channelR, channelG, channelB] = applySplitTone(
      channelR,
      channelG,
      channelB,
      settings.splitTone,
      splitToneTargets,
    );

    output[index] = channelR;
    output[index + 1] = channelG;
    output[index + 2] = channelB;
  }
}

function blendEffectIntensity(
  original: Uint8ClampedArray,
  output: Uint8ClampedArray,
  effectIntensity: number,
): void {
  if (effectIntensity >= 0.999) return;

  for (let index = 0; index < output.length; index += 4) {
    output[index] = clamp(lerp(original[index], output[index], effectIntensity));
    output[index + 1] = clamp(lerp(original[index + 1], output[index + 1], effectIntensity));
    output[index + 2] = clamp(lerp(original[index + 2], output[index + 2], effectIntensity));
  }
}

function enforceMonochrome(data: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    const grayscale = clamp(luminance(data[index], data[index + 1], data[index + 2]) * 255);
    data[index] = grayscale;
    data[index + 1] = grayscale;
    data[index + 2] = grayscale;
  }
}

export function prepareFilterSettings(
  filterName: string,
  manualAdjustments: Partial<Adjustments>,
  options: RenderOptions = {},
  fallbackAnalysis?: ImageAnalysis,
): ResolvedFilterSettings {
  const preset = getFilterPreset(filterName);
  const strength = clamp01((options.strength ?? preset.defaultStrength * 100) / 100);
  const effectIntensity = clamp01((options.effectIntensity ?? 100) / 100);
  const quality = options.quality ?? "preview";
  const analysis = options.analysis ?? fallbackAnalysis ?? null;

  const presetAdjustments = scaleAdjustments(preset.adjustments, strength);
  const withPreset = addAdjustments(defaultAdjustments, presetAdjustments);
  const mergedAdjustments = addAdjustments(withPreset, manualAdjustments);
  const adjusted = options.adaptToScene === false
    ? mergedAdjustments
    : applySceneAdaptation(mergedAdjustments, preset, analysis);
  const curve = scaleCurve(preset.curve, strength);

  return {
    preset,
    strength,
    effectIntensity,
    quality,
    analysis,
    adjustments: adjusted,
    curve,
    curveLuts: buildCurveLuts(curve),
    splitTone: scaleSplitTone(preset.splitTone, strength),
    hsl: scaleHslBands(preset.hsl, strength),
  };
}

export interface FilterAbortSignal {
  readonly aborted: boolean;
}

export function applyFilter(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  settings: ResolvedFilterSettings,
  /**
   * Optional abort signal. The engine checks `signal.aborted` between
   * top-level passes (base, detail, bloom, final, monochrome, blend) and
   * short-circuits when set. The pixel buffer is left in an intermediate
   * state on abort; the caller (typically the filter worker) is
   * responsible for discarding it and not transferring the result back
   * to the main thread.
   */
  signal?: FilterAbortSignal,
): void {
  const original = new Uint8ClampedArray(pixelData);

  renderBasePass(original, pixelData, width, height, settings);
  if (signal?.aborted) return;
  applyDetailPass(pixelData, width, height, settings.adjustments.clarity, settings.adjustments.sharpness, settings.quality);
  if (signal?.aborted) return;
  applyBloomPass(pixelData, width, height, settings.adjustments.bloom, settings.quality);
  if (signal?.aborted) return;
  finalPass(pixelData, width, height, settings.adjustments);

  if (settings.adjustments.saturation <= -100 && settings.adjustments.vibrance <= -100) {
    enforceMonochrome(pixelData);
  }
  if (signal?.aborted) return;

  blendEffectIntensity(original, pixelData, settings.effectIntensity);
}

export function applyFilterToImageData(
  sourceData: ImageData,
  filterName: string,
  manualAdjustments: Partial<Adjustments> = defaultAdjustments,
  options: RenderOptions = {},
): ImageData {
  const analysis = options.analysis ?? analyzeImageData(sourceData);
  const settings = prepareFilterSettings(filterName, manualAdjustments, options, analysis);
  const output = new Uint8ClampedArray(sourceData.data);

  applyFilter(output, sourceData.width, sourceData.height, settings);

  return new ImageData(output, sourceData.width, sourceData.height);
}

export function getResolvedFilterSettings(
  filterName: string,
  manualAdjustments: Partial<Adjustments>,
  options: RenderOptions = {},
): ResolvedFilterSettings {
  return prepareFilterSettings(filterName, manualAdjustments, options);
}
