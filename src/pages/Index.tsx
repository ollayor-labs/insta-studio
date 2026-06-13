import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Adjustments,
  type analyzeImageData,
  createImageDataFromImage,
  defaultAdjustments,
  FILTER_PRESETS,
  getFilterPresetByNameWithCustom,
  recommendPresets,
  type PresetRecommendation,
} from "@/lib/filterEngine";
import { analyzeImageDataOnWorker, cancelPendingAnalysis } from "@/lib/analysis-worker";
import {
  showFilterChangedToast,
  showHeicConversionFailedToast,
  showImageDecodeFailedToast,
  showUnsupportedImageToast,
} from "@/lib/editorToasts";
import { PREVIEW_MAX_DIMENSION, useFilter } from "@/hooks/useFilter";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useCustomPresets } from "@/hooks/useCustomPresets";
import { useRecents } from "@/hooks/useRecents";
import { useFavorites } from "@/hooks/useFavorites";
import { FAVORITE_SLOTS, getFilterPresetById, type FavoriteSlot, type FavoritesMap } from "@/lib/filterEngine";
import {
  ImageImportError,
  isSupportedImageFile,
  loadBlobAsImage,
  loadImportedImage,
} from "@/lib/imageImport";
import { readExifFromBlob } from "@/lib/exif";
import RecentsList from "@/components/RecentsList";
import type { RecentRecord } from "@/lib/recents";
import DropZone from "@/components/DropZone";
import { formatFileSize } from "@/lib/fileSize";
import FilterSidebar from "@/components/FilterSidebar";
import RawAdjustmentsPanel from "@/components/AdjustmentsPanel";
import RawImageCanvas from "@/components/ImageCanvas";
import BottomBar from "@/components/BottomBar";
import { Loader2 } from "lucide-react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";

