import React, { useState, useCallback, useEffect } from "react";
import { Adjustments, defaultAdjustments, FILTER_PRESETS } from "@/lib/filterEngine";
import DropZone from "@/components/DropZone";
import FilterSidebar from "@/components/FilterSidebar";
import AdjustmentsPanel from "@/components/AdjustmentsPanel";
import ImageCanvas from "@/components/ImageCanvas";
import BottomBar from "@/components/BottomBar";

const Index = () => {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [activeFilter, setActiveFilter] = useState("Original");
  const [adjustments, setAdjustments] = useState<Adjustments>({ ...defaultAdjustments });
  const [showBefore, setShowBefore] = useState(false);
  const [zoom, setZoom] = useState(100);

  const handleImageLoad = useCallback((img: HTMLImageElement, name: string) => {
    setImage(img);
    setFileName(name);
    setActiveFilter("Original");
    setAdjustments({ ...defaultAdjustments });
    setZoom(100);
  }, []);

  const handleAdjustmentChange = useCallback((key: keyof Adjustments, value: number) => {
    setAdjustments((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    setAdjustments({ ...defaultAdjustments });
  }, []);

  const handleFilterChange = useCallback((name: string) => {
    setActiveFilter(name);
    setAdjustments({ ...defaultAdjustments });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.code === "Space") {
        e.preventDefault();
        setShowBefore((v) => !v);
        return;
      }

      if (e.key === "[" || e.key === "]") {
        const names = FILTER_PRESETS.map((f) => f.name);
        const idx = names.indexOf(activeFilter);
        if (e.key === "[") {
          setActiveFilter(names[(idx - 1 + names.length) % names.length]);
        } else {
          setActiveFilter(names[(idx + 1) % names.length]);
        }
        setAdjustments({ ...defaultAdjustments });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFilter]);

  // Empty state
  if (!image) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
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
            [ ] cycle filters · Space before/after · ⌘V paste image
          </p>
        </footer>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Header */}
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

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar - Filters */}
        <div className="w-52 lg:w-60 border-r border-border shrink-0 overflow-hidden hidden md:block">
          <FilterSidebar
            activeFilter={activeFilter}
            onFilterChange={handleFilterChange}
            sourceImage={image}
          />
        </div>

        {/* Canvas */}
        <ImageCanvas
          image={image}
          filterName={activeFilter}
          adjustments={adjustments}
          showBefore={showBefore}
          zoom={zoom}
        />

        {/* Right sidebar - Adjustments */}
        <div className="w-52 lg:w-60 border-l border-border shrink-0 overflow-hidden hidden md:block">
          <AdjustmentsPanel
            adjustments={adjustments}
            onChange={handleAdjustmentChange}
            onReset={handleReset}
          />
        </div>
      </div>

      {/* Mobile filter/adjust tabs */}
      <div className="md:hidden border-t border-border">
        <MobileTabs
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          sourceImage={image}
          adjustments={adjustments}
          onAdjustmentChange={handleAdjustmentChange}
          onReset={handleReset}
        />
      </div>

      {/* Bottom bar */}
      <BottomBar
        image={image}
        filterName={activeFilter}
        adjustments={adjustments}
        fileName={fileName}
        showBefore={showBefore}
        onToggleBefore={() => setShowBefore((v) => !v)}
        zoom={zoom}
        onZoomChange={setZoom}
      />
    </div>
  );
};

// Mobile tabs for filter/adjust on small screens
const MobileTabs: React.FC<{
  activeFilter: string;
  onFilterChange: (name: string) => void;
  sourceImage: HTMLImageElement | null;
  adjustments: Adjustments;
  onAdjustmentChange: (key: keyof Adjustments, value: number) => void;
  onReset: () => void;
}> = ({ activeFilter, onFilterChange, sourceImage, adjustments, onAdjustmentChange, onReset }) => {
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
      <div className="h-48 overflow-y-auto">
        {tab === "filters" ? (
          <FilterSidebar activeFilter={activeFilter} onFilterChange={onFilterChange} sourceImage={sourceImage} />
        ) : (
          <AdjustmentsPanel adjustments={adjustments} onChange={onAdjustmentChange} onReset={onReset} />
        )}
      </div>
    </div>
  );
};

export default Index;
