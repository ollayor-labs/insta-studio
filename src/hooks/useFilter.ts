import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createImageDataFromImage,
  type Adjustments,
  prepareFilterSettings,
  type ResolvedFilterSettings,
} from "@/lib/filterEngine";
import type { ImageAnalysis } from "@/lib/filterEngine";
import { createFilterWorker, type FilterWorkerRequest, type FilterWorkerResponse } from "@/lib/filter-worker";

// Preview is downsampled to match the canvas's display element size
// (see ImageCanvas maxWidth=1200, maxHeight=800). The previous 1600 cap
// meant the worker processed ~78% more pixels than the user could ever
// see at 100% zoom, and every render's postMessage buffer was ~6.5 MB
// larger than necessary. The 1200 cap keeps pixel-perfect alignment
// with the display and roughly halves the per-render work for the
// slider feel path.
const PREVIEW_MAX_DIMENSION = 1200;

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
}

interface RasterCache {
  full: ImageData | null;
  preview: ImageData | null;
}

interface PreviewJob {
  source: ImageData;
  settings: ResolvedFilterSettings;
}

export function useFilter({
  image,
  filterName,
  adjustments,
  filterStrength,
  effectIntensity,
  analysis,
  useFullResolution,
}: UseFilterArgs) {
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  const frameQueuedRef = useRef(false);
  const pendingJobRef = useRef<PreviewJob | null>(null);
  const requestIdRef = useRef(0);
  const responseIdRef = useRef(0);

  const [rasters, setRasters] = useState<RasterCache>({ full: null, preview: null });
  const [filteredImageData, setFilteredImageData] = useState<ImageData | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const debouncedAdjustments = useDebouncedValue(adjustments, 16);
  const debouncedFilterStrength = useDebouncedValue(filterStrength, 16);
  const debouncedEffectIntensity = useDebouncedValue(effectIntensity, 16);

  useEffect(() => {
    if (!image) {
      setRasters({ full: null, preview: null });
      setFilteredImageData(null);
      return;
    }

    setRasters({
      full: createImageDataFromImage(image),
      preview: createImageDataFromImage(image, PREVIEW_MAX_DIMENSION),
    });
  }, [image]);

  useEffect(() => {
    const worker = createFilterWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<FilterWorkerResponse>) => {
      inFlightRef.current = false;
      setIsProcessing(false);

      if (event.data.id < responseIdRef.current) {
        return;
      }

      responseIdRef.current = event.data.id;
      setFilteredImageData(new ImageData(new Uint8ClampedArray(event.data.buffer), event.data.width, event.data.height));

      if (pendingJobRef.current) {
        frameQueuedRef.current = false;
        rafRef.current = window.requestAnimationFrame(flushQueue);
      }
    };

    return () => {
      window.cancelAnimationFrame(rafRef.current);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const sourceImageData = useMemo(
    () => (useFullResolution ? rasters.full : rasters.preview),
    [rasters.full, rasters.preview, useFullResolution],
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
        },
        analysis ?? undefined,
      ),
    [analysis, debouncedAdjustments, debouncedEffectIntensity, debouncedFilterStrength, filterName, useFullResolution],
  );

  const flushQueue = useCallback(() => {
    frameQueuedRef.current = false;

    if (inFlightRef.current) return;

    const worker = workerRef.current;
    const job = pendingJobRef.current;

    if (!worker || !job) return;

    pendingJobRef.current = null;
    inFlightRef.current = true;
    setIsProcessing(true);

    const id = requestIdRef.current + 1;
    requestIdRef.current = id;

    const buffer = job.source.data.slice().buffer;
    const request: FilterWorkerRequest = {
      id,
      width: job.source.width,
      height: job.source.height,
      buffer,
      settings: job.settings,
    };

    worker.postMessage(request, [buffer]);
  }, []);

  useEffect(() => {
    if (!sourceImageData) {
      setFilteredImageData(null);
      return;
    }

    pendingJobRef.current = {
      source: sourceImageData,
      settings: preparedSettings,
    };

    if (!frameQueuedRef.current) {
      frameQueuedRef.current = true;
      rafRef.current = window.requestAnimationFrame(flushQueue);
    }
  }, [flushQueue, preparedSettings, sourceImageData]);

  return {
    filteredImageData,
    fullImageData: rasters.full,
    previewImageData: rasters.preview,
    sourceImageData,
    isProcessing,
  };
}
