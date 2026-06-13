// sRGB ↔ linear ↔ Lab helpers shared by the Uint8 and Float32 pipelines.
// Extracted so the two paths do identical color math — otherwise the
// Float32 path drifts in subtle ways (the export path is the one that
// should be lossless).

export interface LabColor {
  l: number;
  a: number;
  b: number;
}

export function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(channel: number): number {
  const value = channel < 0 ? 0 : channel > 1 ? 1 : channel;
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  const rounded = Math.round(encoded * 255);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

export function rgbToLab(r: number, g: number, b: number): LabColor {
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

export function labToRgb(lab: LabColor): [number, number, number] {
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

// Float-space versions: inputs are 0..1 floats, outputs are 0..1 floats.
// These are what the Float32 export pipeline uses so the export path
// matches the Uint8 preview *modulo* the float-vs-uint8 quantize at the
// end of the pipeline. They share the sRGB EOTF / Lab transform with the
// helpers above — only the input range differs.

export function srgbToLinearFloat(channel: number): number {
  const value = channel < 0 ? 0 : channel > 1 ? 1 : channel;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgbFloat(channel: number): number {
  const value = channel < 0 ? 0 : channel > 1 ? 1 : channel;
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return encoded < 0 ? 0 : encoded > 1 ? 1 : encoded;
}

export function rgbToLabFloat(r: number, g: number, b: number): LabColor {
  const lr = srgbToLinearFloat(r);
  const lg = srgbToLinearFloat(g);
  const lb = srgbToLinearFloat(b);

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

export function labToRgbFloat(lab: LabColor): [number, number, number] {
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

  return [linearToSrgbFloat(lr), linearToSrgbFloat(lg), linearToSrgbFloat(lb)];
}
