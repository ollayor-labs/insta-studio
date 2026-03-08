import type { ImageAnalysis, ImageSceneTag } from "./types";
import { clamp01, luminance, rgbToHsl } from "./utils";

function isSkinTone(r: number, g: number, b: number, hue: number, saturation: number, lightness: number): boolean {
  const channelRange = Math.max(r, g, b) - Math.min(r, g, b);
  return (
    r > 45 &&
    g > 30 &&
    b > 20 &&
    r > g &&
    r > b &&
    channelRange > 18 &&
    hue >= 5 &&
    hue <= 55 &&
    saturation >= 0.12 &&
    saturation <= 0.68 &&
    lightness >= 0.18 &&
    lightness <= 0.88
  );
}

export function analyzeImageData(sourceData: ImageData): ImageAnalysis {
  const { width, height, data } = sourceData;
  const pixelCount = width * height;
  const sampleStride = Math.max(1, Math.floor(Math.sqrt(pixelCount / 64000)));

  let samples = 0;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let saturationSum = 0;
  let warmthSum = 0;
  let highlightCount = 0;
  let shadowCount = 0;
  let skinCount = 0;
  let blueGreenCount = 0;
  let warmIndoorCount = 0;

  for (let y = 0; y < height; y += sampleStride) {
    for (let x = 0; x < width; x += sampleStride) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const lum = luminance(r, g, b);
      const [hue, saturation, lightness] = rgbToHsl(r, g, b);

      samples += 1;
      luminanceSum += lum;
      luminanceSquaredSum += lum * lum;
      saturationSum += saturation;
      warmthSum += (r - b) / 255;

      if (lum > 0.94) highlightCount += 1;
      if (lum < 0.06) shadowCount += 1;
      if (isSkinTone(r, g, b, hue, saturation, lightness)) skinCount += 1;

      if ((b > r * 1.03 || g > r * 1.03) && saturation > 0.18) blueGreenCount += 1;
      if (r > b * 1.12 && lum < 0.62) warmIndoorCount += 1;
    }
  }

  const averageLuminance = luminanceSum / samples;
  const luminanceVariance = Math.max(0, luminanceSquaredSum / samples - averageLuminance ** 2);
  const luminanceStdDev = Math.sqrt(luminanceVariance);
  const averageSaturation = saturationSum / samples;
  const warmth = warmthSum / samples;
  const highlightClipping = highlightCount / samples;
  const shadowClipping = shadowCount / samples;
  const portraitLikelihood = clamp01(skinCount / samples * 5.2);
  const outdoorLikelihood = clamp01(blueGreenCount / samples * 1.8 + averageLuminance * 0.35 - warmth * 0.15);
  const indoorLikelihood = clamp01(warmIndoorCount / samples * 2 + (1 - outdoorLikelihood) * 0.35);
  const brightLikelihood = clamp01((averageLuminance - 0.52) * 2 + highlightClipping * 0.6);
  const lowLightLikelihood = clamp01((0.42 - averageLuminance) * 2.2 + shadowClipping * 1.3);
  const colorfulLikelihood = clamp01((averageSaturation - 0.28) * 2.1);
  const flatLikelihood = clamp01((0.18 - luminanceStdDev) * 3 + (0.24 - averageSaturation) * 1.4);
  const overexposedLikelihood = clamp01(highlightClipping * 2.4 + Math.max(0, averageLuminance - 0.72) * 1.6);
  const underexposedLikelihood = clamp01(shadowClipping * 2.2 + Math.max(0, 0.3 - averageLuminance) * 2);
  const dynamicRange = clamp01(luminanceStdDev * 2.8 + (1 - highlightClipping - shadowClipping) * 0.15);

  const sceneTags: ImageSceneTag[] = [];
  if (portraitLikelihood > 0.42) sceneTags.push("portrait");
  if (indoorLikelihood > 0.5) sceneTags.push("indoor");
  if (outdoorLikelihood > 0.5) sceneTags.push("outdoor");
  if (brightLikelihood > 0.52) sceneTags.push("bright");
  if (lowLightLikelihood > 0.5) sceneTags.push("lowLight");
  if (colorfulLikelihood > 0.52) sceneTags.push("colorful");
  if (flatLikelihood > 0.52) sceneTags.push("flat");
  if (overexposedLikelihood > 0.45) sceneTags.push("overexposed");
  if (underexposedLikelihood > 0.45) sceneTags.push("underexposed");

  if (portraitLikelihood > 0.42 && colorfulLikelihood > 0.4) sceneTags.push("lifestyle");
  if (outdoorLikelihood > 0.45 && dynamicRange > 0.3) sceneTags.push("street");
  if (averageSaturation > 0.35 && warmth > 0.04) sceneTags.push("food");

  return {
    width,
    height,
    pixelCount,
    averageLuminance,
    luminanceStdDev,
    dynamicRange,
    averageSaturation,
    warmth,
    highlightClipping,
    shadowClipping,
    portraitLikelihood,
    indoorLikelihood,
    outdoorLikelihood,
    brightLikelihood,
    lowLightLikelihood,
    colorfulLikelihood,
    flatLikelihood,
    overexposedLikelihood,
    underexposedLikelihood,
    sceneTags,
  };
}
