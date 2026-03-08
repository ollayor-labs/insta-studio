import React, { useCallback, useState } from "react";
import { Copy, Download, Eye, EyeOff, SplitSquareVertical, ZoomIn, ZoomOut } from "lucide-react";
import {
  applyFilter,
  createImageDataFromImage,
  type Adjustments,
  type ImageAnalysis,
} from "@/lib/filterEngine";
import {
  showCopyFailedToast,
  showCopyToast,
  showDownloadToast,
} from "@/lib/editorToasts";

interface BottomBarProps {
  image: HTMLImageElement | null;
  filterName: string;
  filterStrength: number;
  analysis: ImageAnalysis | null;
  adjustments: Adjustments;
  fileName: string;
  showBefore: boolean;
  onToggleBefore: () => void;
  compareMode: boolean;
  onCompareModeChange: (value: boolean) => void;
  comparePosition: number;
  onComparePositionChange: (value: number) => void;
  zoom: number;
  onZoomChange: (value: number) => void;
}

const BottomBar: React.FC<BottomBarProps> = ({
  image,
  filterName,
  filterStrength,
  analysis,
  adjustments,
  fileName,
  showBefore,
  onToggleBefore,
  compareMode,
  onCompareModeChange,
  comparePosition,
  onComparePositionChange,
  zoom,
  onZoomChange,
}) => {
  const [quality, setQuality] = useState(92);
  const [copying, setCopying] = useState(false);

  const getExportCanvas = useCallback(() => {
    if (!image) return null;

    const original = createImageDataFromImage(image);
    const canvas = document.createElement("canvas");
    canvas.width = original.width;
    canvas.height = original.height;

    const context = canvas.getContext("2d");
    if (!context) return null;

    const filtered = applyFilter(original, filterName, adjustments, original.width, original.height, {
      analysis,
      quality: "export",
      strength: filterStrength,
    });
    context.putImageData(filtered, 0, 0);
    return canvas;
  }, [image, filterName, filterStrength, analysis, adjustments]);

  const handleDownload = useCallback(() => {
    const canvas = getExportCanvas();
    if (!canvas) return;

    const baseName = fileName.replace(/\.[^.]+$/, "");
    const timestamp = Date.now();
    const exportName = `${baseName}_${filterName.toLowerCase().replace(/\s/g, "_")}_${timestamp}.jpg`;
    const link = document.createElement("a");
    link.download = exportName;
    link.href = canvas.toDataURL("image/jpeg", quality / 100);
    link.click();
    showDownloadToast(filterName);
  }, [fileName, filterName, getExportCanvas, quality]);

  const handleCopy = useCallback(async () => {
    const canvas = getExportCanvas();
    if (!canvas) return;

    setCopying(true);

    try {
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((value) => resolve(value as Blob), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showCopyToast();
    } catch (error) {
      console.error("Copy failed", error);
      showCopyFailedToast();
    }

    window.setTimeout(() => setCopying(false), 1500);
  }, [getExportCanvas]);

  return (
    <div className="min-h-12 border-t border-border bg-card flex flex-wrap items-center justify-between px-4 py-2 gap-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleBefore}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors font-mono-ui text-[11px]"
        >
          {showBefore ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showBefore ? "Original" : "Edited"}
        </button>

        <button
          onClick={() => onCompareModeChange(!compareMode)}
          className={`flex items-center gap-1.5 font-mono-ui text-[11px] transition-colors ${
            compareMode ? "text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <SplitSquareVertical className="w-3.5 h-3.5" />
          Compare
        </button>

        {compareMode ? (
          <span className="font-mono-ui text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            Drag slider on image
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onZoomChange(Math.max(25, zoom - 25))}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums w-10 text-center">
          {zoom}%
        </span>
        <button
          onClick={() => onZoomChange(Math.min(400, zoom + 25))}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap justify-end">
        <div className="flex items-center gap-1.5">
          <span className="font-mono-ui text-[10px] text-muted-foreground">Q</span>
          <input
            type="range"
            min={60}
            max={100}
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
            className="filtr-slider w-16"
          />
          <span className="font-mono-ui text-[10px] text-secondary-foreground tabular-nums w-8">
            {quality}%
          </span>
        </div>

        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground hover:bg-muted transition-colors font-mono-ui text-[11px]"
        >
          <Copy className="w-3 h-3" />
          {copying ? "Copied" : "Copy"}
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
