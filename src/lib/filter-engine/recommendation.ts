import { FILTER_PRESETS } from "./presets";
import type { ImageAnalysis, ImageSceneTag, PresetRecommendation } from "./types";
import { clamp01 } from "./utils";

const metricResolvers: Record<ImageSceneTag, (analysis: ImageAnalysis) => number> = {
  portrait: (analysis) => analysis.portraitLikelihood,
  food: (analysis) => clamp01(analysis.averageSaturation * 1.3 + analysis.warmth * 0.6),
  lifestyle: (analysis) => clamp01(analysis.portraitLikelihood * 0.45 + analysis.colorfulLikelihood * 0.35 + analysis.brightLikelihood * 0.2),
  street: (analysis) => clamp01(analysis.dynamicRange * 0.45 + analysis.lowLightLikelihood * 0.35 + analysis.outdoorLikelihood * 0.2),
  indoor: (analysis) => analysis.indoorLikelihood,
  outdoor: (analysis) => analysis.outdoorLikelihood,
  bright: (analysis) => analysis.brightLikelihood,
  lowLight: (analysis) => analysis.lowLightLikelihood,
  colorful: (analysis) => analysis.colorfulLikelihood,
  flat: (analysis) => analysis.flatLikelihood,
  overexposed: (analysis) => analysis.overexposedLikelihood,
  underexposed: (analysis) => analysis.underexposedLikelihood,
};

function reasonForTag(tag: ImageSceneTag): string {
  switch (tag) {
    case "portrait":
      return "strong skin-tone presence";
    case "food":
      return "warm, saturated subject colors";
    case "lifestyle":
      return "balanced portrait and scene color";
    case "street":
      return "urban contrast and ambient depth";
    case "indoor":
      return "indoor color balance";
    case "outdoor":
      return "outdoor light and separation";
    case "bright":
      return "bright highlight-heavy scene";
    case "lowLight":
      return "low-light exposure profile";
    case "colorful":
      return "already-colorful source";
    case "flat":
      return "flat low-contrast source";
    case "overexposed":
      return "highlight recovery need";
    case "underexposed":
      return "shadow recovery need";
  }
}

export function recommendPresets(
  analysis: ImageAnalysis | null,
  limit = 3,
): PresetRecommendation[] {
  if (!analysis) return [];

  return FILTER_PRESETS.filter((preset) => preset.id !== "original")
    .map((preset) => {
      const affinityEntries = Object.entries(preset.sceneAffinity ?? {}) as [ImageSceneTag, number][];
      const reasons: string[] = [];
      let score = 0;

      for (const [tag, weight] of affinityEntries) {
        const contribution = metricResolvers[tag](analysis) * weight;
        score += contribution;

        if (contribution > 0.35) {
          reasons.push(reasonForTag(tag));
        }
      }

      if (preset.tags.includes("portrait")) score += analysis.portraitLikelihood * 0.35;
      if (preset.tags.includes("night") && analysis.lowLightLikelihood > 0.58) score += 0.08;
      if (preset.tags.includes("clean") && analysis.overexposedLikelihood > 0.45) score += 0.05;

      return {
        presetId: preset.id,
        score,
        reasons: reasons.slice(0, 2),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
