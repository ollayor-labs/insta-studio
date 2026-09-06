import React, { useEffect, useMemo, useRef } from "react";
import type { FavoritesMap, FavoriteSlot } from "@/lib/filterEngine";
import { Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cuePressRelease } from "@/lib/sound/sound-cues";
import {
  customPresetsToDefinitions,
  FILTER_PRESETS,
  generateSwatchData,
  type CustomPresetRecord,
  type ImageAnalysis,
} from "@/lib/filterEngine";

interface FilterSidebarProps {
  activeFilter: string;
  onFilterChange: (name: string) => void;
  sourceImage: HTMLImageElement | null;
  sourceAnalysis: ImageAnalysis | null;
  recommendedPresetIds: string[];
  customPresets: CustomPresetRecord[];
  onDeleteCustomPreset: (presetId: string) => void;
  layout?: "grid" | "strip";
  swatchSize?: number;
  favorites?: FavoritesMap;
  onToggleFavorite?: (presetId: string, currentSlot: FavoriteSlot | undefined) => void;
}

const DEFAULT_SWATCH_SIZE = 40;

const FilterSidebar: React.FC<FilterSidebarProps> = ({
  activeFilter,
  onFilterChange,
  sourceImage,
  sourceAnalysis,
  recommendedPresetIds,
  customPresets,
  onDeleteCustomPreset,
  layout = "grid",
  swatchSize = DEFAULT_SWATCH_SIZE,
  favorites = {},
  onToggleFavorite,
}) => {
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const customDefinitions = useMemo(
    () => customPresetsToDefinitions(customPresets),
    [customPresets],
  );

  const sampleData = useMemo(() => {
    if (!sourceImage) return null;
    const canvas = document.createElement("canvas");
    canvas.width = swatchSize;
    canvas.height = swatchSize;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const size = Math.min(sourceImage.width, sourceImage.height);
    const sourceX = (sourceImage.width - size) / 2;
    const sourceY = (sourceImage.height - size) / 2;
    context.drawImage(sourceImage, sourceX, sourceY, size, size, 0, 0, swatchSize, swatchSize);
    return context.getImageData(0, 0, swatchSize, swatchSize);
  }, [sourceImage, swatchSize]);

  useEffect(() => {
    if (!sampleData) return;

    for (const preset of [...FILTER_PRESETS, ...customDefinitions]) {
      const canvas = canvasRefs.current.get(preset.name);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) continue;

      const filtered = generateSwatchData(sampleData, preset.name, swatchSize, swatchSize, {
        analysis: sourceAnalysis,
        quality: "preview",
        strength: preset.defaultStrength * 100,
      });
      context.putImageData(filtered, 0, 0);
    }
  }, [sampleData, sourceAnalysis, swatchSize, customDefinitions]);

  const recommendedPresetIdSet = useMemo(
    () => new Set(recommendedPresetIds),
    [recommendedPresetIds],
  );

  const categories = useMemo(() => {
    const grouped = new Map<string, typeof FILTER_PRESETS>();
    FILTER_PRESETS.forEach((preset) => {
      if (!grouped.has(preset.category)) grouped.set(preset.category, []);
      grouped.get(preset.category)?.push(preset);
    });
    return grouped;
  }, []);

  const findFavoriteSlot = (presetId: string): FavoriteSlot | undefined => {
    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      if (favorites[slot] === presetId) return slot;
    }
    return undefined;
  };

  const renderPresetCard = (presetName: string, deletable = false, onDelete?: () => void) => {
    const preset = [...FILTER_PRESETS, ...customDefinitions].find((entry) => entry.name === presetName);
    if (!preset) return null;
    const favoriteSlot = findFavoriteSlot(preset.id);
    const isRecommended = recommendedPresetIdSet.has(preset.id);

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.shiftKey && onToggleFavorite) {
        event.preventDefault();
        onToggleFavorite(preset.id, favoriteSlot);
        return;
      }
      onFilterChange(preset.name);
    };

    return (
      <div
        key={preset.name}
        className={`filtr-filter-card group text-left relative ${layout === "strip" ? "w-24 shrink-0" : ""} ${
          activeFilter === preset.name ? "active" : ""
        }`}
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex w-full flex-col text-left"
          {...cuePressRelease}
        >
          <div className="relative">
            <canvas
              ref={(element) => {
                if (element) canvasRefs.current.set(preset.name, element);
              }}
              width={swatchSize}
              height={swatchSize}
              className="w-full aspect-square rounded-t-lg"
            />
            {favoriteSlot ? (
              <span
                className="absolute top-1 left-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/90 font-mono-ui text-[10px] font-semibold text-primary-foreground shadow-sm"
                title={`Favorite slot ${favoriteSlot} — press ${favoriteSlot} to apply`}
              >
                {favoriteSlot}
              </span>
            ) : null}
            {deletable ? (
              <span
                className={`absolute top-1 ${favoriteSlot ? "left-7" : "left-1"} rounded-full bg-secondary/90 px-1.5 py-0.5 font-mono-ui text-[8px] uppercase tracking-[0.14em] text-secondary-foreground`}
              >
                Custom
              </span>
            ) : null}
          </div>
          <div className="px-1.5 py-1.5 space-y-0.5">
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1 min-w-0">
                  {isRecommended ? (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    />
                  ) : null}
                  <span className="flex-1 min-w-0 truncate font-mono-ui text-[10px] text-secondary-foreground group-hover:text-primary transition-colors">
                    {preset.name}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                className="max-w-[13rem] border-border bg-popover p-2.5 text-foreground"
              >
                <p className="font-mono-ui text-[11px] text-foreground">{preset.name}</p>
                {isRecommended ? (
                  <p className="mt-0.5 font-mono-ui text-[9px] uppercase tracking-[0.12em] text-primary">
                    Recommended for this photo
                  </p>
                ) : null}
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{preset.mood}</p>
                {onToggleFavorite ? (
                  <p className="mt-1 text-[9px] leading-snug text-muted-foreground/80">
                    Shift-click to {favoriteSlot ? "remove from" : "add to"} favorites
                  </p>
                ) : null}
              </TooltipContent>
            </Tooltip>
            <span className="text-[9px] leading-tight text-muted-foreground block truncate">
              {preset.mood}
            </span>
          </div>
        </button>
        {deletable && onDelete ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            aria-label={`Delete preset ${preset.name}`}
            className="absolute bottom-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/85 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            {...cuePressRelease}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className={`w-full ${layout === "grid" ? "h-full overflow-y-auto p-3 space-y-4" : "space-y-3"}`}>
      {layout === "strip" ? (
        <div className="space-y-2 px-2 pb-1">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            Filters
          </p>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {FILTER_PRESETS.map((preset) => renderPresetCard(preset.name))}
            {customDefinitions.map((preset, index) =>
              renderPresetCard(
                preset.name,
                true,
                () => onDeleteCustomPreset(customPresets[index].id),
              ),
            )}
          </div>
        </div>
      ) : null}
      {layout === "strip" ? null : (
        <>
          <div className="space-y-1 px-1">
            <h2 className="font-display text-lg text-foreground">Filters</h2>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Premium presets with adaptive behavior tuned for portraits, food, lifestyle, street, and indoor scenes.
            </p>
          </div>

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

          {customDefinitions.length > 0 ? (
            <div className="space-y-2">
              <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
                Custom
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {customDefinitions.map((preset, index) =>
                  renderPresetCard(
                    preset.name,
                    true,
                    () => onDeleteCustomPreset(customPresets[index].id),
                  ),
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

export default FilterSidebar;
