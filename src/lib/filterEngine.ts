// FILTR — Canvas-based pixel manipulation engine

export interface Adjustments {
  exposure: number;      // -100 to 100
  contrast: number;      // -100 to 100
  highlights: number;    // -100 to 100
  shadows: number;       // -100 to 100
  saturation: number;    // -100 to 100
  temperature: number;   // -100 to 100
  tint: number;          // -100 to 100
  clarity: number;       // 0 to 100
  grain: number;         // 0 to 100
  vignette: number;      // 0 to 100
  fade: number;          // 0 to 100
}

export const defaultAdjustments: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, tint: 0, clarity: 0,
  grain: 0, vignette: 0, fade: 0,
};

export interface FilterPreset {
  name: string;
  category: string;
  adjustments: Partial<Adjustments>;
  // Advanced color grading
  curves?: { r: number[]; g: number[]; b: number[] };
  splitTone?: { shadowHue: number; shadowSat: number; highlightHue: number; highlightSat: number };
  hslShift?: { hueShift: number; satMul: number; lumShift: number };
  liftGamma?: { lift: [number, number, number]; gamma: [number, number, number] };
}

export const FILTER_PRESETS: FilterPreset[] = [
  // Aesthetic / Film
  {
    name: "Original", category: "None",
    adjustments: {},
  },
  {
    name: "Kodak Gold", category: "Aesthetic / Film",
    adjustments: { exposure: 8, contrast: -5, highlights: -10, shadows: 20, saturation: 15, temperature: 25, grain: 15, fade: 8 },
    splitTone: { shadowHue: 40, shadowSat: 25, highlightHue: 45, highlightSat: 15 },
    hslShift: { hueShift: 5, satMul: 1.1, lumShift: 3 },
  },
  {
    name: "Portra 400", category: "Aesthetic / Film",
    adjustments: { exposure: 5, contrast: -8, highlights: -5, shadows: 15, saturation: -5, temperature: 8, grain: 10, fade: 5 },
    splitTone: { shadowHue: 200, shadowSat: 8, highlightHue: 35, highlightSat: 10 },
    hslShift: { hueShift: 0, satMul: 0.95, lumShift: 2 },
  },
  {
    name: "Tri-X", category: "Aesthetic / Film",
    adjustments: { exposure: 3, contrast: 35, highlights: 10, shadows: -15, saturation: -100, grain: 35, fade: 3 },
    hslShift: { hueShift: 0, satMul: 0, lumShift: 0 },
  },
  {
    name: "Velvia", category: "Aesthetic / Film",
    adjustments: { exposure: 2, contrast: 20, highlights: 5, shadows: -20, saturation: 40, temperature: 5, grain: 5 },
    hslShift: { hueShift: -3, satMul: 1.35, lumShift: -3 },
  },
  // Minimal / Clean
  {
    name: "Studio", category: "Minimal / Clean",
    adjustments: { exposure: 5, contrast: 5, highlights: 15, shadows: 5, saturation: -20, temperature: -8, clarity: 20 },
    hslShift: { hueShift: 0, satMul: 0.8, lumShift: 5 },
  },
  {
    name: "Nordic", category: "Minimal / Clean",
    adjustments: { exposure: 15, contrast: -15, highlights: 20, shadows: 25, saturation: -25, temperature: -15, fade: 20 },
    splitTone: { shadowHue: 210, shadowSat: 15, highlightHue: 200, highlightSat: 5 },
  },
  {
    name: "Tokyo Flat", category: "Minimal / Clean",
    adjustments: { exposure: 10, contrast: -20, highlights: 10, shadows: 20, saturation: -15, temperature: -5, tint: 5, fade: 15 },
    hslShift: { hueShift: 10, satMul: 0.85, lumShift: 8 },
  },
  // Cinematic / Moody
  {
    name: "Noir", category: "Cinematic / Moody",
    adjustments: { exposure: -5, contrast: 40, highlights: -10, shadows: -30, saturation: -100, vignette: 40, grain: 10 },
    hslShift: { hueShift: 0, satMul: 0, lumShift: -5 },
  },
  {
    name: "Golden Hour", category: "Cinematic / Moody",
    adjustments: { exposure: 8, contrast: 10, highlights: -5, shadows: 15, saturation: 10, temperature: 30, fade: 10, vignette: 15 },
    splitTone: { shadowHue: 190, shadowSat: 20, highlightHue: 35, highlightSat: 25 },
  },
  {
    name: "Fog", category: "Cinematic / Moody",
    adjustments: { exposure: 10, contrast: -30, highlights: 25, shadows: 30, saturation: -15, temperature: -10, fade: 25, vignette: 10 },
    splitTone: { shadowHue: 210, shadowSat: 10, highlightHue: 200, highlightSat: 8 },
  },
  // Modern Instagram
  {
    name: "Presetless", category: "Modern Instagram",
    adjustments: { exposure: 3, contrast: 8, highlights: -5, shadows: 5, saturation: 5, temperature: 8, clarity: 30 },
  },
  {
    name: "Fade Film", category: "Modern Instagram",
    adjustments: { exposure: 5, contrast: -10, highlights: 10, shadows: 15, saturation: -10, temperature: -5, fade: 20 },
    splitTone: { shadowHue: 220, shadowSat: 12, highlightHue: 30, highlightSat: 8 },
  },
  {
    name: "Vibrant", category: "Modern Instagram",
    adjustments: { exposure: 5, contrast: 10, saturation: 30, clarity: 25, vignette: 15 },
    hslShift: { hueShift: 0, satMul: 1.25, lumShift: 2 },
  },
  {
    name: "Dreamy", category: "Modern Instagram",
    adjustments: { exposure: 10, contrast: -15, highlights: 15, shadows: 20, saturation: -10, temperature: 5, fade: 15, vignette: 20 },
    hslShift: { hueShift: 8, satMul: 0.9, lumShift: 5 },
  },
];

