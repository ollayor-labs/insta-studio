import React, { useCallback, useRef, useState } from "react";
import { Download, Copy, Eye, EyeOff, ZoomIn, ZoomOut } from "lucide-react";
import { applyFilter, Adjustments, defaultAdjustments } from "@/lib/filterEngine";

interface BottomBarProps {
  image: HTMLImageElement | null;
  filterName: string;
  adjustments: Adjustments;
  fileName: string;
  showBefore: boolean;
  onToggleBefore: () => void;
  zoom: number;
  onZoomChange: (z: number) => void;
}

const BottomBar: React.FC<BottomBarProps> = ({
  image, filterName, adjustments, fileName,
  showBefore, onToggleBefore, zoom, onZoomChange,
}) => {
  const [quality, setQuality] = useState(92);
  const [copying, setCopying] = useState(false);

  const getExportCanvas = useCallback(() => {
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const original = ctx.getImageData(0, 0, image.width, image.height);
    const filtered = applyFilter(original, filterName, adjustments, image.width, image.height);
    ctx.putImageData(filtered, 0, 0);
    return canvas;
  }, [image, filterName, adjustments]);

  const handleDownload = useCallback(() => {
    const canvas = getExportCanvas();
    if (!canvas) return;
    const base = fileName.replace(/\.[^.]+$/, "");
    const ts = Date.now();
    const name = `${base}_${filterName.toLowerCase().replace(/\s/g, "_")}_${ts}.jpg`;
    const link = document.createElement("a");
    link.download = name;
    link.href = canvas.toDataURL("image/jpeg", quality / 100);
    link.click();
  }, [getExportCanvas, fileName, filterName, quality]);

  const handleCopy = useCallback(async () => {
    const canvas = getExportCanvas();
    if (!canvas) return;
    setCopying(true);
    try {
      const blob = await new Promise<Blob>((res) =>
        canvas.toBlob((b) => res(b!), "image/png")
      );
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (e) {
      console.error("Copy failed", e);
    }
    setTimeout(() => setCopying(false), 1500);
  }, [getExportCanvas]);

  return (
    <div className="h-12 border-t border-border bg-card flex items-center justify-between px-4 gap-4">
      {/* Left: Before/After */}
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleBefore}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors font-mono-ui text-[11px]"
        >
          {showBefore ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showBefore ? "Before" : "After"}
        </button>
        <span className="text-muted-foreground/30 font-mono-ui text-[10px]">
          <kbd className="px-1 py-0.5 rounded border border-border bg-secondary text-[9px]">Space</kbd>
        </span>
      </div>

      {/* Center: Zoom */}
      <div className="flex items-center gap-2">
        <button onClick={() => onZoomChange(Math.max(25, zoom - 25))} className="text-muted-foreground hover:text-foreground transition-colors">
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums w-10 text-center">
          {zoom}%
        </span>
        <button onClick={() => onZoomChange(Math.min(400, zoom + 25))} className="text-muted-foreground hover:text-foreground transition-colors">
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Right: Export */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono-ui text-[10px] text-muted-foreground">Q:</span>
          <input
            type="range"
            min={60}
            max={100}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="filtr-slider w-16"
          />
          <span className="font-mono-ui text-[10px] text-secondary-foreground tabular-nums w-6">{quality}%</span>
        </div>

        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground hover:bg-muted transition-colors font-mono-ui text-[11px]"
        >
          <Copy className="w-3 h-3" />
          {copying ? "Copied!" : "Copy"}
        </button>

        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity font-mono-ui text-[11px]"
        >
          <Download className="w-3 h-3" />
          Export JPG
        </button>
      </div>
    </div>
  );
};

export default BottomBar;
