import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  applyFilter,
  createImageDataFromImage,
  type Adjustments,
  type ImageAnalysis,
} from "@/lib/filterEngine";

interface ImageCanvasProps {
  image: HTMLImageElement | null;
  filterName: string;
  filterStrength: number;
  adjustments: Adjustments;
  analysis: ImageAnalysis | null;
  showBefore: boolean;
  compareMode: boolean;
  comparePosition: number;
  onComparePositionChange: (value: number) => void;
  zoom: number;
  onFilterApplied?: () => void;
}

const PREVIEW_MAX_DIMENSION = 1600;

const ImageCanvas: React.FC<ImageCanvasProps> = ({
  image,
  filterName,
  filterStrength,
  adjustments,
  analysis,
  showBefore,
  compareMode,
  comparePosition,
  onComparePositionChange,
  zoom,
  onFilterApplied,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewDataRef = useRef<ImageData | null>(null);
  const fullDataRef = useRef<ImageData | null>(null);
  const rafRef = useRef<number>(0);
  const [shimmer, setShimmer] = useState(false);
  const previousFilterRef = useRef(filterName);

  useEffect(() => {
    if (!image) return;
    fullDataRef.current = createImageDataFromImage(image);
    previewDataRef.current = createImageDataFromImage(image, PREVIEW_MAX_DIMENSION);
  }, [image]);

  useEffect(() => {
    if (previousFilterRef.current !== filterName) {
      setShimmer(true);
      const timeout = window.setTimeout(() => setShimmer(false), 450);
      previousFilterRef.current = filterName;
      return () => window.clearTimeout(timeout);
    }
  }, [filterName]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;

    const previewData = previewDataRef.current;
    const fullData = fullDataRef.current;
    const useFullResolution = zoom > 150 || !previewData || !fullData || previewData.width === fullData.width;
    const source = useFullResolution ? fullData : previewData;

    if (!source) return;

    canvas.width = source.width;
    canvas.height = source.height;

    const context = canvas.getContext("2d");
    if (!context) return;

    if (showBefore) {
      context.putImageData(source, 0, 0);
      onFilterApplied?.();
      return;
    }

    const filtered = applyFilter(source, filterName, adjustments, source.width, source.height, {
      analysis,
      quality: "preview",
      strength: filterStrength,
    });

    context.putImageData(filtered, 0, 0);

    if (compareMode) {
      const splitX = Math.max(0, Math.min(source.width, Math.round(source.width * (comparePosition / 100))));
      context.putImageData(source, 0, 0, 0, 0, splitX, source.height);
      context.strokeStyle = "rgba(221, 183, 106, 0.9)";
      context.lineWidth = Math.max(2, source.width / 600);
      context.beginPath();
      context.moveTo(splitX + 0.5, 0);
      context.lineTo(splitX + 0.5, source.height);
      context.stroke();
    }

    onFilterApplied?.();
  }, [image, zoom, showBefore, compareMode, comparePosition, filterName, filterStrength, adjustments, analysis, onFilterApplied]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
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

  const handleComparePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!compareMode || showBefore) return;

      event.preventDefault();
      updateCompareFromClientX(event.clientX);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [compareMode, showBefore, updateCompareFromClientX],
  );

  const handleComparePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!compareMode || showBefore || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      updateCompareFromClientX(event.clientX);
    },
    [compareMode, showBefore, updateCompareFromClientX],
  );

  if (!image) return null;

  const maxWidth = 1200;
  const maxHeight = 800;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const displayWidth = image.width * scale * (zoom / 100);
  const displayHeight = image.height * scale * (zoom / 100);

  return (
    <div className="flex-1 flex items-center justify-center overflow-auto p-4">
      <div
        ref={stageRef}
        className={`relative ${compareMode && !showBefore ? "cursor-ew-resize touch-none" : ""}`}
        onPointerDown={handleComparePointerDown}
        onPointerMove={handleComparePointerMove}
      >
        <canvas
          ref={canvasRef}
          className={`rounded-lg shadow-2xl ${shimmer ? "filtr-shimmer" : ""}`}
          style={{
            width: displayWidth,
            height: displayHeight,
            imageRendering: zoom > 175 ? "pixelated" : "auto",
          }}
        />
        {compareMode && !showBefore ? (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 z-10 -translate-x-1/2"
              style={{ left: `${comparePosition}%` }}
            >
              <div className="relative h-full">
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary/90 shadow-[0_0_18px_rgba(221,183,106,0.35)]" />
                <div className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-primary/60 bg-background/85 shadow-xl backdrop-blur">
                  <div className="flex items-center gap-1">
                    <span className="h-4 w-px rounded-full bg-primary/70" />
                    <span className="h-4 w-px rounded-full bg-primary/70" />
                  </div>
                </div>
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-3 py-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-foreground shadow-lg">
              Drag To Compare
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default ImageCanvas;