// Clamp helper
function clamp(v: number, min = 0, max = 255): number {
  return v < min ? min : v > max ? max : v;
}

// Build a curves LUT (256 entries) from control points
function buildCurveLUT(points: number[]): Uint8Array {
  const lut = new Uint8Array(256);
  // Simple linear interpolation between evenly spaced points
  const n = points.length;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (n - 1);
    const idx = Math.floor(t);
    const frac = t - idx;
    const v0 = points[Math.min(idx, n - 1)];
    const v1 = points[Math.min(idx + 1, n - 1)];
    lut[i] = clamp(Math.round(v0 + frac * (v1 - v0)));
  }
  return lut;
}

// Seeded pseudo-random for grain
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// RGB to HSL
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

// HSL to RGB
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  h /= 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

export function applyFilter(
  sourceData: ImageData,
  filterName: string,
  adjustments: Adjustments,
  width: number,
  height: number
): ImageData {
  const preset = FILTER_PRESETS.find(f => f.name === filterName);
  
  // Merge preset adjustments with manual adjustments
  const adj: Adjustments = { ...defaultAdjustments };
  if (preset?.adjustments) {
    for (const key of Object.keys(preset.adjustments) as (keyof Adjustments)[]) {
      adj[key] = (preset.adjustments[key] ?? 0);
    }
  }
  // Manual overrides add on top
  for (const key of Object.keys(adjustments) as (keyof Adjustments)[]) {
    adj[key] += adjustments[key];
  }

  const data = new Uint8ClampedArray(sourceData.data);
  const len = data.length;
  
  // Build curves LUT if preset has curves
  let rLUT: Uint8Array | null = null;
  let gLUT: Uint8Array | null = null;
  let bLUT: Uint8Array | null = null;
  if (preset?.curves) {
    rLUT = buildCurveLUT(preset.curves.r);
    gLUT = buildCurveLUT(preset.curves.g);
    bLUT = buildCurveLUT(preset.curves.b);
  }

  // Pre-calculate factors
  const exposureFactor = Math.pow(2, adj.exposure / 50);
  const contrastFactor = (259 * (adj.contrast * 2.55 + 255)) / (255 * (259 - adj.contrast * 2.55));
  const satFactor = 1 + adj.saturation / 100;
  const tempShift = adj.temperature * 0.8;
  const tintShift = adj.tint * 0.5;
  const fadeAmount = adj.fade / 100;
  const clarityAmount = adj.clarity / 100;
  
  // HSL shift from preset
  const hueShift = preset?.hslShift?.hueShift ?? 0;
  const satMul = preset?.hslShift?.satMul ?? 1;
  const lumShift = (preset?.hslShift?.lumShift ?? 0) / 100;

  // Grain
  const grainAmount = adj.grain;
  const rng = grainAmount > 0 ? seededRandom(42) : null;

  // Vignette params
  const vigAmount = adj.vignette / 100;
  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  // Split tone params
  const st = preset?.splitTone;

  for (let i = 0; i < len; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // Exposure
    r = clamp(r * exposureFactor);
    g = clamp(g * exposureFactor);
    b = clamp(b * exposureFactor);

    // Contrast
    r = clamp(contrastFactor * (r - 128) + 128);
    g = clamp(contrastFactor * (g - 128) + 128);
    b = clamp(contrastFactor * (b - 128) + 128);

    // Highlights & Shadows
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    if (lum > 0.5 && adj.highlights !== 0) {
      const t = (lum - 0.5) * 2;
      const shift = adj.highlights * t * 0.5;
      r = clamp(r + shift);
      g = clamp(g + shift);
      b = clamp(b + shift);
    }
    if (lum < 0.5 && adj.shadows !== 0) {
      const t = (0.5 - lum) * 2;
      const shift = adj.shadows * t * 0.5;
      r = clamp(r + shift);
      g = clamp(g + shift);
      b = clamp(b + shift);
    }

    // Temperature (warm = more red/yellow, cool = more blue)
    if (tempShift !== 0) {
      r = clamp(r + tempShift);
      g = clamp(g + tempShift * 0.4);
      b = clamp(b - tempShift);
    }

    // Tint (green/magenta)
    if (tintShift !== 0) {
      g = clamp(g + tintShift);
      r = clamp(r - tintShift * 0.3);
      b = clamp(b - tintShift * 0.3);
    }

    // Apply curves LUT
    if (rLUT && gLUT && bLUT) {
      r = rLUT[Math.round(r)];
      g = gLUT[Math.round(g)];
      b = bLUT[Math.round(b)];
    }

    // HSL manipulation
    if (satFactor !== 1 || hueShift !== 0 || satMul !== 1 || lumShift !== 0) {
      let [h, s, l] = rgbToHsl(r, g, b);
      h += hueShift;
      s = Math.min(1, Math.max(0, s * satFactor * satMul));
      l = Math.min(1, Math.max(0, l + lumShift));
      [r, g, b] = hslToRgb(h, s, l);
    }

    // Split toning
    if (st) {
      const lumVal = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      if (lumVal < 0.5 && st.shadowSat > 0) {
        const t = (0.5 - lumVal) * 2 * (st.shadowSat / 100);
        const [sr, sg, sb] = hslToRgb(st.shadowHue, 0.5, 0.5);
        r = clamp(r + (sr - 128) * t);
        g = clamp(g + (sg - 128) * t);
        b = clamp(b + (sb - 128) * t);
      }
      if (lumVal > 0.5 && st.highlightSat > 0) {
        const t = (lumVal - 0.5) * 2 * (st.highlightSat / 100);
        const [hr, hg, hb] = hslToRgb(st.highlightHue, 0.5, 0.5);
        r = clamp(r + (hr - 128) * t);
        g = clamp(g + (hg - 128) * t);
        b = clamp(b + (hb - 128) * t);
      }
    }

    // Fade (lift black point)
    if (fadeAmount > 0) {
      const lift = fadeAmount * 40;
      r = clamp(r + (lift - r * fadeAmount * 0.15));
      g = clamp(g + (lift - g * fadeAmount * 0.15));
      b = clamp(b + (lift - b * fadeAmount * 0.15));
    }

    // Clarity (local contrast via unsharp-mask approximation — simplified)
    if (clarityAmount > 0) {
      const gray = r * 0.299 + g * 0.587 + b * 0.114;
      const boost = (gray - 128) * clarityAmount * 0.4;
      r = clamp(r + boost);
      g = clamp(g + boost);
      b = clamp(b + boost);
    }

    // Grain
    if (grainAmount > 0 && rng) {
      const noise = (rng() - 0.5) * grainAmount * 1.5;
      r = clamp(r + noise);
      g = clamp(g + noise);
      b = clamp(b + noise);
    }

    // Vignette
    if (vigAmount > 0) {
      const px = (i / 4) % width;
      const py = Math.floor((i / 4) / width);
      const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) / maxDist;
      const vig = 1 - dist * dist * vigAmount * 1.5;
      r = clamp(r * vig);
      g = clamp(g * vig);
      b = clamp(b * vig);
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  return new ImageData(data, width, height);
}

// Generate a tiny swatch preview of a filter
export function generateSwatchData(
  sampleData: ImageData,
  filterName: string,
  width: number,
  height: number
): ImageData {
  return applyFilter(sampleData, filterName, defaultAdjustments, width, height);
}
