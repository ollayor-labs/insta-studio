import { adjustmentKeys, type Adjustments, type ToneCurve } from "./types";

export function clamp(value: number, min = 0, max = 255): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

export function mixToward(current: number, target: number, amount: number): number {
  return current + (target - current) * amount;
}

export function luminance(r: number, g: number, b: number): number {
  return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
}

export function clampAdjustment(key: keyof Adjustments, value: number): number {
  if (key === "grain" || key === "vignette" || key === "fade" || key === "bloom") {
    return clamp(value, 0, 100);
  }
  return clamp(value, -100, 100);
}

export function addAdjustments(
  base: Adjustments,
  delta: Partial<Adjustments>,
): Adjustments {
  const result = { ...base };
  for (const key of adjustmentKeys) {
    result[key] = clampAdjustment(key, base[key] + (delta[key] ?? 0));
  }
  return result;
}

export function scaleAdjustments(
  source: Partial<Adjustments>,
  amount: number,
): Partial<Adjustments> {
  const result: Partial<Adjustments> = {};
  for (const key of adjustmentKeys) {
    const value = source[key];
    if (value === undefined) continue;
    result[key] = value * amount;
  }
  return result;
}

export function buildCurveLut(points?: number[]): Uint8Array | null {
  if (!points || points.length < 2) return null;

  const lut = new Uint8Array(256);
  const pointCount = points.length;

  for (let index = 0; index < 256; index += 1) {
    const position = (index / 255) * (pointCount - 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, pointCount - 1);
    const fraction = position - leftIndex;
    const value = lerp(points[leftIndex], points[rightIndex], fraction);
    lut[index] = clamp(Math.round(value));
  }

  return lut;
}

export function blendCurve(points: number[] | undefined, amount: number): number[] | undefined {
  if (!points || points.length < 2) return points;

  return points.map((value, index) => {
    const identity = (index / (points.length - 1)) * 255;
    return lerp(identity, value, amount);
  });
}

export function scaleCurve(curve: ToneCurve | undefined, amount: number): ToneCurve | undefined {
  if (!curve) return undefined;

  return {
    master: blendCurve(curve.master, amount),
    r: blendCurve(curve.r, amount),
    g: blendCurve(curve.g, amount),
    b: blendCurve(curve.b, amount),
  };
}

export function hashNoise(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const lightness = (max + min) / 2;

  if (max === min) {
    return [0, 0, lightness];
  }

  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === nr) hue = (ng - nb) / delta + (ng < nb ? 6 : 0);
  else if (max === ng) hue = (nb - nr) / delta + 2;
  else hue = (nr - ng) / delta + 4;

  return [(hue / 6) * 360, saturation, lightness];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const saturation = clamp01(s);
  const lightness = clamp01(l);

  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return [value, value, value];
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  const hueToChannel = (offset: number) => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  return [
    Math.round(hueToChannel(1 / 3) * 255),
    Math.round(hueToChannel(0) * 255),
    Math.round(hueToChannel(-1 / 3) * 255),
  ];
}

export function hueDistance(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

export function createIdentityCurve(pointCount: number): number[] {
  return Array.from({ length: pointCount }, (_, index) => (index / (pointCount - 1)) * 255);
}

export function boxBlurGray(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return source.slice();

  const windowSize = radius * 2 + 1;
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const rowOffset = y * width;

    for (let index = -radius; index <= radius; index += 1) {
      const sampleX = clamp(index, 0, width - 1);
      sum += source[rowOffset + sampleX];
    }

    for (let x = 0; x < width; x += 1) {
      horizontal[rowOffset + x] = sum / windowSize;

      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      sum += source[rowOffset + addX] - source[rowOffset + removeX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;

    for (let index = -radius; index <= radius; index += 1) {
      const sampleY = clamp(index, 0, height - 1);
      sum += horizontal[sampleY * width + x];
    }

    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / windowSize;

      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }

  return output;
}
