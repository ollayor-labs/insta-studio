// Float32 export pipeline. Mirrors the Uint8 engine's main pass in 0..1
// float space, then clamps to Uint8 once at the end. This is the bulk of
// the fix for visible banding in smooth gradients: every per-channel
// multiply/add/contrast step that previously got rounded to the nearest
// 0..255 integer now keeps its sub-LSB precision. The cost is roughly 4x
// the per-pixel memory and a few extra multiplies, so we only run it on
// export — the preview path stays on Uint8.
//
// Scope note: this file is a *parallel* pipeline, not a swap. The Uint8
// engine is unchanged. If the Float32 path has a bug, exports still work
// (they just fall back to the existing Uint8 path).

import { buildCurveLut } from "./utils";
import { rgbToLabFloat, labToRgbFloat } from "./color-space";
import {
  defaultAdjustments,
  prepareFilterSettings,
  type Adjustments,
  type HslBandAdjustment,
  type ImageAnalysis,
  type ResolvedFilterSettings,
  type SplitToneSettings,
  type ToneCurve,
} from "./index";

const SKIN_PROTECTION_DEFAULT = 0.72;

interface Float32Luts {
  master: Float32Array | null;
  r: Float32Array | null;
  g: Float32Array | null;
  b: Float32Array | null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp255(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const range = edge1 - edge0;
  if (range === 0) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / range);
  return t * t * (3 - 2 * t);
}

