import React, { useRef, useEffect, useCallback, useState } from "react";
import { applyFilter, Adjustments } from "@/lib/filterEngine";

interface ImageCanvasProps {
  image: HTMLImageElement | null;
  filterName: string;
  adjustments: Adjustments;
  showBefore: boolean;
  zoom: number;
  onFilterApplied?: () => void;
}

const ImageCanvas: React.FC<ImageCanvasProps> = ({
  image,
  filterName,
  adjustments,
  showBefore,
  zoom,
  onFilterApplied,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const originalDataRef = useRef<ImageData | null>(null);
  const rafRef = useRef<number>(0);
  const [shimmer, setShimmer] = useState(false);
  const prevFilterRef = useRef(filterName);

  // Store original image data
  useEffect(() => {
    if (!image) return;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    originalDataRef.current = ctx.getImageData(0, 0, image.width, image.height);
  }, [image]);

  // Shimmer on filter change
  useEffect(() => {
    if (prevFilterRef.current !== filterName) {
      setShimmer(true);
      const t = setTimeout(() => setShimmer(false), 600);
      prevFilterRef.current = filterName;
      return () => clearTimeout(t);
    }
  }, [filterName]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const original = originalDataRef.current;
    if (!canvas || !original || !image) return;

    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;

    if (showBefore) {
      ctx.putImageData(original, 0, 0);
    } else {
      const filtered = applyFilter(
        original,
        filterName,
        adjustments,
        image.width,
        image.height
      );
      ctx.putImageData(filtered, 0, 0);
    }
    onFilterApplied?.();
  }, [image, filterName, adjustments, showBefore, onFilterApplied]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [render]);

  if (!image) return null;

  // Calculate display size to fit container
  const maxW = 1200;
  const maxH = 800;
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const displayW = image.width * scale * (zoom / 100);
  const displayH = image.height * scale * (zoom / 100);

  return (
    <div
      ref={containerRef}
      className="flex-1 flex items-center justify-center overflow-auto p-4"
    >
      <canvas
        ref={canvasRef}
        className={`rounded-lg shadow-2xl ${shimmer ? "filtr-shimmer" : ""}`}
        style={{
          width: displayW,
          height: displayH,
          imageRendering: zoom > 150 ? "pixelated" : "auto",
        }}
      />
    </div>
  );
};

export default ImageCanvas;
