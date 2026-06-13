export type RenderQuality = "preview" | "export";

export type ImageSceneTag =
  | "portrait"
  | "food"
  | "lifestyle"
  | "street"
  | "indoor"
  | "outdoor"
  | "bright"
  | "lowLight"
  | "colorful"
  | "flat"
  | "overexposed"
  | "underexposed";

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  clarity: number;
  sharpness: number;
  fade: number;
  grain: number;
  vignette: number;
  bloom: number;
}

export const adjustmentKeys = [
  "brightness",
  "contrast",
  "saturation",
  "vibrance",
  "temperature",
  "tint",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "clarity",
  "sharpness",
  "fade",
  "grain",
  "vignette",
  "bloom",
] as const;

export type AdjustmentKey = (typeof adjustmentKeys)[number];

export const defaultAdjustments: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  clarity: 0,
  sharpness: 0,
  fade: 0,
  grain: 0,
  vignette: 0,
  bloom: 0,
};

export interface ToneCurve {
  master?: number[];
  r?: number[];
  g?: number[];
  b?: number[];
}

export interface SplitToneSettings {
  balance: number;
  shadows: {
    hue: number;
    saturation: number;
  };
  highlights: {
    hue: number;
    saturation: number;
  };
}

export interface HslBandAdjustment {
  label: string;
  minHue: number;
  maxHue: number;
  hueShift: number;
  saturation: number;
  lightness: number;
  softness?: number;
}

export interface AdaptiveTuning {
  portraitProtection: number;
  saturationGuard: number;
  highlightRecovery: number;
  shadowSafety: number;
  lowLightRestraint: number;
  indoorCorrection: number;
  outdoorModeration: number;
}

export interface FilterPresetDefinition {
  id: string;
  name: string;
  category: string;
  mood: string;
  description: string;
  whyItWorks: string;
  defaultStrength: number;
  tags: string[];
  adjustments: Partial<Adjustments>;
  curve?: ToneCurve;
  splitTone?: SplitToneSettings;
  hsl?: HslBandAdjustment[];
  adaptive?: Partial<AdaptiveTuning>;
  sceneAffinity?: Partial<Record<ImageSceneTag, number>>;
}

export interface Histogram {
  luminance: Uint16Array;
}

export interface ChannelHistogram {
  r: Uint16Array;
  g: Uint16Array;
  b: Uint16Array;
}

export interface ClippingChannels {
  highlight: { r: boolean; g: boolean; b: boolean };
  shadow: { r: boolean; g: boolean; b: boolean };
}

export interface ImageAnalysisFields {
  width: number;
  height: number;
  pixelCount: number;
  averageLuminance: number;
  luminanceStdDev: number;
  dynamicRange: number;
  averageSaturation: number;
  warmth: number;
  highlightClipping: number;
  shadowClipping: number;
  histogram: Histogram;
  channelHistogram: ChannelHistogram;
  clippingChannels: ClippingChannels;
  portraitLikelihood: number;
  indoorLikelihood: number;
  outdoorLikelihood: number;
  brightLikelihood: number;
  lowLightLikelihood: number;
  colorfulLikelihood: number;
  flatLikelihood: number;
  overexposedLikelihood: number;
  underexposedLikelihood: number;
  sceneTags: ImageSceneTag[];
}

export type ImageAnalysis = ImageAnalysisFields;

export type RenderPrecision = "uint8" | "float32";

export interface RenderOptions {
  strength?: number;
  effectIntensity?: number;
  quality?: RenderQuality;
  analysis?: ImageAnalysis | null;
  adaptToScene?: boolean;
  /**
   * Internal computation precision. `uint8` is the fast preview path (8-bit
   * per channel, clamped between passes). `float32` runs the full chain in
   * 0..1 floats and clamps once at the end, eliminating the per-pass
   * rounding that produces banding in smooth gradients. Default `uint8` for
   * preview, opt-in `float32` for export.
   */
  precision?: RenderPrecision;
}

export interface CurveLuts {
  master: Uint8Array | null;
  r: Uint8Array | null;
  g: Uint8Array | null;
  b: Uint8Array | null;
}

export interface ResolvedFilterSettings {
  preset: FilterPresetDefinition;
  strength: number;
  effectIntensity: number;
  quality: RenderQuality;
  precision: RenderPrecision;
  analysis: ImageAnalysis | null;
  adjustments: Adjustments;
  curveLuts: CurveLuts;
  curve?: ToneCurve;
  splitTone?: SplitToneSettings;
  hsl: HslBandAdjustment[];
}

export interface PresetRecommendation {
  presetId: string;
  score: number;
  reasons: string[];
}

export interface CustomPresetRecord {
  id: string;
  name: string;
  createdAt: string;
  basePresetId: string;
  strength: number;
  adjustments: Partial<Adjustments>;
  note?: string;
}