function mixToward(current: number, target: number, amount: number): number {
  return current + (target - current) * amount;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToHslFloat(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [(hue / 6) * 360, saturation, lightness];
}

function hueToChannel(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgbFloat(h: number, s: number, l: number): [number, number, number] {
  const hue = ((((h % 360) + 360) % 360) / 360);
  const saturation = clamp01(s);
  const lightness = clamp01(l);
  if (saturation === 0) return [lightness, lightness, lightness];
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    hueToChannel(p, q, hue + 1 / 3),
    hueToChannel(p, q, hue),
    hueToChannel(p, q, hue - 1 / 3),
  ];
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

function bandWidth(minHue: number, maxHue: number): number {
  if (minHue <= maxHue) return maxHue - minHue;
  return 360 - minHue + maxHue;
}

function bandCenter(minHue: number, maxHue: number): number {
  if (minHue <= maxHue) return (minHue + maxHue) / 2;
  const wrappedMax = maxHue + 360;
  const center = (minHue + wrappedMax) / 2;
  return center >= 360 ? center - 360 : center;
}

function bandInfluence(hue: number, band: HslBandAdjustment): number {
  const width = Math.max(8, bandWidth(band.minHue, band.maxHue));
  const center = bandCenter(band.minHue, band.maxHue);
  const softness = band.softness ?? 18;
  const distance = hueDistance(hue, center);
  const hardRadius = Math.max(1, width / 2);
  return 1 - smoothstep(hardRadius, hardRadius + softness, distance);
}

function buildFloat32Luts(curve: ToneCurve | undefined): Float32Luts {
  const convert = (points: number[] | undefined): Float32Array | null => {
    const lut = buildCurveLut(points);
    if (!lut) return null;
    // Lift the 8-bit LUT to a Float32 interpolation table. We leave the
    // first/last entries as anchors and lerp between them in the export
    // path so sub-LSB precision survives.
    const out = new Float32Array(lut.length);
    for (let index = 0; index < lut.length; index += 1) {
      out[index] = lut[index] / 255;
    }
    return out;
  };
  return {
    master: convert(curve?.master),
    r: convert(curve?.r),
    g: convert(curve?.g),
    b: convert(curve?.b),
  };
}

function applyToneCurveFloat(value: number, channelLut: Float32Array | null, masterLut: Float32Array | null): number {
  const sampleFloat = (lut: Float32Array, position: number): number => {
    const clamped = position < 0 ? 0 : position > 1 ? 1 : position;
    const scaled = clamped * 255;
    const lower = Math.floor(scaled);
    const upper = lower >= 255 ? 255 : lower + 1;
    const fraction = scaled - lower;
    return lut[lower] + (lut[upper] - lut[lower]) * fraction;
  };
  let position = value;
  if (masterLut) {
    position = sampleFloat(masterLut, position);
  }
  if (channelLut) {
    position = sampleFloat(channelLut, position);
  }
  return position;
}

function getSplitToneTargetsFloat(splitTone: SplitToneSettings | undefined): {
  shadowR: number;
  shadowG: number;
  shadowB: number;
  highlightR: number;
  highlightG: number;
  highlightB: number;
} | null {
  if (!splitTone) return null;
  const [shadowR, shadowG, shadowB] = hslToRgbFloat(
    splitTone.shadows.hue,
    splitTone.shadows.saturation / 100,
    0.48,
  );
  const [highlightR, highlightG, highlightB] = hslToRgbFloat(
    splitTone.highlights.hue,
    splitTone.highlights.saturation / 100,
    0.58,
  );
  return { shadowR, shadowG, shadowB, highlightR, highlightG, highlightB };
}

function getTemperatureScaleFloat(amount: number): [number, number, number] {
  // Same scale as the Uint8 path; kept here so the Float32 path is
  // self-contained.
  return [1 + amount * 0.12, 1, 1 - amount * 0.12];
}

function applyFadeFloat(channel: number, amount: number): number {
  if (amount <= 0) return channel;
  const lift = 0.05 * amount;
  return channel + (1 - channel) * lift;
}

function sineNoise(x: number, y: number): number {
  return 0.5 + 0.5 * Math.sin(x * 12.9898 + y * 78.233);
}

function applyHslFloat(
  r: number,
  g: number,
  b: number,
  adjustments: Adjustments,
  hsl: HslBandAdjustment[],
  skinProtection: number,
): [number, number, number] {
  let [hue, saturation, lightness] = rgbToHslFloat(r, g, b);
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

  for (const band of hsl) {
    const influence = bandInfluence(baseHue, band);
    if (influence <= 0.001) continue;
    hue += band.hueShift * influence;
    const satDelta = band.saturation / 100;
    const lightDelta = band.lightness / 100;
    saturation = clamp01(saturation * (1 + satDelta * influence));
    lightness = clamp01(lightness + lightDelta * influence * 0.6);
  }

  return hslToRgbFloat(hue, saturation, lightness);
}

function applySplitToneFloat(
  r: number,
  g: number,
  b: number,
  splitTone: SplitToneSettings | undefined,
  targets: ReturnType<typeof getSplitToneTargetsFloat>,
): [number, number, number] {
  if (!splitTone || !targets) return [r, g, b];
  const lum = luminance(r, g, b);
  // Mirror the Uint8 path's smoothstep windows; the saturation values drive
  // the strength (matching the engine's `shadowAmount`/`highlightAmount`).
  const balancePivot = 0.5 + splitTone.balance / 200;
  const shadowMask = 1 - smoothstep(0.08, balancePivot, lum);
  const highlightMask = smoothstep(balancePivot, 0.98, lum);
  const shadowAmount = shadowMask * (splitTone.shadows.saturation / 100) * 0.32;
  const highlightAmount = highlightMask * (splitTone.highlights.saturation / 100) * 0.28;

  // Convert the split-tone targets to Lab once. They were computed in
  // 0..1 HSL via hslToRgbFloat — convert the same way the Uint8 path
  // converts its 0..255 HSL targets, but in float space.
  const shadowLab = rgbToLabFloat(targets.shadowR, targets.shadowG, targets.shadowB);
  const highlightLab = rgbToLabFloat(targets.highlightR, targets.highlightG, targets.highlightB);
  const lab = rgbToLabFloat(r, g, b);
  const toned = {
    l: lab.l + highlightAmount * 1.4 - shadowAmount * 0.8,
    a:
      lab.a +
      (shadowLab.a - lab.a) * shadowAmount * 0.65 +
      (highlightLab.a - lab.a) * highlightAmount * 0.55,
    b:
      lab.b +
      (shadowLab.b - lab.b) * shadowAmount * 0.65 +
      (highlightLab.b - lab.b) * highlightAmount * 0.55,
  };
  return labToRgbFloat(toned);
}

function boxBlurGrayFloat(input: Float32Array, width: number, height: number, radius: number): Float32Array {
  const output = new Float32Array(input.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      const clamped = Math.max(0, Math.min(width - 1, x));
      sum += input[y * width + clamped];
    }
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = sum / diameter;
      const outIndex = Math.max(0, Math.min(width - 1, x - radius));
      const inIndex = Math.max(0, Math.min(width - 1, x + radius + 1));
      sum += input[y * width + inIndex] - input[y * width + outIndex];
    }
  }
  const transposed = new Float32Array(input.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      const clamped = Math.max(0, Math.min(height - 1, y));
      sum += output[clamped * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      transposed[y * width + x] = sum / diameter;
      const outIndex = Math.max(0, Math.min(height - 1, y - radius));
      const inIndex = Math.max(0, Math.min(height - 1, y + radius + 1));
      sum += output[inIndex * width + x] - output[outIndex * width + x];
    }
  }
  return transposed;
}

