import React, { useCallback, useEffect, useState } from "react";
import { Copy, Download, Eye, EyeOff, ImageDown, SplitSquareVertical, ZoomIn, ZoomOut } from "lucide-react";
import { prepareFilterSettings, type Adjustments, type ImageAnalysis } from "@/lib/filterEngine";
import { renderFilterOnWorker } from "@/lib/filter-worker";
import {
  showCopyFailedToast,
  showCopyToast,
  showDownloadToast,
} from "@/lib/editorToasts";

type ExportSize = "original" | "2x" | "50%";
type ExportFormat = "jpeg" | "png";

interface BottomBarProps {
  fullImageData: ImageData | null;
  filterName: string;
  filterStrength: number;
  effectIntensity: number;
  analysis: ImageAnalysis | null;
  adjustments: Adjustments;
  fileName: string;
  showBefore: boolean;
  onToggleBefore: () => void;
  compareMode: boolean;
  onCompareModeChange: (value: boolean) => void;
  zoom: number;
  onZoomChange: (value: number) => void;
  exportSignal: number;
}

type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}${month}${day}_${hour}${minute}`;
}

function createExportName(filterName: string, format: ExportFormat): string {
  const extension = format === "png" ? "png" : "jpg";
  return `FILTR_${filterName.toLowerCase().replace(/\s+/g, "_")}_${formatTimestamp()}.${extension}`;
}

function createCanvas(width: number, height: number): RenderCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(canvas: RenderCanvas, format: ExportFormat, quality: number): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({
      type: format === "png" ? "image/png" : "image/jpeg",
      quality: format === "png" ? undefined : quality / 100,
    });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not generate export blob"));
          return;
        }
        resolve(blob);
      },
      format === "png" ? "image/png" : "image/jpeg",
      format === "png" ? undefined : quality / 100,
    );
  });
}

function applyWatermark(canvas: RenderCanvas): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const width = canvas.width;
  const height = canvas.height;

  context.save();
  context.globalAlpha = 0.1;
  context.fillStyle = "#ffffff";
  context.textAlign = "right";
  context.textBaseline = "bottom";
  context.font = `${Math.max(14, Math.round(width * 0.022))}px "DM Mono", monospace`;
  context.fillText("FILTR", width - Math.max(18, width * 0.025), height - Math.max(18, height * 0.025));
  context.restore();
}

function drawImageDataToCanvas(imageData: ImageData): RenderCanvas {
  const canvas = createCanvas(imageData.width, imageData.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create export context");
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function resampleCanvas(source: RenderCanvas, size: ExportSize): RenderCanvas {
  const scale = size === "2x" ? 2 : size === "50%" ? 0.5 : 1;
  if (scale === 1) return source;

  const canvas = createCanvas(
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)),
  );
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create resample context");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const BottomBar: React.FC<BottomBarProps> = ({
  fullImageData,
  filterName,
  filterStrength,
  effectIntensity,
  analysis,
  adjustments,
  fileName,
  showBefore,
  onToggleBefore,
  compareMode,
  onCompareModeChange,
  zoom,
  onZoomChange,
  exportSignal,
}) => {
  const [quality, setQuality] = useState(95);
  const [size, setSize] = useState<ExportSize>("original");
  const [format, setFormat] = useState<ExportFormat>("jpeg");
  const [watermark, setWatermark] = useState(false);
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);

  const renderExportBlob = useCallback(
    async (targetFormat: ExportFormat, targetSize: ExportSize, targetQuality: number, withWatermark: boolean) => {
      if (!fullImageData) return null;

      setExporting(true);

      try {
        const settings = prepareFilterSettings(
          filterName,
          adjustments,
          {
            analysis,
            quality: "export",
            strength: filterStrength,
            effectIntensity,
          },
          analysis ?? undefined,
        );

        const filtered = await renderFilterOnWorker(fullImageData, settings);
        const baseCanvas = drawImageDataToCanvas(filtered);
        const exportCanvas = resampleCanvas(baseCanvas, targetSize);

        if (withWatermark) {
          applyWatermark(exportCanvas);
        }

        return await canvasToBlob(exportCanvas, targetFormat, targetQuality);
      } finally {
        setExporting(false);
      }
    },
    [adjustments, analysis, effectIntensity, filterName, filterStrength, fullImageData],
  );

  const handleDownload = useCallback(async () => {
    const blob = await renderExportBlob(format, size, quality, watermark);
    if (!blob) return;

    const link = document.createElement("a");
    link.download = createExportName(filterName, format);
    link.href = URL.createObjectURL(blob);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showDownloadToast(filterName);
  }, [filterName, format, quality, renderExportBlob, size, watermark]);

  const handleCopy = useCallback(async () => {
    const blob = await renderExportBlob("png", "original", 100, false);
    if (!blob) return;

    setCopying(true);

    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showCopyToast();
    } catch (error) {
      console.error("Copy failed", error);
      showCopyFailedToast();
    }

    window.setTimeout(() => setCopying(false), 1500);
  }, [renderExportBlob]);

  useEffect(() => {
    if (exportSignal === 0) return;
    void handleDownload();
  }, [exportSignal, handleDownload]);

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
        <div className="flex items-center gap-2">
          <ImageDown className="w-3.5 h-3.5 text-muted-foreground" />
          <select
            value={size}
            onChange={(event) => setSize(event.target.value as ExportSize)}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono-ui text-[11px] text-foreground"
          >
            <option value="original">Original</option>
            <option value="2x">2x</option>
            <option value="50%">50%</option>
          </select>
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono-ui text-[11px] text-foreground"
          >
            <option value="jpeg">JPG</option>
            <option value="png">PNG</option>
          </select>
          <select
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono-ui text-[11px] text-foreground"
            disabled={format === "png"}
          >
            <option value={70}>Q70</option>
            <option value={85}>Q85</option>
            <option value={95}>Q95</option>
            <option value={100}>Q100</option>
          </select>
          <label className="flex items-center gap-2 font-mono-ui text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={watermark}
              onChange={(event) => setWatermark(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-border bg-background"
            />
            Watermark
          </label>
        </div>

        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground hover:bg-muted transition-colors font-mono-ui text-[11px]"
          disabled={copying || exporting}
        >
          <Copy className="w-3 h-3" />
          {copying ? "Copied" : "Copy"}
        </button>

        <button
          onClick={() => void handleDownload()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity font-mono-ui text-[11px]"
          disabled={exporting}
        >
          <Download className="w-3 h-3" />
          {exporting ? "Exporting" : `Export ${format === "png" ? "PNG" : "JPG"}`}
        </button>
      </div>
    </div>
  );
};

export default BottomBar;
