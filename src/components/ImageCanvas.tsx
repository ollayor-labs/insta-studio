import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import HistogramBadge from "@/components/HistogramBadge";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { detectClippingFromImageData, type ClippingChannels, type ImageAnalysis } from "@/lib/filterEngine";
import type { BackendStatus } from "@/hooks/useFilter";

interface ImageCanvasProps {
  image: HTMLImageElement | null;
  filterName: string;
  sourceImageData: ImageData | null;
  filteredImageData: ImageData | null;
  studioImageData: ImageData | null;
  /**
   * The canvas the WebGL backend renders the live preview into.
   * Owned by the page (which also passes it to `useFilter`); the
   * component here just mounts the `<canvas>` element. The
   * backend writes directly to this canvas -- the component
   * itself never `putImageData`s the filtered frame. The
   * `filteredImageData` prop is still passed (for the
   * `useFilter` callers that resolve with the source as a
   * side-effect on the canvas-bound path) and is used here only
   * for transition source bookkeeping.
   */
  previewCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  viewMode: "edited" | "original" | "studio";
  compareMode: boolean;
  comparePosition: number;
  onComparePositionChange: (value: number) => void;
  zoom: number;
  onZoomChange: (value: number) => void;
  isProcessing: boolean;
  studioIsProcessing?: boolean;
  backendStatus?: BackendStatus | null;
  studioBackendStatus?: BackendStatus | null;
  sourceAnalysis: ImageAnalysis | null;
}

function clampZoom(value: number): number {
  return Math.max(25, Math.min(400, Math.round(value)));
}

// Preview canvas display caps. Shared between the size effect
// (which writes the CSS variables) and the wheel-zoom handler
// (which predicts the next stage size for cursor anchoring).
// Keeping them as a single source of truth ensures the wheel
// handler doesn't fight the size effect when zoom changes.
const PREVIEW_MAX_WIDTH = 1200;
const PREVIEW_MAX_HEIGHT = 800;

function previewDisplaySize(image: HTMLImageElement | null, zoom: number): { width: number; height: number } | null {
  if (!image) return null;
  const scale = Math.min(PREVIEW_MAX_WIDTH / image.width, PREVIEW_MAX_HEIGHT / image.height, 1);
  return {
    width: image.width * scale * (zoom / 100),
    height: image.height * scale * (zoom / 100),
  };
}

function distanceBetween(first: { x: number; y: number }, second: { x: number; y: number }): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

