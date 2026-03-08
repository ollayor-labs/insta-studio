import React, { useCallback, useEffect, useRef, useState } from "react";

interface ImageCanvasProps {
  image: HTMLImageElement | null;
  filterName: string;
  sourceImageData: ImageData | null;
  filteredImageData: ImageData | null;
  showBefore: boolean;
  compareMode: boolean;
  comparePosition: number;
  onComparePositionChange: (value: number) => void;
  zoom: number;
  onZoomChange: (value: number) => void;
  isProcessing: boolean;
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
  showBefore,
  compareMode,
  comparePosition,
  onComparePositionChange,
  zoom,
  onZoomChange,
  isProcessing,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const activePointersRef = useRef<Map<number, { x: number; y: number; type: string }>>(new Map());
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  const [switching, setSwitching] = useState(false);
  const previousFilterRef = useRef(filterName);

  useEffect(() => {
    if (previousFilterRef.current !== filterName) {
      previousFilterRef.current = filterName;
      setSwitching(true);
      const timeout = window.setTimeout(() => setSwitching(false), 100);
      return () => window.clearTimeout(timeout);
    }
  }, [filterName]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !image) return;

    const maxWidth = 1200;
    const maxHeight = 800;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const displayWidth = image.width * scale * (zoom / 100);
    const displayHeight = image.height * scale * (zoom / 100);

    canvas.style.setProperty("--filtr-canvas-width", `${displayWidth}px`);
    canvas.style.setProperty("--filtr-canvas-height", `${displayHeight}px`);
    canvas.style.setProperty("--filtr-image-rendering", zoom > 175 ? "pixelated" : "auto");
    stage.style.setProperty("--filtr-compare-position", `${comparePosition}%`);
  }, [comparePosition, image, zoom]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const source = sourceImageData;
    if (!canvas || !source) return;

    canvas.width = source.width;
    canvas.height = source.height;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, source.width, source.height);

    if (showBefore || !filteredImageData) {
      context.putImageData(source, 0, 0);
      return;
    }

    context.putImageData(filteredImageData, 0, 0);

    if (compareMode) {
      const splitX = Math.max(0, Math.min(source.width, Math.round(source.width * (comparePosition / 100))));
      context.putImageData(source, 0, 0, 0, 0, splitX, source.height);
    }
  }, [compareMode, comparePosition, filteredImageData, showBefore, sourceImageData]);

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

      if (!compareMode || showBefore) return;

      event.preventDefault();
      updateCompareFromClientX(event.clientX);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [compareMode, showBefore, updateCompareFromClientX, zoom],
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

      if (!compareMode || showBefore || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      updateCompareFromClientX(event.clientX);
    },
    [compareMode, onZoomChange, showBefore, updateCompareFromClientX],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    const touchPointers = Array.from(activePointersRef.current.values()).filter((pointer) => pointer.type === "touch");
    if (touchPointers.length < 2) {
      pinchStartRef.current = null;
    }
  }, []);

  if (!image || !sourceImageData) return null;

  return (
    <div className="flex-1 flex items-center justify-center overflow-auto p-4">
      <div
        ref={stageRef}
        className={`filtr-stage relative ${compareMode && !showBefore ? "cursor-ew-resize touch-none" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <canvas
          ref={canvasRef}
          className={`filtr-main-canvas rounded-lg shadow-2xl transition-opacity duration-100 ${
            switching ? "opacity-70" : "opacity-100"
          }`}
        />
        {compareMode && !showBefore ? (
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
        {isProcessing ? (
          <div className="pointer-events-none absolute bottom-4 right-4 rounded-full bg-background/85 px-3 py-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-foreground shadow-lg">
            Rendering
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ImageCanvas;
