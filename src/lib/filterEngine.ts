import {
  FILTER_PRESETS,
  type Adjustments,
  applyFilterToImageData,
  defaultAdjustments,
  getFilterPreset,
  type RenderOptions,
} from "./filter-engine";

export * from "./filter-engine";

export type FilterPreset = (typeof FILTER_PRESETS)[number];

type LegacyAdjustments = Partial<Adjustments> & {
  exposure?: number;
};

function normalizeAdjustments(adjustments: LegacyAdjustments): Partial<Adjustments> {
  const { exposure, ...rest } = adjustments;

  if (typeof exposure !== "number") {
    return rest;
  }

  return {
    ...rest,
    brightness: (rest.brightness ?? 0) + exposure,
  };
}

export function applyFilter(
  sourceData: ImageData,
  filterName: string,
  adjustments: LegacyAdjustments,
  _width: number,
  _height: number,
  options: RenderOptions = {},
): ImageData {
  return applyFilterToImageData(sourceData, filterName, normalizeAdjustments(adjustments), options);
}

export function generateSwatchData(
  sampleData: ImageData,
  filterName: string,
  _width: number,
  _height: number,
  options: RenderOptions = {},
): ImageData {
  const preset = getFilterPreset(filterName);
  return applyFilterToImageData(sampleData, preset.name, defaultAdjustments, {
    quality: "preview",
    strength: preset.defaultStrength * 100,
    ...options,
  });
}