const ImageCanvas: React.FC<ImageCanvasProps> = ({
  image,
  filterName,
  sourceImageData,
  filteredImageData,
  studioImageData,
  previewCanvasRef,
  viewMode,
  compareMode,
  comparePosition,
  onComparePositionChange,
  zoom,
  onZoomChange,
  isProcessing,
  studioIsProcessing = false,
  backendStatus = null,
  studioBackendStatus = null,
  sourceAnalysis,
}) => {
  // `previewCanvasRef` is owned by the page (which also threads it
  // to `useFilter`). The WebGL backend writes the filtered preview
  // directly into `previewCanvasRef.current` -- we never
  // `putImageData` the filtered frame here. The original and
  // studio overlays below are 2D canvases we own locally; they're
  // drawn from the `sourceImageData` / `studioImageData` props.
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const studioCanvasRef = useRef<HTMLCanvasElement>(null);
  const revealCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const revealRafRef = useRef<number>(0);
  const revealTimeoutRef = useRef<number>(0);
  const activePointersRef = useRef<Map<number, { x: number; y: number; type: string }>>(new Map());
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  // Pending cursor-anchored scroll offset. We store it here when the wheel
  // event fires (before React commits the new zoom) and apply it in a
  // layout effect once the canvas has resized to its new dimensions.
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const [stableFrame, setStableFrame] = useState<ImageData | null>(null);
  const [transitionSource, setTransitionSource] = useState<ImageData | null>(null);
  const [revealFrame, setRevealFrame] = useState<ImageData | null>(null);
  const [revealRadius, setRevealRadius] = useState(0);
  const previousFilterRef = useRef(filterName);
  const showOriginal = viewMode === "original";
  const showStudio = viewMode === "studio";
  const activeFrame =
    viewMode === "original"
      ? sourceImageData
      : viewMode === "studio"
        ? (studioImageData ?? filteredImageData)
        : filteredImageData;
  // Respect prefers-reduced-motion: skip the magic reveal transition
  // entirely. The compare slider and view toggle still work; only the
  // blur-and-clip transition is suppressed.
  const prefersReducedMotion = usePrefersReducedMotion();
  const transitionEnabled = !compareMode && !showOriginal && !prefersReducedMotion;

  const liveClipping = useMemo<ClippingChannels | null>(() => {
    if (activeFrame) {
      return detectClippingFromImageData(activeFrame, 0.25);
    }
    return sourceAnalysis?.clippingChannels ?? null;
  }, [activeFrame, sourceAnalysis]);

  const clearReveal = useCallback(() => {
    window.cancelAnimationFrame(revealRafRef.current);
    window.clearTimeout(revealTimeoutRef.current);
    setRevealFrame(null);
    setRevealRadius(0);
  }, []);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(revealRafRef.current);
      window.clearTimeout(revealTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!sourceImageData) {
      setStableFrame(null);
      setTransitionSource(null);
      clearReveal();
      previousFilterRef.current = filterName;
      return;
    }

    previousFilterRef.current = filterName;
    setStableFrame(filteredImageData ?? sourceImageData);
    setTransitionSource(null);
    clearReveal();
  }, [clearReveal, filterName, filteredImageData, image, sourceImageData]);

  // Compute the display dimensions for the image at the current
  // zoom. Used both for the stage's explicit size (so absolutely
  // positioned canvases have a containing box) and for the CSS
  // variables the canvases read via `--filtr-canvas-width` /
  // `--filtr-canvas-height`. Memoized so the size effect below
  // and the stage's inline style agree.
  const displaySize = useMemo(() => {
    if (!image) return null;
    return previewDisplaySize(image, zoom) ?? { width: 0, height: 0 };
  }, [image, zoom]);

  useEffect(() => {
    const previewCanvas = previewCanvasRef.current;
    const originalCanvas = originalCanvasRef.current;
    const studioCanvas = studioCanvasRef.current;
    const revealCanvas = revealCanvasRef.current;
    const stage = stageRef.current;
    if (!previewCanvas || !stage || !displaySize) return;

    // Set CSS dimensions on every canvas. The WebGL canvas's
    // `width`/`height` attributes (the framebuffer size) are set
    // by the backend on first render; CSS sizing is independent
    // and lives here. The original/studio/reveal canvases are 2D
    // and their `width`/`height` is set by `drawOverlayFrame` to
    // match the source frame size.
    for (const c of [previewCanvas, originalCanvas, studioCanvas, revealCanvas]) {
      if (!c) continue;
      c.style.setProperty("--filtr-canvas-width", `${displaySize.width}px`);
      c.style.setProperty("--filtr-canvas-height", `${displaySize.height}px`);
      c.style.setProperty("--filtr-image-rendering", zoom > 175 ? "pixelated" : "auto");
    }
    stage.style.setProperty("--filtr-compare-position", `${comparePosition}%`);
  }, [comparePosition, displaySize, zoom, previewCanvasRef]);

  // Apply the cursor-anchored scroll offset produced by the wheel handler.
  // This is a layout effect so the scroll lands on the same frame the
  // canvas resizes — no visible jump between the zoom change and the
  // scroll snap. The ref is the trigger: we read it, clear it, and apply.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const container = scrollContainerRef.current;
    if (!pending || !container) return;
    pendingScrollRef.current = null;
    container.scrollLeft = pending.left;
    container.scrollTop = pending.top;
  });

  // Draw a 2D `ImageData` into a 2D canvas. Used for the
  // source / studio / reveal overlays; the WebGL preview canvas
  // is written by the backend and never touched here. Resizing
  // the canvas's `width`/`height` clears the framebuffer (per
  // spec), so we only do it when the frame dimensions actually
  // change -- otherwise we'd be doing a redundant clear + realloc
  // on every render.
  const drawOverlayFrame = useCallback((canvas: HTMLCanvasElement | null, frame: ImageData | null) => {
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    if (!frame) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }

    context.clearRect(0, 0, frame.width, frame.height);
    context.putImageData(frame, 0, 0);
  }, []);

  // Redraw the original-canvas overlay when the source data
  // changes. Compare mode and "view original" mode both need
  // the source pixels; drawing them into a separate 2D canvas
  // (above the WebGL preview canvas) means compare mode can
  // show them on the right half via a CSS `clip-path` and
  // "view original" can show them in full -- no `putImageData`
  // into the WebGL canvas, no per-frame compositing.
  useEffect(() => {
    if (!sourceImageData) {
      const ctx = originalCanvasRef.current?.getContext("2d");
      ctx?.clearRect(0, 0, originalCanvasRef.current?.width ?? 0, originalCanvasRef.current?.height ?? 0);
      return;
    }
    drawOverlayFrame(originalCanvasRef.current, sourceImageData);
  }, [sourceImageData, drawOverlayFrame]);

  // Redraw the studio overlay when the studio render resolves.
  useEffect(() => {
    if (!studioImageData) {
      const ctx = studioCanvasRef.current?.getContext("2d");
      ctx?.clearRect(0, 0, studioCanvasRef.current?.width ?? 0, studioCanvasRef.current?.height ?? 0);
      return;
    }
    drawOverlayFrame(studioCanvasRef.current, studioImageData);
  }, [studioImageData, drawOverlayFrame]);

  // Redraw the reveal overlay when the transition source /
  // reveal frame changes. The reveal animation drives
  // `revealRadius` via rAF; the frame is set once at the start
  // of the transition and cleared at the end (via `clearReveal`).
  useEffect(() => {
    drawOverlayFrame(revealCanvasRef.current, revealFrame);
  }, [revealFrame, drawOverlayFrame]);

  useEffect(() => {
    if (!transitionEnabled) {
      clearReveal();
      setTransitionSource(null);
      setStableFrame(filteredImageData ?? sourceImageData);
    }
  }, [clearReveal, filteredImageData, sourceImageData, transitionEnabled]);

  useEffect(() => {
    if (!transitionEnabled || previousFilterRef.current === filterName) return;

    previousFilterRef.current = filterName;
    // On the canvas-bound path, the WebGL backend renders
    // directly into `previewCanvasRef.current`, so the only
    // way to grab the *previous* filtered frame for the
    // transition is to read it from the canvas itself. The
    // preview canvas already has a WebGL2 context, so
    // `getContext('2d')` returns null. We have to draw the
    // WebGL canvas into a *separate* 2D canvas to capture
    // its pixels. The WebGL context is created with
    // `preserveDrawingBuffer: true` (see `webgl-backend.ts`)
    // so the WebGL canvas is still readable at this point.
    //
    // The capture is a one-time cost at filter-change time
    // (~3.8 MB readback on a 1200x800 preview), not per
    // frame. The user explicitly accepts this in exchange
    // for the canvas-bound fast path on the hot render
    // loop. The fallback path (no canvas ref, or capture
    // failed) uses the JS-resolved `filteredImageData` as
    // before.
    const previewCanvas = previewCanvasRef.current;
    if (previewCanvas && previewCanvas.width > 0 && previewCanvas.height > 0) {
      try {
        const capture = document.createElement("canvas");
        capture.width = previewCanvas.width;
        capture.height = previewCanvas.height;
        const ctx = capture.getContext("2d");
        if (ctx) {
          ctx.drawImage(previewCanvas, 0, 0);
          const snapshot = ctx.getImageData(0, 0, capture.width, capture.height);
          clearReveal();
          setTransitionSource(snapshot);
          return;
        }
      } catch (err) {
        // Fall through to the JS-engine path below.
      }
    }
    const currentFrame = revealFrame ?? stableFrame ?? filteredImageData ?? sourceImageData;
    if (!currentFrame) return;

    clearReveal();
    setTransitionSource(currentFrame);
  }, [clearReveal, filterName, filteredImageData, previewCanvasRef, revealFrame, sourceImageData, stableFrame, transitionEnabled]);

  useEffect(() => {
    if (!transitionEnabled || transitionSource || isProcessing) return;
    setStableFrame(filteredImageData ?? sourceImageData);
  }, [filteredImageData, isProcessing, sourceImageData, stableFrame, transitionEnabled, transitionSource]);

  useEffect(() => {
    if (!transitionEnabled || !transitionSource || isProcessing || !filteredImageData) return;

    clearReveal();
    setRevealFrame(filteredImageData);
    setRevealRadius(0);

    revealRafRef.current = window.requestAnimationFrame(() => setRevealRadius(150));
    revealTimeoutRef.current = window.setTimeout(() => {
      setStableFrame(filteredImageData);
      setTransitionSource(null);
      clearReveal();
    }, 560);
  }, [clearReveal, filteredImageData, isProcessing, transitionEnabled, transitionSource]);

  // The old `render` callback used to redraw the base canvas
  // via `putImageData` on every animation frame. That's gone
  // now: the WebGL backend writes the preview directly into
  // `previewCanvasRef.current`, and the overlay canvases are
  // updated by the data-driven effects above (which only run
  // when the underlying `ImageData` actually changes). The
  // transition's rAF loop still drives `revealRadius` for the
  // CSS `clip-path` animation; the reveal canvas itself is
  // updated by the `revealFrame` effect, not by a per-frame
  // redraw. The `rafRef` and the rAF `useEffect` are kept
  // around (empty) for now so future frame-driven work (e.g.
  // the magic-reveal `clip-path` interpolation) has a hook to
  // attach to. The rAF callback is a no-op.
  useEffect(() => {
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(() => {
      // intentionally empty -- the per-frame work moved to the
      // reveal `clip-path` rAF in the transition effect above.
    });
    return () => window.cancelAnimationFrame(rafRef.current);
  }, []);

  const updateCompareFromClientX = useCallback(
    (clientX: number) => {
      const stage = stageRef.current;
      if (!stage) return;

      const bounds = stage.getBoundingClientRect();
      const nextPosition = ((clientX - bounds.left) / bounds.width) * 100;
      onComparePositionChange(Math.max(0, Math.min(100, nextPosition)));
    },
    [onComparePositionChange],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      });

      if (event.pointerType === "touch") {
        event.currentTarget.setPointerCapture(event.pointerId);
        const touchPointers = Array.from(activePointersRef.current.values()).filter((pointer) => pointer.type === "touch");

        if (touchPointers.length === 2) {
          pinchStartRef.current = {
            distance: distanceBetween(touchPointers[0], touchPointers[1]),
            zoom,
          };
          return;
        }
      }

      if (!compareMode || showOriginal) return;

      event.preventDefault();
      updateCompareFromClientX(event.clientX);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [compareMode, showOriginal, updateCompareFromClientX, zoom],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointer = activePointersRef.current.get(event.pointerId);
      if (!pointer) return;

      pointer.x = event.clientX;
      pointer.y = event.clientY;

      const touchPointers = Array.from(activePointersRef.current.values()).filter((entry) => entry.type === "touch");
      if (touchPointers.length === 2 && pinchStartRef.current) {
        event.preventDefault();
        const nextDistance = distanceBetween(touchPointers[0], touchPointers[1]);
        const scale = nextDistance / Math.max(1, pinchStartRef.current.distance);
        onZoomChange(clampZoom(pinchStartRef.current.zoom * scale));
        return;
      }

      if (!compareMode || showOriginal || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      updateCompareFromClientX(event.clientX);
    },
    [compareMode, onZoomChange, showOriginal, updateCompareFromClientX],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    const touchPointers = Array.from(activePointersRef.current.values()).filter((pointer) => pointer.type === "touch");
    if (touchPointers.length < 2) {
      pinchStartRef.current = null;
    }
  }, []);

  // Mouse wheel / trackpad zoom. Both the discrete wheel (mouse) and the
  // smooth trackpad pinch (`ctrlKey: true` on macOS) land here. We anchor
  // the zoom to the cursor so the pixel under the pointer stays under the
  // pointer — the standard image-editor behavior.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!image) return;
      // Let Shift+wheel scroll horizontally as the browser does natively.
      if (event.shiftKey) return;

      const stage = stageRef.current;
      const container = scrollContainerRef.current;
      if (!stage || !container) return;

      event.preventDefault();

      // Trackpad pinch (ctrlKey + deltaY) gives a smooth, fine-grained
      // signal. A regular mouse wheel gives discrete notches with no
      // ctrlKey. We treat the two with different step sizes.
      let nextZoom: number;
      if (event.ctrlKey) {
        // Trackpad pinch: scale the current zoom by a small factor.
        const factor = Math.exp(-event.deltaY / 100);
        nextZoom = clampZoom(zoom * factor);
      } else {
        // Mouse wheel: ±10% per notch. `event.deltaY > 0` means wheel-down
        // which conventionally zooms out.
        const step = 10;
        nextZoom = clampZoom(zoom + (event.deltaY < 0 ? step : -step));
      }
      if (nextZoom === zoom) return;

      // Predict the new stage dimensions so we can anchor the cursor.
      // If the stage isn't laid out yet (offsetWidth === 0), we
      // can't anchor -- just apply the new zoom and let the
      // size effect re-layout on the next render.
      const oldStageWidth = stage.offsetWidth;
      const oldStageHeight = stage.offsetHeight;
      if (oldStageWidth === 0 || oldStageHeight === 0) {
        onZoomChange(nextZoom);
        return;
      }
      const next = previewDisplaySize(image, nextZoom);
      if (!next) return;
      const newStageWidth = next.width;
      const newStageHeight = next.height;

      const stageRect = stage.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      // Cursor position relative to the stage (the canvas wrapper).
      const cursorInStageX = event.clientX - stageRect.left;
      const cursorInStageY = event.clientY - stageRect.top;
      // Express the cursor as a fraction of the current stage, then map
      // that fraction onto the new stage size. The scroll offset we need
      // is whatever places that same canvas point back under the cursor.
      const fractionX = cursorInStageX / oldStageWidth;
      const fractionY = cursorInStageY / oldStageHeight;
      const targetXInNewStage = fractionX * newStageWidth;
      const targetYInNewStage = fractionY * newStageHeight;
      // Convert from "stage coords" to "container scroll coords" using
      // the post-zoom layout. The stage is centered in the container
      // (flex items-center justify-center), so its left edge within the
      // container is (containerWidth - stageWidth) / 2 minus the current
      // scroll on that axis.
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      const stageLeftInContainer = (containerWidth - newStageWidth) / 2;
      const stageTopInContainer = (containerHeight - newStageHeight) / 2;
      const cursorXInContainer = event.clientX - containerRect.left + container.scrollLeft;
      const cursorYInContainer = event.clientY - containerRect.top + container.scrollTop;
      const newScrollLeft = cursorXInContainer - stageLeftInContainer - targetXInNewStage;
      const newScrollTop = cursorYInContainer - stageTopInContainer - targetYInNewStage;

      pendingScrollRef.current = {
        left: Math.max(0, newScrollLeft),
        top: Math.max(0, newScrollTop),
      };
      onZoomChange(nextZoom);
    },
    [image, onZoomChange, zoom],
  );

  // Attach a non-passive wheel listener to the stage so we can call
  // event.preventDefault() without the browser logging a passive-listener
  // warning. React's synthetic onWheel is always passive at the root;
  // a native addEventListener with { passive: false } is the fix.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  if (!image || !sourceImageData) return null;

  const magicActive = transitionEnabled && Boolean(transitionSource);
  const revealActive = magicActive && Boolean(revealFrame);
  const baseCanvasStyle = magicActive
    ? {
        filter: revealActive ? "blur(14px) saturate(0.88) brightness(0.88)" : "blur(18px) saturate(0.82) brightness(0.84)",
        transform: revealActive ? "scale(1.01)" : "scale(1.018)",
      }
    : undefined;
  const revealCanvasStyle = revealActive
    ? {
        clipPath: `circle(${revealRadius}% at 50% 50%)`,
        filter: revealRadius > 1 ? "blur(0px) saturate(1)" : "blur(18px) saturate(1.08)",
        transform: revealRadius > 1 ? "scale(1)" : "scale(1.035)",
        opacity: 1,
        transitionDuration: "560ms",
        transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
      }
    : undefined;

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 flex items-center justify-center overflow-auto p-4"
    >
      <div
        ref={stageRef}
        className={`filtr-stage relative ${compareMode && !showOriginal ? "cursor-ew-resize touch-none" : "cursor-zoom-in"}`}
        style={displaySize ? { width: `${displaySize.width}px`, height: `${displaySize.height}px` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Preview canvas (WebGL framebuffer). The backend
            writes the filtered preview directly into this canvas;
            we never `putImageData` it. The `width`/`height`
            attributes are set by the backend on first render
            (matching the source ImageData dimensions); the CSS
            dimensions are set by the size effect above. Always
            mounted and always sized, but visually hidden in
            "view original" / "view studio" modes via the
            conditional classes below. */}
        <canvas
          ref={previewCanvasRef}
          className={`filtr-main-canvas rounded-lg shadow-2xl transition-[filter,transform] duration-500 ease-out ${
            showOriginal || showStudio ? "hidden" : ""
          }`}
          style={baseCanvasStyle}
        />
        {/* Original canvas (2D). Drawn from `sourceImageData` via
            `drawOverlayFrame`. Shown in two cases:
              - `showOriginal`: full opacity, no clip-path. The
                user is looking at the source pixels.
              - `compareMode && !showOriginal`: the left
                `comparePosition%` is shown (clip-path), the
                right side is left to the WebGL preview canvas
                underneath. The compare position is a CSS
                variable the size effect writes to the stage.
            The canvas is always mounted (so the
            `originalCanvasRef` is stable across view changes)
            but invisible when neither case applies. */}
        <canvas
          ref={originalCanvasRef}
          className={`filtr-main-canvas rounded-lg shadow-2xl transition-[filter,transform] duration-500 ease-out ${
            showOriginal
              ? "opacity-100"
              : compareMode
                ? "opacity-100"
                : "opacity-0 pointer-events-none"
          }`}
          style={
            showOriginal
              ? undefined
              : compareMode
                ? {
                    // Clip-path on the right side: hide the right
                    // `100% - comparePosition%`, leaving the left
                    // `comparePosition%` visible. The line is the
                    // visual divider; the WebGL canvas shows on
                    // the right. CSS `clip-path` with a
                    // percentage is GPU-composited, so this is
                    // essentially free on the render thread.
                    clipPath: `inset(0 calc(100% - var(--filtr-compare-position, 50%)) 0 0)`,
                  }
                : { opacity: 0 }
          }
        />
        {/* Studio canvas (2D). Drawn from `studioImageData` via
            `drawOverlayFrame`. The studio render is the
            full-resolution float32 path produced by the JS
            engine. Shown only in "view studio" mode. */}
        <canvas
          ref={studioCanvasRef}
          className={`filtr-main-canvas rounded-lg shadow-2xl transition-[filter,transform] duration-500 ease-out ${
            showStudio ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          style={showStudio ? undefined : { opacity: 0 }}
        />
        {/* Reveal canvas (2D, transition overlay). Same
            treatment as before -- it briefly appears during the
            magic reveal transition. The frame data is set by
            the transition effect, the radius is animated via
            CSS `clip-path`. */}
        <canvas
          ref={revealCanvasRef}
          className={`filtr-overlay-canvas rounded-lg shadow-[0_0_40px_rgba(255,153,72,0.18)] transition-[clip-path,filter,transform,opacity] ${
            revealActive ? "opacity-100" : "opacity-0"
          }`}
          style={revealCanvasStyle}
        />
        {magicActive ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
            <div className="filtr-render-aura absolute inset-[12%] rounded-[28px]" />
          </div>
        ) : null}
        {compareMode && !showOriginal ? (
          <div className="pointer-events-none absolute inset-y-0 z-10 left-[var(--filtr-compare-position)] -translate-x-1/2">
            <div className="relative h-full">
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/90 shadow-[0_0_18px_rgba(255,255,255,0.28)]" />
              <div className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/45 bg-background/85 shadow-xl backdrop-blur">
                <div className="flex items-center gap-1">
                  <span className="h-4 w-px rounded-full bg-white/80" />
                  <span className="h-4 w-px rounded-full bg-white/80" />
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {isProcessing || studioIsProcessing ? (
          <>
            <div className="pointer-events-none absolute bottom-4 right-4 rounded-full border border-white/10 bg-background/80 px-3 py-1 font-mono-ui text-[10px] uppercase tracking-[0.18em] text-foreground shadow-lg backdrop-blur-md">
              Rendering
            </div>
            <div className="pointer-events-none absolute left-4 top-4 rounded-full border border-white/10 bg-background/70 px-3 py-1 font-mono-ui text-[10px] uppercase tracking-[0.18em] text-primary shadow-lg backdrop-blur-md">
              {filterName}
            </div>
          </>
        ) : null}
        {import.meta.env.DEV && (backendStatus || studioBackendStatus) ? (
          <div
            data-testid="backend-chip"
            className="pointer-events-none absolute bottom-4 right-4 mt-12 rounded-full border border-white/10 bg-background/80 px-3 py-1 font-mono-ui text-[10px] uppercase tracking-[0.18em] text-foreground/80 shadow-lg backdrop-blur-md"
            style={{ transform: "translateY(2.5rem)" }}
          >
            {(() => {
              const status = backendStatus ?? studioBackendStatus;
              if (!status) return "Rendering…";
              if (status.kind === "webgl") return "Rendering on webgl";
              if (status.blurReason) return `Rendering on js (${status.blurReason} active)`;
              return "Rendering on js";
            })()}
          </div>
        ) : null}
        {sourceAnalysis && liveClipping ? (
          <div className="absolute right-4 top-4 z-10">
            <HistogramBadge
              histogram={sourceAnalysis.histogram}
              channelHistogram={sourceAnalysis.channelHistogram}
              clipping={liveClipping}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ImageCanvas;
