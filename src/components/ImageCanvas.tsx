import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import HistogramBadge from "@/components/HistogramBadge";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { detectClippingFromImageData, type ClippingChannels, type ImageAnalysis } from "@/lib/filterEngine";

interface ImageCanvasProps {
  image: HTMLImageElement | null;
  filterName: string;
  sourceImageData: ImageData | null;
  filteredImageData: ImageData | null;
  studioImageData: ImageData | null;
  viewMode: "edited" | "original" | "studio";
  compareMode: boolean;
  comparePosition: number;
  onComparePositionChange: (value: number) => void;
  zoom: number;
  onZoomChange: (value: number) => void;
  isProcessing: boolean;
  studioIsProcessing?: boolean;
  sourceAnalysis: ImageAnalysis | null;
}

function clampZoom(value: number): number {
  return Math.max(25, Math.min(400, Math.round(value)));
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
  viewMode,
  compareMode,
  comparePosition,
  onComparePositionChange,
  zoom,
  onZoomChange,
  isProcessing,
  studioIsProcessing = false,
  sourceAnalysis,
}) => {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
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

  useEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const revealCanvas = revealCanvasRef.current;
    const stage = stageRef.current;
    if (!baseCanvas || !stage || !image) return;

    const maxWidth = 1200;
    const maxHeight = 800;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const displayWidth = image.width * scale * (zoom / 100);
    const displayHeight = image.height * scale * (zoom / 100);

    baseCanvas.style.setProperty("--filtr-canvas-width", `${displayWidth}px`);
    baseCanvas.style.setProperty("--filtr-canvas-height", `${displayHeight}px`);
    baseCanvas.style.setProperty("--filtr-image-rendering", zoom > 175 ? "pixelated" : "auto");
    revealCanvas?.style.setProperty("--filtr-canvas-width", `${displayWidth}px`);
    revealCanvas?.style.setProperty("--filtr-canvas-height", `${displayHeight}px`);
    revealCanvas?.style.setProperty("--filtr-image-rendering", zoom > 175 ? "pixelated" : "auto");
    stage.style.setProperty("--filtr-compare-position", `${comparePosition}%`);
  }, [comparePosition, image, zoom]);

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

  const drawSingleFrame = useCallback((canvas: HTMLCanvasElement | null, frame: ImageData | null) => {
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    if (!frame) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    canvas.width = frame.width;
    canvas.height = frame.height;

    context.clearRect(0, 0, frame.width, frame.height);
    context.putImageData(frame, 0, 0);
  }, []);

  const drawCompositeFrame = useCallback((canvas: HTMLCanvasElement | null) => {
    const source = sourceImageData;
    if (!canvas || !source) return;

    canvas.width = source.width;
    canvas.height = source.height;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, source.width, source.height);

    if (showOriginal || !activeFrame) {
      context.putImageData(source, 0, 0);
      return;
    }

    context.putImageData(activeFrame, 0, 0);

    if (compareMode) {
      const splitX = Math.max(0, Math.min(source.width, Math.round(source.width * (comparePosition / 100))));
      context.putImageData(source, 0, 0, 0, 0, splitX, source.height);
    }
  }, [activeFrame, compareMode, comparePosition, showOriginal, sourceImageData]);

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
    const currentFrame = revealFrame ?? stableFrame ?? filteredImageData ?? sourceImageData;
    if (!currentFrame) return;

    clearReveal();
    setTransitionSource(currentFrame);
  }, [clearReveal, filterName, filteredImageData, revealFrame, sourceImageData, stableFrame, transitionEnabled]);

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

  const render = useCallback(() => {
    const baseCanvas = baseCanvasRef.current;
    const revealCanvas = revealCanvasRef.current;
    if (!baseCanvas || !sourceImageData) return;

    if (!transitionEnabled) {
      drawCompositeFrame(baseCanvas);
      drawSingleFrame(revealCanvas, null);
      return;
    }

    drawSingleFrame(baseCanvas, transitionSource ?? stableFrame ?? activeFrame);
    drawSingleFrame(revealCanvas, revealFrame);
  }, [
    activeFrame,
    drawCompositeFrame,
    drawSingleFrame,
    revealFrame,
    sourceImageData,
    stableFrame,
    transitionEnabled,
    transitionSource,
  ]);

  useEffect(() => {
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, [render]);

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
    (event: React.WheelEvent<HTMLDivElement>) => {
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

      // Predict the new stage dimensions so we can anchor the cursor. The
      // stage is the canvas wrapper; its width/height equal the canvas
      // display size, which is `image.width * scale * (zoom / 100)`.
      const maxWidth = 1200;
      const maxHeight = 800;
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
      const oldStageWidth = stage.offsetWidth;
      const oldStageHeight = stage.offsetHeight;
      const newStageWidth = image.width * scale * (nextZoom / 100);
      const newStageHeight = image.height * scale * (nextZoom / 100);
      if (oldStageWidth === 0 || oldStageHeight === 0) {
        onZoomChange(nextZoom);
        return;
      }

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
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <canvas
          ref={baseCanvasRef}
          className="filtr-main-canvas rounded-lg shadow-2xl transition-[filter,transform] duration-500 ease-out"
          style={baseCanvasStyle}
        />
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
