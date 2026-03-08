import React, { useEffect, useMemo, useRef } from "react";
import {
  FILTER_PRESETS,
  generateSwatchData,
  getFilterPresetById,
  type ImageAnalysis,
} from "@/lib/filterEngine";

interface FilterSidebarProps {
  activeFilter: string;
  onFilterChange: (name: string) => void;
  sourceImage: HTMLImageElement | null;
  sourceAnalysis: ImageAnalysis | null;
  recommendedPresetIds: string[];
}

const SWATCH_SIZE = 64;

const FilterSidebar: React.FC<FilterSidebarProps> = ({
  activeFilter,
  onFilterChange,
  sourceImage,
  sourceAnalysis,
  recommendedPresetIds,
}) => {
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const sampleData = useMemo(() => {
    if (!sourceImage) return null;
    const canvas = document.createElement("canvas");
    canvas.width = SWATCH_SIZE;
    canvas.height = SWATCH_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const size = Math.min(sourceImage.width, sourceImage.height);
    const sourceX = (sourceImage.width - size) / 2;
    const sourceY = (sourceImage.height - size) / 2;
    context.drawImage(sourceImage, sourceX, sourceY, size, size, 0, 0, SWATCH_SIZE, SWATCH_SIZE);
    return context.getImageData(0, 0, SWATCH_SIZE, SWATCH_SIZE);
  }, [sourceImage]);

  useEffect(() => {
    if (!sampleData) return;

    for (const preset of FILTER_PRESETS) {
      const canvas = canvasRefs.current.get(preset.name);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) continue;

      const filtered = generateSwatchData(sampleData, preset.name, SWATCH_SIZE, SWATCH_SIZE, {
        analysis: sourceAnalysis,
        quality: "preview",
        strength: preset.defaultStrength * 100,
      });
      context.putImageData(filtered, 0, 0);
    }
  }, [sampleData, sourceAnalysis]);

  const recommendedPresets = useMemo(
    () => recommendedPresetIds.map((presetId) => getFilterPresetById(presetId)),
    [recommendedPresetIds],
  );

  const categories = useMemo(() => {
    const grouped = new Map<string, typeof FILTER_PRESETS>();
    FILTER_PRESETS.forEach((preset) => {
      if (recommendedPresetIds.includes(preset.id)) return;
      if (!grouped.has(preset.category)) grouped.set(preset.category, []);
      grouped.get(preset.category)?.push(preset);
    });
    return grouped;
  }, [recommendedPresetIds]);

  const renderPresetCard = (presetName: string, recommended = false) => {
    const preset = FILTER_PRESETS.find((entry) => entry.name === presetName);
    if (!preset) return null;

    return (
      <button
        key={preset.name}
        onClick={() => onFilterChange(preset.name)}
        className={`filtr-filter-card group text-left ${activeFilter === preset.name ? "active" : ""}`}
      >
        <div className="relative">
          <canvas
            ref={(element) => {
              if (element) canvasRefs.current.set(preset.name, element);
            }}
            width={SWATCH_SIZE}
            height={SWATCH_SIZE}
            className="w-full aspect-square rounded-t-lg"
            style={{ imageRendering: "auto" }}
          />
          {recommended ? (
            <span className="absolute top-1 right-1 rounded-full bg-primary/90 px-1.5 py-0.5 font-mono-ui text-[8px] uppercase tracking-[0.14em] text-primary-foreground">
              Best
            </span>
          ) : null}
        </div>
        <div className="px-1.5 py-1.5 space-y-0.5">
          <span className="font-mono-ui text-[10px] text-secondary-foreground group-hover:text-primary transition-colors truncate block">
            {preset.name}
          </span>
          <span className="text-[9px] leading-tight text-muted-foreground block truncate">
            {preset.mood}
          </span>
        </div>
      </button>
    );
  };

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="space-y-1 px-1">
        <h2 className="font-display text-lg text-foreground">Filters</h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Premium presets with adaptive behavior tuned for portraits, food, lifestyle, street, and indoor scenes.
        </p>
      </div>

      {recommendedPresets.length > 0 ? (
        <div className="space-y-2">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-primary px-1">
            Recommended
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {recommendedPresets.map((preset) => renderPresetCard(preset.name, true))}
          </div>
        </div>
      ) : null}

      {Array.from(categories.entries()).map(([category, presets]) => (
        <div key={category} className="space-y-2">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
            {category}
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {presets.map((preset) => renderPresetCard(preset.name))}
          </div>
        </div>
      ))}
    </div>
  );
};

export default FilterSidebar;