function buildFloat32Source(data: Uint8ClampedArray): Float32Array {
  const length = data.length / 4;
  const out = new Float32Array(data.length);
  for (let pixelIndex = 0; pixelIndex < length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    out[dataIndex] = data[dataIndex] / 255;
    out[dataIndex + 1] = data[dataIndex + 1] / 255;
    out[dataIndex + 2] = data[dataIndex + 2] / 255;
    out[dataIndex + 3] = data[dataIndex + 3] / 255;
  }
  return out;
}

function buildLuminanceFloat32(rgb: Float32Array): Float32Array {
  const length = rgb.length / 4;
  const out = new Float32Array(length);
  for (let pixelIndex = 0; pixelIndex < length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    out[pixelIndex] = luminance(rgb[dataIndex], rgb[dataIndex + 1], rgb[dataIndex + 2]);
  }
  return out;
}

interface Float32Settings {
  adjustments: Adjustments;
  luts: Float32Luts;
  splitTone: SplitToneSettings | undefined;
  hsl: HslBandAdjustment[];
  quality: "preview" | "export";
  skinProtection: number;
}

function resolveFloat32Settings(
  filterName: string,
  manualAdjustments: Partial<Adjustments>,
  analysis: ImageAnalysis | null,
  options: { strength?: number; effectIntensity?: number; quality?: "preview" | "export"; adaptToScene?: boolean },
): Float32Settings {
  const resolved: ResolvedFilterSettings = prepareFilterSettings(
    filterName,
    manualAdjustments,
    {
      strength: options.strength,
      effectIntensity: options.effectIntensity,
      quality: options.quality,
      analysis,
      adaptToScene: options.adaptToScene,
    },
    analysis ?? undefined,
  );
  return {
    adjustments: resolved.adjustments,
    luts: buildFloat32Luts(resolved.curve),
    splitTone: resolved.splitTone,
    hsl: resolved.hsl,
    quality: resolved.quality,
    skinProtection:
      (analysis?.portraitLikelihood ?? 0) *
      (resolved.preset.adaptive?.portraitProtection ?? SKIN_PROTECTION_DEFAULT),
  };
}

function applyDetailPassFloat(
  rgb: Float32Array,
  width: number,
  height: number,
  settings: Float32Settings,
): void {
  const { clarity, sharpness } = settings.adjustments;
  if (clarity === 0 && sharpness === 0) return;
  const luma = buildLuminanceFloat32(rgb);
  const clarityRadius = settings.quality === "preview" ? 1 : 2;
  const sharpRadius = 1;
  const clarityBlur = boxBlurGrayFloat(luma, width, height, clarityRadius);
  const sharpBlur = sharpness !== 0 ? boxBlurGrayFloat(luma, width, height, sharpRadius) : clarityBlur;
  const clarityStrength = clarity / 100;
  const sharpStrength = sharpness / 100;

  for (let pixelIndex = 0; pixelIndex < luma.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const baseLuma = luma[pixelIndex];
    const clarityDetail = baseLuma - clarityBlur[pixelIndex];
    const sharpDetail = baseLuma - sharpBlur[pixelIndex];
    const midtoneMask = 1 - Math.abs(baseLuma - 0.5) * 1.8;
    const clarityDelta = clarityDetail * clarityStrength * Math.max(0, Math.min(1, midtoneMask)) * 0.65;
    const sharpDelta = sharpDetail * sharpStrength * 0.85;
    const delta = clarityDelta + sharpDelta;
    rgb[dataIndex] = clamp01(rgb[dataIndex] + delta);
    rgb[dataIndex + 1] = clamp01(rgb[dataIndex + 1] + delta);
    rgb[dataIndex + 2] = clamp01(rgb[dataIndex + 2] + delta);
  }
}

