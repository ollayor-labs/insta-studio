import React, { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import {
  type Adjustments,
  analyzeImageData,
  createImageDataFromImage,
  defaultAdjustments,
  FILTER_PRESETS,
  getFilterPreset,
  recommendPresets,
  type PresetRecommendation,
} from "@/lib/filterEngine";
import { showFilterChangedToast } from "@/lib/editorToasts";
import { useFilter } from "@/hooks/useFilter";
import DropZone from "@/components/DropZone";
import FilterSidebar from "@/components/FilterSidebar";
import AdjustmentsPanel from "@/components/AdjustmentsPanel";
import ImageCanvas from "@/components/ImageCanvas";
import BottomBar from "@/components/BottomBar";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    Boolean(target instanceof HTMLElement && target.isContentEditable)
  );
}

const Index = () => {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [activeFilter, setActiveFilter] = useState("Original");
  const [filterStrength, setFilterStrength] = useState(100);
  const [effectIntensity, setEffectIntensity] = useState(100);
  const [adjustments, setAdjustments] = useState<Adjustments>({ ...defaultAdjustments });
  const [imageAnalysis, setImageAnalysis] = useState<ReturnType<typeof analyzeImageData> | null>(null);
  const [recommendations, setRecommendations] = useState<PresetRecommendation[]>([]);
  const [showBefore, setShowBefore] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePosition, setComparePosition] = useState(50);
  const [zoom, setZoom] = useState(100);
  const [exportSignal, setExportSignal] = useState(0);

  const activePreset = useMemo(() => getFilterPreset(activeFilter), [activeFilter]);
  const recommendedPresetIds = useMemo(
    () => recommendations.map((recommendation) => recommendation.presetId),
    [recommendations],
  );
  const activeRecommendation = useMemo(
    () => recommendations.find((recommendation) => activePreset.id === recommendation.presetId),
    [activePreset.id, recommendations],
  );

  const { filteredImageData, sourceImageData, fullImageData, isProcessing } = useFilter({
    image,
    filterName: activeFilter,
    adjustments,
    filterStrength,
    effectIntensity,
    analysis: imageAnalysis,
    useFullResolution: zoom > 150,
  });

  const handleImageLoad = useCallback((img: HTMLImageElement, name: string) => {
    setImage(img);
    setFileName(name);
    setActiveFilter("Original");
    setFilterStrength(100);
    setEffectIntensity(100);
    setAdjustments({ ...defaultAdjustments });
    setShowBefore(false);
    setCompareMode(false);
    setComparePosition(50);
    setZoom(100);
  }, []);

  const handleAdjustmentChange = useCallback((key: keyof Adjustments, value: number) => {
    setAdjustments((previous) => ({ ...previous, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    const preset = getFilterPreset(activeFilter);
    setAdjustments({ ...defaultAdjustments });
    setFilterStrength(Math.round(preset.defaultStrength * 100));
    setEffectIntensity(100);
  }, [activeFilter]);

  const handleFilterChange = useCallback((name: string) => {
    const preset = getFilterPreset(name);
    startTransition(() => {
      setActiveFilter(name);
      setFilterStrength(Math.round(preset.defaultStrength * 100));
      setEffectIntensity(100);
      setAdjustments({ ...defaultAdjustments });
      setCompareMode(false);
    });
    showFilterChangedToast(name, Math.round(preset.defaultStrength * 100));
  }, []);

  const cycleFilter = useCallback(
    (direction: -1 | 1) => {
      const names = FILTER_PRESETS.map((preset) => preset.name);
      const currentIndex = names.indexOf(activeFilter);
      const nextName = names[(currentIndex + direction + names.length) % names.length];
      handleFilterChange(nextName);
    },
    [activeFilter, handleFilterChange],
  );

  useEffect(() => {
    if (!image) {
      setImageAnalysis(null);
      setRecommendations([]);
      return;
    }

    const analysis = analyzeImageData(createImageDataFromImage(image, 320));
    setImageAnalysis(analysis);
    setRecommendations(recommendPresets(analysis, 3));
  }, [image]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) setShowBefore(true);
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        cycleFilter(-1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        cycleFilter(1);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setExportSignal((value) => value + 1);
        return;
      }

      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        handleReset();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setShowBefore(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [cycleFilter, handleReset]);

  if (!image) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="h-14 border-b border-border flex items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-xl tracking-tight text-foreground">FILTR</h1>
            <span className="font-mono-ui text-[10px] text-muted-foreground tracking-widest uppercase">
              Photo Filter Studio
            </span>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-xl">
            <DropZone onImageLoad={handleImageLoad} />
          </div>
        </div>

        <footer className="h-10 border-t border-border flex items-center justify-center">
          <p className="font-mono-ui text-[10px] text-muted-foreground/40 tracking-wider">
            Arrow keys cycle · hold Space for original · Ctrl/Cmd+S exports · R resets
          </p>
        </footer>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-lg tracking-tight text-foreground">FILTR</h1>
          <span className="hidden sm:inline font-mono-ui text-[10px] text-muted-foreground tracking-widest uppercase">
            {fileName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono-ui text-[11px] text-primary">{activeFilter}</span>
          <button
            onClick={() => {
              setImage(null);
              setFileName("");
            }}
            className="font-mono-ui text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-4"
          >
            New Image
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="w-60 lg:w-72 border-r border-border shrink-0 overflow-hidden hidden md:block">
          <FilterSidebar
            activeFilter={activeFilter}
            onFilterChange={handleFilterChange}
            sourceImage={image}
            sourceAnalysis={imageAnalysis}
            recommendedPresetIds={recommendedPresetIds}
          />
        </div>

        <ImageCanvas
          image={image}
          filterName={activeFilter}
          sourceImageData={sourceImageData}
          filteredImageData={filteredImageData}
          showBefore={showBefore}
          compareMode={compareMode}
          comparePosition={comparePosition}
          onComparePositionChange={setComparePosition}
          zoom={zoom}
          onZoomChange={setZoom}
          isProcessing={isProcessing}
        />

        <div className="w-64 lg:w-80 border-l border-border shrink-0 overflow-hidden hidden md:block">
          <AdjustmentsPanel
            activePreset={activePreset}
            recommendation={activeRecommendation}
            adjustments={adjustments}
            filterStrength={filterStrength}
            effectIntensity={effectIntensity}
            onFilterStrengthChange={setFilterStrength}
            onEffectIntensityChange={setEffectIntensity}
            onChange={handleAdjustmentChange}
            onReset={handleReset}
          />
        </div>
      </div>

      <div className="md:hidden border-t border-border bg-card/60">
        <MobileTabs
          activeFilter={activeFilter}
          activePreset={activePreset}
          recommendation={activeRecommendation}
          filterStrength={filterStrength}
          effectIntensity={effectIntensity}
          onFilterStrengthChange={setFilterStrength}
          onEffectIntensityChange={setEffectIntensity}
          onFilterChange={handleFilterChange}
          sourceImage={image}
          sourceAnalysis={imageAnalysis}
          recommendedPresetIds={recommendedPresetIds}
          adjustments={adjustments}
          onAdjustmentChange={handleAdjustmentChange}
          onReset={handleReset}
        />
      </div>

      <BottomBar
        fullImageData={fullImageData}
        filterName={activeFilter}
        filterStrength={filterStrength}
        effectIntensity={effectIntensity}
        analysis={imageAnalysis}
        adjustments={adjustments}
        fileName={fileName}
        showBefore={showBefore}
        onToggleBefore={() => setShowBefore((value) => !value)}
        compareMode={compareMode}
        onCompareModeChange={setCompareMode}
        zoom={zoom}
        onZoomChange={setZoom}
        exportSignal={exportSignal}
      />
    </div>
  );
};

const MobileTabs: React.FC<{
  activeFilter: string;
  activePreset: (typeof FILTER_PRESETS)[number];
  recommendation?: PresetRecommendation;
  filterStrength: number;
  effectIntensity: number;
  onFilterStrengthChange: (value: number) => void;
  onEffectIntensityChange: (value: number) => void;
  onFilterChange: (name: string) => void;
  sourceImage: HTMLImageElement | null;
  sourceAnalysis: ReturnType<typeof analyzeImageData> | null;
  recommendedPresetIds: string[];
  adjustments: Adjustments;
  onAdjustmentChange: (key: keyof Adjustments, value: number) => void;
  onReset: () => void;
}> = ({
  activeFilter,
  activePreset,
  recommendation,
  filterStrength,
  effectIntensity,
  onFilterStrengthChange,
  onEffectIntensityChange,
  onFilterChange,
  sourceImage,
  sourceAnalysis,
  recommendedPresetIds,
  adjustments,
  onAdjustmentChange,
  onReset,
}) => {
  return (
    <div className="space-y-3 px-2 py-3">
      <FilterSidebar
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
        sourceImage={sourceImage}
        sourceAnalysis={sourceAnalysis}
        recommendedPresetIds={recommendedPresetIds}
        layout="strip"
        swatchSize={40}
      />

      <Drawer>
        <DrawerTrigger asChild>
          <button className="w-full rounded-xl border border-border bg-card px-4 py-3 text-left">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-primary">Adjustments</p>
                <p className="text-sm text-foreground">{activePreset.name}</p>
              </div>
              <p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {filterStrength}% / {effectIntensity}%
              </p>
            </div>
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh]">
          <DrawerHeader>
            <DrawerTitle>Fine Tune</DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto pb-6">
            <AdjustmentsPanel
              activePreset={activePreset}
              recommendation={recommendation}
              adjustments={adjustments}
              filterStrength={filterStrength}
              effectIntensity={effectIntensity}
              onFilterStrengthChange={onFilterStrengthChange}
              onEffectIntensityChange={onEffectIntensityChange}
              onChange={onAdjustmentChange}
              onReset={onReset}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export default Index;
