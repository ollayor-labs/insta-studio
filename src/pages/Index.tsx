import React, {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
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
import DropZone from "@/components/DropZone";
import FilterSidebar from "@/components/FilterSidebar";
import AdjustmentsPanel from "@/components/AdjustmentsPanel";
import ImageCanvas from "@/components/ImageCanvas";
import BottomBar from "@/components/BottomBar";

const Index = () => {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [activeFilter, setActiveFilter] = useState("Original");
  const [filterStrength, setFilterStrength] = useState(100);
  const [adjustments, setAdjustments] = useState<Adjustments>({ ...defaultAdjustments });
  const [imageAnalysis, setImageAnalysis] = useState<ReturnType<typeof analyzeImageData> | null>(null);
  const [recommendations, setRecommendations] = useState<PresetRecommendation[]>([]);
  const [showBefore, setShowBefore] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePosition, setComparePosition] = useState(50);
  const [zoom, setZoom] = useState(100);

  const activePreset = useMemo(() => getFilterPreset(activeFilter), [activeFilter]);
  const recommendedPresetIds = useMemo(
    () => recommendations.map((recommendation) => recommendation.presetId),
    [recommendations],
  );
  const activeRecommendation = useMemo(
    () => recommendations.find((recommendation) => getFilterPreset(activeFilter).id === recommendation.presetId),
    [activeFilter, recommendations],
  );

  const deferredAdjustments = useDeferredValue(adjustments);
  const deferredFilterStrength = useDeferredValue(filterStrength);
  const deferredActiveFilter = useDeferredValue(activeFilter);

  const handleImageLoad = useCallback((img: HTMLImageElement, name: string) => {
    setImage(img);
    setFileName(name);
    setActiveFilter("Original");
    setFilterStrength(100);
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
    setAdjustments({ ...defaultAdjustments });
  }, []);

  const handleFilterChange = useCallback((name: string) => {
    const preset = getFilterPreset(name);
    startTransition(() => {
      setActiveFilter(name);
      setFilterStrength(Math.round(preset.defaultStrength * 100));
      setAdjustments({ ...defaultAdjustments });
      setCompareMode(false);
    });
    showFilterChangedToast(name, Math.round(preset.defaultStrength * 100));
  }, []);

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
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.code === "Space") {
        event.preventDefault();
        setShowBefore((value) => !value);
        return;
      }

      if (event.key === "[" || event.key === "]") {
        const names = FILTER_PRESETS.map((preset) => preset.name);
        const currentIndex = names.indexOf(activeFilter);
        const nextName =
          event.key === "["
            ? names[(currentIndex - 1 + names.length) % names.length]
            : names[(currentIndex + 1) % names.length];
        const preset = getFilterPreset(nextName);

        startTransition(() => {
          setActiveFilter(nextName);
          setFilterStrength(Math.round(preset.defaultStrength * 100));
          setAdjustments({ ...defaultAdjustments });
        });
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFilter]);

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
            [ ] cycle filters · Space before/after · premium adaptive presets
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
          filterName={deferredActiveFilter}
          filterStrength={deferredFilterStrength}
          adjustments={deferredAdjustments}
          analysis={imageAnalysis}
          showBefore={showBefore}
          compareMode={compareMode}
          comparePosition={comparePosition}
          onComparePositionChange={setComparePosition}
          zoom={zoom}
        />

        <div className="w-64 lg:w-80 border-l border-border shrink-0 overflow-hidden hidden md:block">
          <AdjustmentsPanel
            activePreset={activePreset}
            recommendation={activeRecommendation}
            adjustments={adjustments}
            filterStrength={filterStrength}
            onFilterStrengthChange={setFilterStrength}
            onChange={handleAdjustmentChange}
            onReset={handleReset}
          />
        </div>
      </div>

      <div className="md:hidden border-t border-border">
        <MobileTabs
          activeFilter={activeFilter}
          activePreset={activePreset}
          recommendation={activeRecommendation}
          filterStrength={filterStrength}
          onFilterStrengthChange={setFilterStrength}
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
        image={image}
        filterName={activeFilter}
        filterStrength={filterStrength}
        analysis={imageAnalysis}
        adjustments={adjustments}
        fileName={fileName}
        showBefore={showBefore}
        onToggleBefore={() => setShowBefore((value) => !value)}
        compareMode={compareMode}
        onCompareModeChange={setCompareMode}
        comparePosition={comparePosition}
        onComparePositionChange={setComparePosition}
        zoom={zoom}
        onZoomChange={setZoom}
      />
    </div>
  );
};

const MobileTabs: React.FC<{
  activeFilter: string;
  activePreset: (typeof FILTER_PRESETS)[number];
  recommendation?: PresetRecommendation;
  filterStrength: number;
  onFilterStrengthChange: (value: number) => void;
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
  onFilterStrengthChange,
  onFilterChange,
  sourceImage,
  sourceAnalysis,
  recommendedPresetIds,
  adjustments,
  onAdjustmentChange,
  onReset,
}) => {
  const [tab, setTab] = useState<"filters" | "adjust">("filters");

  return (
    <div>
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab("filters")}
          className={`flex-1 py-2 font-mono-ui text-[11px] tracking-wider uppercase transition-colors ${
            tab === "filters" ? "text-primary border-b-2 border-primary" : "text-muted-foreground"
          }`}
        >
          Filters
        </button>
        <button
          onClick={() => setTab("adjust")}
          className={`flex-1 py-2 font-mono-ui text-[11px] tracking-wider uppercase transition-colors ${
            tab === "adjust" ? "text-primary border-b-2 border-primary" : "text-muted-foreground"
          }`}
        >
          Adjust
        </button>
      </div>
      <div className="h-64 overflow-y-auto">
        {tab === "filters" ? (
          <FilterSidebar
            activeFilter={activeFilter}
            onFilterChange={onFilterChange}
            sourceImage={sourceImage}
            sourceAnalysis={sourceAnalysis}
            recommendedPresetIds={recommendedPresetIds}
          />
        ) : (
          <AdjustmentsPanel
            activePreset={activePreset}
            recommendation={recommendation}
            adjustments={adjustments}
            filterStrength={filterStrength}
            onFilterStrengthChange={onFilterStrengthChange}
            onChange={onAdjustmentChange}
            onReset={onReset}
          />
        )}
      </div>
    </div>
  );
};

export default Index;