function applyBloomPassFloat(
  rgb: Float32Array,
  width: number,
  height: number,
  settings: Float32Settings,
): void {
  const bloom = settings.adjustments.bloom;
  if (bloom <= 0) return;
  const brightPass = new Float32Array(width * height);
  for (let pixelIndex = 0; pixelIndex < brightPass.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const lum = luminance(rgb[dataIndex], rgb[dataIndex + 1], rgb[dataIndex + 2]);
    brightPass[pixelIndex] = lum > 0.68 ? ((lum - 0.68) / 0.32) : 0;
  }
  const radius = settings.quality === "preview" ? 2 : 4;
  const blurred = boxBlurGrayFloat(brightPass, width, height, radius);
  const amount = bloom / 100;
  for (let pixelIndex = 0; pixelIndex < blurred.length; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const glow = blurred[pixelIndex] * amount * 0.22;
    rgb[dataIndex] = clamp01(rgb[dataIndex] + glow * 1.05);
    rgb[dataIndex + 1] = clamp01(rgb[dataIndex + 1] + glow * 0.9);
    rgb[dataIndex + 2] = clamp01(rgb[dataIndex + 2] + glow * 0.75);
  }
}

function applyFinalPassFloat(
  rgb: Float32Array,
  width: number,
  height: number,
  settings: Float32Settings,
): void {
  const { vignette, fade, grain } = settings.adjustments;
  const vignetteAmount = vignette / 100;
  const fadeAmount = fade;
  const grainAmount = grain / 100;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = Math.sqrt(centerX ** 2 + centerY ** 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dataIndex = (y * width + x) * 4;
      let r = rgb[dataIndex];
      let g = rgb[dataIndex + 1];
      let b = rgb[dataIndex + 2];
      const lum = luminance(r, g, b);
      if (vignetteAmount > 0) {
        const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / maxDistance;
        const vignetteMask = smoothstep(0.4, 1, distance);
        const amount = vignetteMask * vignetteAmount * 0.38;
        r = r * (1 - amount);
        g = g * (1 - amount);
        b = b * (1 - amount);
      }
      if (fadeAmount > 0) {
        r = applyFadeFloat(r, fadeAmount);
        g = applyFadeFloat(g, fadeAmount);
        b = applyFadeFloat(b, fadeAmount);
      }
      if (grainAmount > 0) {
        const tonalWeight = clamp01(1 - Math.abs(lum - 0.5) * 1.25);
        const baseNoise = sineNoise(x, y) - 0.5;
        const chromaNoise = sineNoise(x + 23.17, y + 11.13) - 0.5;
        const amount = grainAmount * tonalWeight * (14 / 255);
        r = clamp01(r + baseNoise * amount * 1.05);
        g = clamp01(g + (baseNoise * 0.85 + chromaNoise * 0.15) * amount);
        b = clamp01(b + (baseNoise * 0.7 - chromaNoise * 0.2) * amount);
      }
      rgb[dataIndex] = r;
      rgb[dataIndex + 1] = g;
      rgb[dataIndex + 2] = b;
    }
  }
}

