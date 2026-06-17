import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createImageDataFromImage,
  type Adjustments,
  prepareFilterSettings,
} from "@/lib/filterEngine";
import type { ImageAnalysis } from "@/lib/filterEngine";
import { getConsumerBackendKind, renderFilterOnWorker } from "@/lib/filter-worker";
import { subscribeToWebGlDegraded } from "@/lib/webgl-preview";

// Per-field label for the dev-only "Rendering on js (<reason> active)" chip.
// First-match-wins is intentional: it's a presentation choice, not a
// behavioural one. The underlying render still applies every non-zero
// blur field. If a future blur field is added, extend both this helper
// and `settingsRequireBlurPasses` in selection.ts together so the chip
// stays in sync with the selector.
export type BlurReason = "clarity" | "sharpness" | "bloom" | null;
export type BackendKind = "webgl" | "js";
export type BackendStatus = { kind: BackendKind; blurReason: BlurReason };

function blurReason(a: Adjustments): BlurReason {
  if (a.clarity !== 0) return "clarity";
  if (a.sharpness !== 0) return "sharpness";
  if (a.bloom !== 0) return "bloom";
  return null;
}

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
  /**
   * The canvas the WebGL backend should render the live preview
   * into. When provided, the broker passes it to the backend
   * factory and the backend uses it as its framebuffer -- the
   * browser composites the canvas without any CPU readback. The
   * hook doesn't draw to this canvas itself; the backend does.
   * When `null`, the broker falls back to the legacy `readPixels`
   * path and the hook's resolved `ImageData` is what callers
   * should `putImageData` into a 2D canvas (the studio view does
   * this). Pass the same ref to multiple renders to keep the
   * backend cached; changing the ref evicts and rebuilds the
   * backend (so the WebGL resources migrate to the new canvas).
   */
  previewCanvasRef?: { current: HTMLCanvasElement | null };
  /**
   * The canvas the WebGL backend should render the studio
   * preview into. Same semantics as `previewCanvasRef`, but
   * bound to the `"studio"` consumer so the studio and live
   * previews don't share backend state.
   */
  studioCanvasRef?: { current: HTMLCanvasElement | null };
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
  previewCanvasRef,
  studioCanvasRef,
}: UseFilterArgs) {
  // The preview raster stays in React state so the live preview's
  // effect can read it as a dep. The full-resolution raster is
  // lazily materialized on first use (typically the first export
  // click) and cached in a ref so the JS heap doesn't have to hold
  // ~48 MB of `Uint8ClampedArray` for every 12 MP image from the
  // moment the user imports it. The previous design allocated it
  // on image load and never freed it -- a real cost for any photo
  // larger than a few megapixels.
  const [previewRaster, setPreviewRaster] = useState<ImageData | null>(null);
  const fullRasterRef = useRef<ImageData | null>(null);
  const fullRasterImageRef = useRef<HTMLImageElement | null>(null);
  const [fullRaster, setFullRaster] = useState<ImageData | null>(null);
  // Bumped when the lazy full raster is materialized / replaced, so
  // effects that *do* want the full-res render (the live preview
  // when `useFullResolution` is true) can re-derive their memo when
  // the raster arrives. Without this, the first preview render on
  // a fresh image uses the preview raster and never re-runs once
  // the full raster materializes. The `useEffect`s that read the
  // ref via `sourceImageData` handle the live preview path -- this
  // counter is for any consumer that explicitly waits on the full
  // raster (none today, but it's a one-line opt-in).
  const fullRasterVersionRef = useRef(0);
  const [filteredImageData, setFilteredImageData] = useState<ImageData | null>(null);
  const [studioImageData, setStudioImageData] = useState<ImageData | null>(null);
  // Adaptive + studio renders track their own processing state so the
  // canvas's "Rendering" chip is honest whichever view is on screen.
  // The hook exposes a single `isProcessing` (OR of both) for callers
  // that don't need to know which path produced it.
  const [isProcessing, setIsProcessing] = useState(false);
  const [studioIsProcessing, setStudioIsProcessing] = useState(false);
  // Backend selection for the most recently resolved render. Null while
  // a render is in flight or before the first one resolves. Mirrors the
  // existing isProcessing / studioIsProcessing split: `backendStatus` is
  // the OR (whichever resolved last), `studioBackendStatus` is the
  // studio branch only. The dev-only "Rendering on webgl" / "Rendering
  // on js" chip in ImageCanvas reads these.
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [studioBackendStatus, setStudioBackendStatus] = useState<BackendStatus | null>(null);
  // One-shot logging refs. `hasLoggedBackendRef` fires once per session
  // on the first time a render resolves, so devs can see which backend
  // is actually serving them. `hasWarnedContextLossRef` fires once per
  // lost -> restored cycle for the "webglcontextlost" story.
  const hasLoggedBackendRef = useRef(false);
  const hasWarnedContextLossRef = useRef(false);
  const wasDegradedRef = useRef(false);
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
      // Drop both rasters and the cached full-res ImageData. The
      // ref must be cleared too -- otherwise switching to a new
      // image and then back could surface the old photo's bytes.
      setPreviewRaster(null);
      fullRasterRef.current = null;
      fullRasterImageRef.current = null;
      setFullRaster(null);
      setFilteredImageData(null);
      setStudioImageData(null);
      return;
    }

    setStudioImageData(null);
    setPreviewRaster(createImageDataFromImage(image, PREVIEW_MAX_DIMENSION));
  }, [image]);

  /**
   * Lazily materialize the full-resolution `ImageData` for the
   * current image. Returns the cached value if the image hasn't
   * changed since the last call. The first call pays the full
   * pixel-copy cost; subsequent calls are O(1). Consumers (the
   * export pipeline) should call this inside an `async` handler
   * -- the function returns synchronously today, but a future
   * off-thread decode would make it async and we don't want the
   * export call site to have to change again.
   *
   * Memory: the resulting `ImageData` is cached in `fullRasterRef`
   * and `fullRaster` (state) for the lifetime of the current
   * image. When the user imports a new image, both are cleared in
   * the `image`-effect above so the previous photo's bytes become
   * GC-eligible.
   */
  const getFullImageData = useCallback((): ImageData | null => {
    if (!image) return null;
    if (fullRasterImageRef.current === image && fullRasterRef.current) {
      return fullRasterRef.current;
    }
    const raster = createImageDataFromImage(image);
    fullRasterRef.current = raster;
    fullRasterImageRef.current = image;
    fullRasterVersionRef.current += 1;
    setFullRaster(raster);
    return raster;
  }, [image]);

  // The live preview's source raster. If `useFullResolution` is
  // requested and the lazy full raster is available, use it;
  // otherwise fall back to the preview raster. This is the live
  // preview path -- the on-screen canvas is capped at 1200x800
  // regardless, so the fallback is visually identical for the
  // slider feel, just slightly lower-quality for some filter
  // passes (e.g. bloom) until the full raster materializes.
  const sourceImageData = useMemo(
    () => (useFullResolution && fullRaster ? fullRaster : previewRaster),
    [fullRaster, previewRaster, useFullResolution],
  );

  // Shared inputs to `prepareFilterSettings` for both the studio
  // (adaptToScene: false) and the live preview (adaptToScene: true)
  // branches. The function in `src/lib/filters/index.ts` is the
  // expensive part (it walks every curve, scales every HSL band,
  // and composes the per-channel LUTs); the React-level memoization
  // here just keeps the *inputs* stable. The two memos below still
  // call `prepareFilterSettings` once each -- deduplicating the
  // function body itself is a follow-up refactor in the filter
  // engine. (Ali #8: the duplication that matters is inside
  // `prepareFilterSettings`, not in this hook; the dep-array
  // differences here are already minimal.)
  const baseSettingsArgs = useMemo(
    () =>
      ({
        analysis,
        quality: useFullResolution ? "export" : "preview",
        strength: debouncedFilterStrength,
        effectIntensity: debouncedEffectIntensity,
      }) as const,
    [
      analysis,
      debouncedEffectIntensity,
      debouncedFilterStrength,
      useFullResolution,
    ],
  );

  const studioSettings = useMemo(
    () => prepareFilterSettings(filterName, debouncedAdjustments, { ...baseSettingsArgs, adaptToScene: false }, analysis ?? undefined),
    [filterName, debouncedAdjustments, baseSettingsArgs, analysis],
  );

  const preparedSettings = useMemo(
    () => prepareFilterSettings(filterName, debouncedAdjustments, { ...baseSettingsArgs, adaptToScene }, analysis ?? undefined),
    [filterName, debouncedAdjustments, adaptToScene, baseSettingsArgs, analysis],
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
    // Snapshot the settings at the moment the render is issued. The
    // broker's contract is that in-flight renders keep the backend
    // selected at start, so this matches the backend the user actually
    // got -- not whatever the slider was on when the worker happened
    // to finish.
    const renderSettings = preparedSettings;
    renderFilterOnWorker(sourceImageData, renderSettings, {
      consumer: "preview",
      userAdjustments: debouncedAdjustments,
      targetCanvas: previewCanvasRef?.current ?? null,
    })
      .then((result) => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        setFilteredImageData(result);
        const kind = getConsumerBackendKind("preview");
        if (kind === "webgl" || kind === "js") {
          const status: BackendStatus = { kind, blurReason: blurReason(renderSettings.adjustments) };
          setBackendStatus(status);
          if (!hasLoggedBackendRef.current) {
            hasLoggedBackendRef.current = true;
            const reasonLabel = status.blurReason ?? "none";
            console.info(
              `[webgl-preview] selected ${kind} backend for consumer=preview, blurReason=${reasonLabel}`,
            );
          }
        }
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
    // debouncedAdjustments is intentionally read once via the closure
    // -- the dep array omits it because preparedSettings is derived
    // from it, so any change re-runs the effect with the new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparedSettings, sourceImageData]);

  // Studio render is only paid for when the user is actually viewing it
  // (viewMode === "studio"). It uses its own "studio" consumer so
  // the live preview's fast latest-wins cancellation does not overwrite
  // the studio result. The default broker policy routes "studio" to
  // the JS engine, matching the BottomBar export pipeline's choice
  // (full-res float32 path, maximum precision). The studio render
  // is the single highest-quality render in the app, so paying the
  // extra context-acquisition cost when the user toggles view C is
  // the right trade.
  useEffect(() => {
    if (viewMode !== "studio" || !sourceImageData) {
      return;
    }
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setStudioIsProcessing(true);
    let cancelled = false;
    const renderSettings = studioSettings;
    renderFilterOnWorker(sourceImageData, renderSettings, {
      consumer: "studio",
      userAdjustments: debouncedAdjustments,
      targetCanvas: studioCanvasRef?.current ?? null,
    })
      .then((result) => {
        if (cancelled || requestId !== latestRequestRef.current) return;
        setStudioImageData(result);
        const kind = getConsumerBackendKind("studio");
        if (kind === "webgl" || kind === "js") {
          const status: BackendStatus = { kind, blurReason: blurReason(renderSettings.adjustments) };
          setStudioBackendStatus(status);
          if (!hasLoggedBackendRef.current) {
            hasLoggedBackendRef.current = true;
            const reasonLabel = status.blurReason ?? "none";
            console.info(
              `[webgl-preview] selected ${kind} backend for consumer=studio, blurReason=${reasonLabel}`,
            );
          }
        }
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
    // debouncedAdjustments is intentionally read once via the closure
    // -- the dep array omits it because studioSettings is derived
    // from it, so any change re-runs the effect with the new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioSettings, sourceImageData, viewMode]);

  // One-shot console.warn per webglcontextlost -> webglcontextrestored
  // cycle. The WebGlBackend flips the module-level degraded flag in
  // its onContextLost / onContextRestored handlers; we subscribe
  // to those transitions instead of polling on a timer. (Ali #7:
  // the previous setInterval(500ms) ran for the entire session
  // and could miss a fast lost -> restored -> lost cycle in
  // between ticks.) The subscriber fires synchronously on every
  // transition and once on subscribe with the current value, so
  // the hook's state is always in sync with the backend's.
  useEffect(() => {
    return subscribeToWebGlDegraded((isDegraded) => {
      const wasDegraded = wasDegradedRef.current;
      if (isDegraded && !wasDegraded) {
        wasDegradedRef.current = true;
        hasWarnedContextLossRef.current = false;
      } else if (!isDegraded && wasDegraded) {
        wasDegradedRef.current = false;
      }
      if (isDegraded && !hasWarnedContextLossRef.current) {
        hasWarnedContextLossRef.current = true;
        console.warn(
          "[webgl-preview] webglcontextlost detected -- next renders will fall back to the JS engine until the context is restored.",
        );
      }
    });
  }, []);

  return {
    filteredImageData,
    studioImageData,
    fullImageData: fullRaster,
    getFullImageData,
    previewImageData: previewRaster,
    sourceImageData,
    isProcessing: isProcessing || studioIsProcessing,
    studioIsProcessing,
    backendStatus,
    studioBackendStatus,
  };
}