// Memoize the heavy child boundaries so the editor shell's frequent
// commits (debounced adjustments, recents / drop keystrokes, export
// signals, compare-reveal animations) don't re-run ImageCanvas's RAF
// scheduler and clipping pass or rebuild AdjustmentsPanel's slider
// tree when the props they care about are unchanged. `setZoom` and
// `handleUserComparePositionChange` are already stable references, so
// the memo hits in practice for any commit where the parent state
// changes but these props don't.
const ImageCanvas = React.memo(RawImageCanvas);
const AdjustmentsPanel = React.memo(RawAdjustmentsPanel);
const brandMarkSrc = "/brand/logo-mark.png";

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
  const [sourceMimeType, setSourceMimeType] = useState<string | null>(null);
  const [currentExifBytes, setCurrentExifBytes] = useState<Uint8Array | null>(null);
  const [activeFilter, setActiveFilter] = useState("Original");
  const [filterStrength, setFilterStrength] = useState(100);
  const [effectIntensity, setEffectIntensity] = useState(100);
  const [adjustments, setAdjustments] = useState<Adjustments>({ ...defaultAdjustments });
  const [imageAnalysis, setImageAnalysis] = useState<ReturnType<typeof analyzeImageData> | null>(null);
  const [recommendations, setRecommendations] = useState<PresetRecommendation[]>([]);
  const [viewMode, setViewMode] = useState<"edited" | "original" | "studio">("edited");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePosition, setComparePosition] = useState(50);
  const [compareReveal, setCompareReveal] = useState<"off" | "playing">("off");
  const compareRevealRafRef = useRef<number>(0);
  const compareRevealStartedAtRef = useRef<number>(0);
  const animationSourceRef = useRef(false);
  const [zoom, setZoom] = useState(100);
  const [exportSignal, setExportSignal] = useState(0);
  const [sceneMode, setSceneMode] = useState<"adaptive" | "studio">("adaptive");
  // Tracks the file currently being imported (from any source: drop,
  // file picker, dropzone paste, or the global Cmd+V handler). The
  // dropzone reads this to show its inline "Importing…" panel; the
  // editor branch reads this to show a small floating indicator
  // when the dropzone isn't visible.
  const [importingFile, setImportingFile] = useState<{ name: string; size: number } | null>(null);
  const { presets: customPresets, savePreset, removePreset, isReady: customPresetsReady } = useCustomPresets();
  const { recents, isReady: recentsReady, isSupported: recentsSupported, addRecent, removeRecent, clearRecents } = useRecents();
  const { favorites, setFavorite, clearFavorite } = useFavorites();

  const effectiveViewMode = spaceHeld ? "original" : viewMode;

  const activePreset = useMemo(
    () => getFilterPresetByNameWithCustom(activeFilter, customPresets),
    [activeFilter, customPresets],
  );
  const recommendedPresetIds = useMemo(
    () => recommendations.map((recommendation) => recommendation.presetId),
    [recommendations],
  );
  const activeRecommendation = useMemo(
    () => recommendations.find((recommendation) => activePreset.id === recommendation.presetId),
    [activePreset.id, recommendations],
  );

  const prefersReducedMotion = usePrefersReducedMotion();

  const { filteredImageData, studioImageData, sourceImageData, fullImageData, isProcessing, studioIsProcessing } = useFilter({
    image,
    filterName: activeFilter,
    adjustments,
    filterStrength,
    effectIntensity,
    analysis: imageAnalysis,
    // Full-resolution render is paid for when the source actually has
    // more pixels than the preview cap. A 4K image at 100% zoom should
    // export at full res; a 12MP phone photo always should; a small
    // icon-sized import should never. Zoom no longer gates this.
    useFullResolution: image
      ? image.naturalWidth * image.naturalHeight > PREVIEW_MAX_DIMENSION * PREVIEW_MAX_DIMENSION
      : false,
    adaptToScene: sceneMode === "adaptive",
    viewMode,
  });

  const handleImageLoad = useCallback(
    (img: HTMLImageElement, name: string, blob: Blob, mimeType: string) => {
      setImage(img);
      setFileName(name);
      setSourceMimeType(mimeType);
      setCurrentExifBytes(null);
      setActiveFilter("Original");
      setFilterStrength(100);
      setEffectIntensity(100);
      setAdjustments({ ...defaultAdjustments });
      setViewMode("edited");
      setCompareMode(false);
      setComparePosition(50);
      setZoom(100);
      // Fire-and-forget: storing in IndexedDB should never block the editor
      // from showing the new image. Errors are swallowed so a quota-exceeded
      // browser doesn't break the import flow. We also pull the EXIF TIFF
      // payload (JPEG / PNG / WebP) so it can be re-injected on export.
      void (async () => {
        let exifBytes: Uint8Array | null = null;
        try {
          exifBytes = await readExifFromBlob(blob);
        } catch {
          exifBytes = null;
        }
        setCurrentExifBytes(exifBytes);
        await addRecent({ name, mimeType, blob, exifBytes });
      })().catch(() => {});
    },
    [addRecent],
  );

  

  const startImport = useCallback(
    async (file: File) => {
      if (!isSupportedImageFile(file)) {
        showUnsupportedImageToast();
        return;
      }
      setImportingFile({ name: file.name, size: file.size });
      try {
        const { image, blob } = await loadImportedImage(file);
        const mimeType = blob.type || file.type || "image/jpeg";
        handleImageLoad(image, file.name, blob, mimeType);
      } catch (error) {
        if (error instanceof ImageImportError) {
          if (error.code === "unsupported-format") {
            showUnsupportedImageToast();
          } else if (error.code === "heic-conversion-failed") {
            showHeicConversionFailedToast();
          } else {
            showImageDecodeFailedToast();
          }
        } else {
          showImageDecodeFailedToast();
        }
      } finally {
        setImportingFile(null);
      }
    },
    [handleImageLoad],
  );

  const handleRecentSelect = useCallback(
    async (record: RecentRecord) => {
      try {
        const { image, blob } = await loadBlobAsImage(record.blob);
        setCurrentExifBytes(record.exifBytes);
        handleImageLoad(image, record.name, blob, record.mimeType);
      } catch {
        // If the stored blob is undecodable (corrupt, unsupported, or the
        // browser revoked the blob), drop it and let the user re-import.
        void removeRecent(record.id);
      }
    },
    [handleImageLoad, removeRecent],
  );

  const handleRecentRemove = useCallback(
    (id: string) => {
      void removeRecent(id);
    },
    [removeRecent],
  );

  const handleRecentClear = useCallback(() => {
    void clearRecents();
  }, [clearRecents]);

  const handleToggleFavorite = useCallback(
    (presetId: string, currentSlot: FavoriteSlot | undefined) => {
      if (currentSlot) {
        clearFavorite(currentSlot);
        return;
      }
      // Find the lowest empty slot 1-9.
      const taken = new Set<number>();
      for (const slot of FAVORITE_SLOTS) {
        if (favorites[slot]) taken.add(slot);
      }
      const nextSlot = FAVORITE_SLOTS.find((slot) => !taken.has(slot));
      if (nextSlot) {
        setFavorite(nextSlot, presetId);
      }
    },
    [clearFavorite, favorites, setFavorite],
  );

  const handleAdjustmentChange = useCallback((key: keyof Adjustments, value: number) => {
    setAdjustments((previous) => ({ ...previous, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    const preset = getFilterPresetByNameWithCustom(activeFilter, customPresets);
    setAdjustments({ ...defaultAdjustments });
    setFilterStrength(Math.round(preset.defaultStrength * 100));
    setEffectIntensity(100);
  }, [activeFilter, customPresets]);

  const handleFilterChange = useCallback((name: string) => {
    const preset = getFilterPresetByNameWithCustom(name, customPresets);
    startTransition(() => {
      setActiveFilter(name);
      setFilterStrength(Math.round(preset.defaultStrength * 100));
      setEffectIntensity(100);
      setAdjustments({ ...defaultAdjustments });
      setCompareMode(false);
    });
    showFilterChangedToast(name, Math.round(preset.defaultStrength * 100));
  }, [customPresets]);

  const handleActivateFavorite = useCallback(
    (slot: FavoriteSlot) => {
      const presetId = favorites[slot];
      if (!presetId) return;
      const preset = getFilterPresetById(presetId);
      if (!preset) return;
      // Apply by name so the existing filter-change path handles side effects
      // (toast, transition, etc.) consistently. Custom presets share the same
      // name-based lookup, so this works for them too.
      handleFilterChange(preset.name);
    },
    [favorites, handleFilterChange],
  );

  const handlePlayReveal = useCallback(() => {
    if (!image) return;
    if (!compareMode) {
      setCompareMode(true);
    }
    // When the user prefers reduced motion, snap straight to the
    // midpoint and skip the auto-cycle. The user can still drag the
    // seam manually.
    if (prefersReducedMotion) {
      setComparePosition(50);
      setCompareReveal("off");
      return;
    }
    setCompareReveal("playing");
  }, [compareMode, image, prefersReducedMotion]);

  // Any user-driven slider drag should immediately stop the auto-reveal so
  // the user is in control. The animation's own RAF loop writes to
  // comparePosition via the wrapped setter below and is allowed to proceed.
  const handleUserComparePositionChange = useCallback(
    (value: number) => {
      if (animationSourceRef.current) {
        animationSourceRef.current = false;
        setComparePosition(value);
        return;
      }
      if (compareReveal === "playing") {
        setCompareReveal("off");
      }
      setComparePosition(value);
    },
    [compareReveal],
  );

  const handleSavePreset = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const record = savePreset({
        name: trimmed,
        basePresetId: activePreset.id,
        strength: activePreset.defaultStrength,
        adjustments,
        note: undefined,
      });
      startTransition(() => {
        setActiveFilter(record.name);
        setViewMode("edited");
        setCompareMode(false);
      });
      showFilterChangedToast(record.name, Math.round(record.strength * 100));
    },
    [activePreset.id, activePreset.defaultStrength, adjustments, savePreset],
  );

  const handleDeleteCustomPreset = useCallback(
    (presetId: string) => {
      removePreset(presetId);
      const record = customPresets.find((entry) => entry.id === presetId);
      if (record && activeFilter === record.name) {
        setActiveFilter("Original");
        setAdjustments({ ...defaultAdjustments });
        setFilterStrength(100);
        setEffectIntensity(100);
      }
    },
    [activeFilter, customPresets, removePreset],
  );

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
      cancelPendingAnalysis();
      return;
    }

    // Reset any in-flight analysis from a previous image so a stale worker
    // response doesn't overwrite the new image's analysis.
    cancelPendingAnalysis();

    let cancelled = false;
    const sourceData = createImageDataFromImage(image, 320);
    analyzeImageDataOnWorker(sourceData)
      .then((analysis) => {
        if (cancelled) return;
        setImageAnalysis(analysis);
        setRecommendations(recommendPresets(analysis, 3));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Image analysis failed", error);
        setImageAnalysis(null);
        setRecommendations([]);
      });

    return () => {
      cancelled = true;
    };
  }, [image]);

  // Drive the auto-cycling compare reveal. When `compareReveal` flips to
  // "playing", animate `comparePosition` through 0 → 100 → 0 over 3 seconds
  // using a sine ease. The animation auto-cancels when the user manually
  // drags the slider (the canvas's pointer handler bypasses this and writes
  // to comparePosition directly, then we detect the drift and stop).
  useEffect(() => {
    if (compareReveal !== "playing") {
      if (compareRevealRafRef.current) {
        window.cancelAnimationFrame(compareRevealRafRef.current);
        compareRevealRafRef.current = 0;
      }
      return;
    }
    compareRevealStartedAtRef.current = performance.now();
    const startedAt = compareRevealStartedAtRef.current;
    const totalMs = 3000;

    const step = (now: number) => {
      const elapsed = now - startedAt;
      if (elapsed >= totalMs) {
        setComparePosition(50);
        setCompareReveal("off");
        compareRevealRafRef.current = 0;
        return;
      }
      // Sine ease: 0 → 1 → 0 over the duration.
      const phase = (elapsed / totalMs) * Math.PI;
      const eased = Math.sin(phase);
      const next = Math.max(0, Math.min(100, eased * 100));
      animationSourceRef.current = true;
      setComparePosition(next);
      compareRevealRafRef.current = window.requestAnimationFrame(step);
    };
    compareRevealRafRef.current = window.requestAnimationFrame(step);
    return () => {
      if (compareRevealRafRef.current) {
        window.cancelAnimationFrame(compareRevealRafRef.current);
        compareRevealRafRef.current = 0;
      }
    };
  }, [compareReveal]);

  // Global Cmd+V handler for when the editor is already open and the
  // dropzone isn't visible. When the dropzone IS visible (empty
  // state), the dropzone's own onPaste handles the event so we don't
  // double-import.
  useEffect(() => {
    if (!image) return;
    const handleWindowPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            void startImport(file);
          }
          return;
        }
      }
    };
    window.addEventListener("paste", handleWindowPaste);
    return () => window.removeEventListener("paste", handleWindowPaste);
  }, [image, startImport]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) setSpaceHeld(true);
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
        return;
      }

      if (event.key.toLowerCase() === "c" && event.shiftKey) {
        event.preventDefault();
        handlePlayReveal();
        return;
      }

      // 1-9: apply the favorite preset stored in that slot (if any).
      if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const slot = Number(event.key) as FavoriteSlot;
        if (favorites[slot]) {
          event.preventDefault();
          handleActivateFavorite(slot);
        }
        return;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceHeld(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [cycleFilter, favorites, handleActivateFavorite, handlePlayReveal, handleReset]);

  if (!image) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="h-14 border-b border-border flex items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <img src={brandMarkSrc} alt="insta-studio logo" className="h-8 w-8 shrink-0" />
            <h1 className="font-display text-xl tracking-tight text-foreground">insta-studio</h1>
            <span className="font-mono-ui text-[10px] text-muted-foreground tracking-widest uppercase">
              Photo Filter Studio
            </span>
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center gap-6 p-8">
          <div className="w-full max-w-xl">
            <DropZone
              onImageLoad={handleImageLoad}
              onLoadingChange={setImportingFile}
            />
          </div>
          {recentsSupported ? (
            <RecentsList
              recents={recents}
              isReady={recentsReady}
              onSelect={handleRecentSelect}
              onRemove={handleRecentRemove}
              onClear={handleRecentClear}
            />
          ) : null}
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
          <img src={brandMarkSrc} alt="insta-studio logo" className="h-7 w-7 shrink-0" />
          <h1 className="font-display text-lg tracking-tight text-foreground">insta-studio</h1>
          <span className="hidden sm:inline font-mono-ui text-[10px] text-muted-foreground tracking-widest uppercase">
            {fileName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {importingFile ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-background/85 shadow-lg backdrop-blur-md">
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
              <span className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-foreground">
                Importing
              </span>
              <span className="font-mono-ui text-[10px] text-muted-foreground tracking-[0.14em] uppercase truncate max-w-[200px]">
                {importingFile.name} · {formatFileSize(importingFile.size)}
              </span>
            </div>
          ) : null}
          <span className="font-mono-ui text-[11px] text-primary">{activeFilter}</span>
          <button
            onClick={() => {
              setImage(null);
              setFileName("");
              setSourceMimeType(null);
              setCurrentExifBytes(null);
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
            customPresets={customPresets}
            onDeleteCustomPreset={handleDeleteCustomPreset}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        </div>

        <ImageCanvas
          image={image}
          filterName={activeFilter}
          sourceImageData={sourceImageData}
          filteredImageData={filteredImageData}
          studioImageData={studioImageData}
          viewMode={effectiveViewMode}
          compareMode={compareMode}
          comparePosition={comparePosition}
          onComparePositionChange={handleUserComparePositionChange}
          zoom={zoom}
          onZoomChange={setZoom}
          isProcessing={isProcessing}
          studioIsProcessing={studioIsProcessing}
          sourceAnalysis={imageAnalysis}
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
            onSavePreset={handleSavePreset}
            canSavePreset={customPresetsReady}
            sceneMode={sceneMode}
            onSceneModeChange={setSceneMode}
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
          customPresets={customPresets}
          onDeleteCustomPreset={handleDeleteCustomPreset}
          onSavePreset={handleSavePreset}
          canSavePreset={customPresetsReady}
          sceneMode={sceneMode}
          onSceneModeChange={setSceneMode}
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
        sourceMimeType={sourceMimeType}
        currentExifBytes={currentExifBytes}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        compareMode={compareMode}
        onCompareModeChange={setCompareMode}
        compareReveal={compareReveal}
        onPlayReveal={handlePlayReveal}
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
  customPresets: ReturnType<typeof useCustomPresets>["presets"];
  onDeleteCustomPreset: (presetId: string) => void;
  onSavePreset: (name: string) => void;
  canSavePreset: boolean;
  sceneMode: "adaptive" | "studio";
  onSceneModeChange: (mode: "adaptive" | "studio") => void;
  adjustments: Adjustments;
  onAdjustmentChange: (key: keyof Adjustments, value: number) => void;
  onReset: () => void;
  favorites?: FavoritesMap;
  onToggleFavorite?: (presetId: string, currentSlot: FavoriteSlot | undefined) => void;
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
  customPresets,
  onDeleteCustomPreset,
  onSavePreset,
  canSavePreset,
  sceneMode,
  onSceneModeChange,
  adjustments,
  onAdjustmentChange,
  onReset,
  favorites,
  onToggleFavorite,
}) => {
  return (
    <div className="space-y-3 px-2 py-3">
      <FilterSidebar
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
        sourceImage={sourceImage}
        sourceAnalysis={sourceAnalysis}
        recommendedPresetIds={recommendedPresetIds}
        customPresets={customPresets}
        onDeleteCustomPreset={onDeleteCustomPreset}
        layout="strip"
        swatchSize={40}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
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
              onSavePreset={onSavePreset}
              canSavePreset={canSavePreset}
              sceneMode={sceneMode}
              onSceneModeChange={onSceneModeChange}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export default Index;