function applyBasePassFloat(
  source: Float32Array,
  output: Float32Array,
  width: number,
  height: number,
  settings: Float32Settings,
): void {
  const { adjustments, luts, splitTone, hsl, skinProtection } = settings;
  const splitToneTargets = getSplitToneTargetsFloat(splitTone);
  const [temperatureR, temperatureG, temperatureB] = getTemperatureScaleFloat(adjustments.temperature / 100);
  const tint = adjustments.tint / 100;
  void width;
  void height;

  for (let index = 0; index < output.length; index += 4) {
    const originalR = source[index];
    const originalG = source[index + 1];
    const originalB = source[index + 2];
    let r = originalR;
    let g = originalG;
    let b = originalB;

    const lum = luminance(originalR, originalG, originalB);
    const shadowMask = 1 - smoothstep(0.08, 0.52, lum);
    const highlightMask = smoothstep(0.48, 0.96, lum);
    const whiteMask = smoothstep(0.7, 1, lum);
    const blackMask = 1 - smoothstep(0, 0.28, lum);

    const brightness = (adjustments.brightness / 100) * 0.16;
    r += brightness;
    g += brightness;
    b += brightness;

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

    let channelR = r;
    let channelG = g;
    let channelB = b;

    if (adjustments.saturation <= -100 && adjustments.vibrance <= -100) {
      const grayscale = luminance(channelR, channelG, channelB);
      channelR = grayscale;
      channelG = grayscale;
      channelB = grayscale;
    } else {
      const [hr, hg, hb] = applyHslFloat(channelR, channelG, channelB, adjustments, hsl, skinProtection);
      channelR = hr;
      channelG = hg;
      channelB = hb;
    }

    channelR = applyToneCurveFloat(channelR, luts.r, luts.master);
    channelG = applyToneCurveFloat(channelG, luts.g, luts.master);
    channelB = applyToneCurveFloat(channelB, luts.b, luts.master);

    [channelR, channelG, channelB] = applySplitToneFloat(channelR, channelG, channelB, splitTone, splitToneTargets);

    output[index] = channelR;
    output[index + 1] = channelG;
    output[index + 2] = channelB;
  }
}

function applyFilterFloat32Internal(
  sourceData: ImageData,
  filterName: string,
  manualAdjustments: Partial<Adjustments>,
  options: { strength?: number; effectIntensity?: number; quality?: "preview" | "export"; analysis?: ImageAnalysis | null; adaptToScene?: boolean },
): ImageData {
  const settings = resolveFloat32Settings(filterName, manualAdjustments, options.analysis ?? null, options);
  const source = buildFloat32Source(sourceData.data);
  const output = source.slice();
  applyBasePassFloat(source, output, sourceData.width, sourceData.height, settings);
  applyDetailPassFloat(output, sourceData.width, sourceData.height, settings);
  applyBloomPassFloat(output, sourceData.width, sourceData.height, settings);
  applyFinalPassFloat(output, sourceData.width, sourceData.height, settings);

  // Blend against the original at effect intensity. In Float32 we lerp in
  // 0..1 space directly, no round trip through Uint8.
  const effectIntensity = Math.max(0, Math.min(1, (options.effectIntensity ?? 100) / 100));
  if (effectIntensity < 0.999) {
    for (let index = 0; index < output.length; index += 4) {
      output[index] = source[index] + (output[index] - source[index]) * effectIntensity;
      output[index + 1] = source[index + 1] + (output[index + 1] - source[index + 1]) * effectIntensity;
      output[index + 2] = source[index + 2] + (output[index + 2] - source[index + 2]) * effectIntensity;
    }
  }

  // Final single clamp to Uint8.
  const finalData = new Uint8ClampedArray(sourceData.data.length);
  for (let index = 0; index < finalData.length; index += 4) {
    finalData[index] = clamp255(output[index] * 255);
    finalData[index + 1] = clamp255(output[index + 1] * 255);
    finalData[index + 2] = clamp255(output[index + 2] * 255);
    finalData[index + 3] = clamp255(output[index + 3] * 255);
  }
  return new ImageData(finalData, sourceData.width, sourceData.height);
}

export function applyFilterFloat32(
  sourceData: ImageData,
  filterName: string,
  manualAdjustments: Partial<Adjustments> = defaultAdjustments,
  options: { strength?: number; effectIntensity?: number; quality?: "preview" | "export"; analysis?: ImageAnalysis | null; adaptToScene?: boolean } = {},
): ImageData {
  return applyFilterFloat32Internal(sourceData, filterName, manualAdjustments, options);
}

// Re-export the resolved settings shape so the public surface area of
// `applyFilterFloat32` mirrors `applyFilterToImageData`. Kept narrow on
// purpose: only the bits the export path actually needs.
export type Float32RenderOptions = Parameters<typeof applyFilterFloat32>[3];
