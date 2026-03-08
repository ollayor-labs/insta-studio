import React, { useEffect, useRef, useMemo } from "react";
import { FILTER_PRESETS, generateSwatchData, defaultAdjustments } from "@/lib/filterEngine";

interface FilterSidebarProps {
  activeFilter: string;
  onFilterChange: (name: string) => void;
  sourceImage: HTMLImageElement | null;
}

const SWATCH_SIZE = 64;

const FilterSidebar: React.FC<FilterSidebarProps> = ({ activeFilter, onFilterChange, sourceImage }) => {
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Generate sample image data from source
  const sampleData = useMemo(() => {
    if (!sourceImage) return null;
    const canvas = document.createElement("canvas");
    canvas.width = SWATCH_SIZE;
    canvas.height = SWATCH_SIZE;
    const ctx = canvas.getContext("2d")!;
    // Center crop
    const size = Math.min(sourceImage.width, sourceImage.height);
    const sx = (sourceImage.width - size) / 2;
    const sy = (sourceImage.height - size) / 2;
    ctx.drawImage(sourceImage, sx, sy, size, size, 0, 0, SWATCH_SIZE, SWATCH_SIZE);
    return ctx.getImageData(0, 0, SWATCH_SIZE, SWATCH_SIZE);
  }, [sourceImage]);

  useEffect(() => {
    if (!sampleData) return;
    FILTER_PRESETS.forEach((preset) => {
      const canvas = canvasRefs.current.get(preset.name);
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const filtered = generateSwatchData(sampleData, preset.name, SWATCH_SIZE, SWATCH_SIZE);
      ctx.putImageData(filtered, 0, 0);
    });
  }, [sampleData]);

  // Group by category
  const categories = useMemo(() => {
    const map = new Map<string, typeof FILTER_PRESETS>();
    FILTER_PRESETS.forEach((p) => {
      const cat = p.category;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    });
    return map;
  }, []);

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <h2 className="font-display text-lg text-foreground px-1">Filters</h2>
      {Array.from(categories.entries()).map(([category, presets]) => (
        <div key={category} className="space-y-2">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
            {category === "None" ? "" : category}
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.name}
                onClick={() => onFilterChange(preset.name)}
                className={`filtr-filter-card group ${activeFilter === preset.name ? "active" : ""}`}
              >
                <canvas
                  ref={(el) => { if (el) canvasRefs.current.set(preset.name, el); }}
                  width={SWATCH_SIZE}
                  height={SWATCH_SIZE}
                  className="w-full aspect-square rounded-t-lg"
                  style={{ imageRendering: "auto" }}
                />
                <div className="px-1.5 py-1.5">
                  <span className="font-mono-ui text-[10px] text-secondary-foreground group-hover:text-primary transition-colors truncate block">
                    {preset.name}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

export default FilterSidebar;
