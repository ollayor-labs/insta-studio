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

export interface ImageAnalysis {
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

export interface RenderOptions {
  strength?: number;
  quality?: RenderQuality;
  analysis?: ImageAnalysis | null;
  adaptToScene?: boolean;
}

export interface ResolvedFilterSettings {
  preset: FilterPresetDefinition;
  strength: number;
  quality: RenderQuality;
  analysis: ImageAnalysis | null;
  adjustments: Adjustments;
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
