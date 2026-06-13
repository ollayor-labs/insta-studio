import { useEffect, useMemo, useRef, useState } from "react";
import {
  createImageDataFromImage,
  type Adjustments,
  prepareFilterSettings,
} from "@/lib/filterEngine";
import type { ImageAnalysis } from "@/lib/filterEngine";
import { renderFilterOnWorker } from "@/lib/filter-worker";

const PREVIEW_DEBOUNCE_MS = 16;
const EXPORT_DEBOUNCE_MS = 250;
// Preview is downsampled to the same size as the canvas's display element
// (see ImageCanvas maxWidth=1200, maxHeight=800). The previous 1600 cap
// meant the worker processed ~78% more pixels than the user could ever see
// at 100% zoom, and every render's postMessage buffer was ~6.5 MB larger
// than necessary. The 1200 cap keeps pixel-perfect alignment with the
// display and roughly halves the per-render work for the slider feel path.
export const PREVIEW_MAX_DIMENSION = 1200;

function useDebouncedValue<T>(value: T, delay = 16): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debounced;
}

interface UseFilterArgs {
  image: HTMLImageElement | null;
  filterName: string;
  adjustments: Adjustments;
  filterStrength: number;
  effectIntensity: number;
  analysis: ImageAnalysis | null;
  useFullResolution: boolean;
  adaptToScene: boolean;
  viewMode: "edited" | "original" | "studio";
}

interface RasterCache {
  full: ImageData | null;
  preview: ImageData | null;
}

export function useFilter({
  image,
  filterName,
  adjustments,
  filterStrength,
  effectIntensity,
  analysis,
  useFullResolution,
  adaptToScene,
  viewMode,
}: UseFilterArgs) {
  const [rasters, setRasters] = useState<RasterCache>({ full: null, preview: null });
  const [filteredImageData, setFilteredImageData] = useState<ImageData | null>(null);
  const [studioImageData, setStudioImageData] = useState<ImageData | null>(null);
  // Adaptive + studio renders track their own processing state so the
  // canvas's "Rendering" chip is honest whichever view is on screen.
  // The hook exposes a single `isProcessing` (OR of both) for callers
  // that don't need to know which path produced it.
  const [isProcessing, setIsProcessing] = useState(false);
  const [studioIsProcessing, setStudioIsProcessing] = useState(false);
  const latestRequestRef = useRef(0);

  // Preview renders feel best with a tight 16 ms debounce so sliders stay
  // responsive. Export renders (full-resolution, used by the bottom bar's
  // download button) are far more expensive and benefit from a longer
  // settle window so a fast slider doesn't queue 60 full-res renders.
  const debounceMs = useFullResolution ? EXPORT_DEBOUNCE_MS : PREVIEW_DEBOUNCE_MS;
  const debouncedAdjustments = useDebouncedValue(adjustments, debounceMs);
  const debouncedFilterStrength = useDebouncedValue(filterStrength, debounceMs);
  const debouncedEffectIntensity = useDebouncedValue(effectIntensity, debounceMs);

  useEffect(() => {
    if (!image) {
      setRasters({ full: null, preview: null });
      setFilteredImageData(null);
      setStudioImageData(null);
      return;
    }

    setStudioImageData(null);
    setRasters({
      full: createImageDataFromImage(image),
      preview: createImageDataFromImage(image, PREVIEW_MAX_DIMENSION),
    });
  }, [image]);

  const sourceImageData = useMemo(
    () => (useFullResolution ? rasters.full : rasters.preview),
    [rasters.full, rasters.preview, useFullResolution],
  );

  const studioSettings = useMemo(
    () =>
      prepareFilterSettings(
        filterName,
        debouncedAdjustments,
        {
          analysis,
          quality: useFullResolution ? "export" : "preview",
          strength: debouncedFilterStrength,
          effectIntensity: debouncedEffectIntensity,
          adaptToScene: false,
        },
        analysis ?? undefined,
      ),
    [
      analysis,
      debouncedAdjustments,
      debouncedEffectIntensity,
      debouncedFilterStrength,
      filterName,
      useFullResolution,
    ],
  );

  const preparedSettings = useMemo(
    () =>
      prepareFilterSettings(
        filterName,
        debouncedAdjustments,
        {
          analysis,
          quality: useFullResolution ? "export" : "preview",
          strength: debouncedFilterStrength,
          effectIntensity: debouncedEffectIntensity,
          adaptToScene,
        },
        analysis ?? undefined,
      ),
    [
      analysis,
      adaptToScene,
      debouncedAdjustments,
      debouncedEffectIntensity,
      debouncedFilterStrength,
      filterName,
      useFullResolution,
    ],
  );

  useEffect(() => {
    if (!sourceImageData) {
      setFilteredImageData(null);
      return;
    }

    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setIsProcessing(true);

    let cancelled = false;
    renderFilterOnWorker(sourceImageData, preparedSettings)
      .then((result) => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        setFilteredImageData(result);
      })
      .catch((error: unknown) => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        console.error("Filter render failed", error);
        setFilteredImageData(null);
      })
      .finally(() => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        setIsProcessing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [preparedSettings, sourceImageData]);

  // Studio render is only paid for when the user is actually viewing it
  // (viewMode === "studio"). It uses the same worker/broker so cancellation
  // and singleton behaviour stay consistent.
  useEffect(() => {
    if (viewMode !== "studio" || !sourceImageData) {
      return;
    }
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setStudioIsProcessing(true);
    let cancelled = false;
    renderFilterOnWorker(sourceImageData, studioSettings)
      .then((result) => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        setStudioImageData(result);
      })
      .catch((error: unknown) => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        console.error("Studio render failed", error);
        setStudioImageData(null);
      })
      .finally(() => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        setStudioIsProcessing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studioSettings, sourceImageData, viewMode]);

  return {
    filteredImageData,
    studioImageData,
    fullImageData: rasters.full,
    previewImageData: rasters.preview,
    sourceImageData,
    isProcessing: isProcessing || studioIsProcessing,
    studioIsProcessing,
  };
}
