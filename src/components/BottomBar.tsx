import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Download, ImageDown, Play, Redo2, SplitSquareVertical, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { prepareFilterSettings, type Adjustments, type ImageAnalysis } from '@/lib/filterEngine';
import { renderFilterOnWorker } from '@/lib/filter-worker';
import { resolveExportExtension, resolveExportMime } from '@/lib/exportFormat';
import { getExifOrientation, withExifInjected } from '@/lib/exif';
import { showCopyFailedToast, showCopyToast, showDownloadToast } from '@/lib/editorToasts';
import { SlotLabel } from '@/components/ui/slot-label';

type ExportSize = 'original' | '2x' | '50%';
type ExportFormat = 'jpeg' | 'png' | 'webp' | 'original';

interface BottomBarProps {
  /**
   * The full-resolution raster, if already materialized by another
   * consumer (typically the live preview at `useFullResolution`).
   * May be `null` even when the user is editing -- the full raster
   * is now lazy (see `useFilter`'s `getFullImageData`). Use
   * `getFullImageData` from props to materialize it on demand at
   * export time. The export call awaits this so the user only pays
   * the ~48 MB allocation on the click that needs it, not on import.
   */
  fullImageData: ImageData | null;
  getFullImageData: () => ImageData | null;
  /**
   * True once the user has loaded any image. The Reveal button
   * gates on this, not on `fullImageData` -- the auto-reveal
   * animation runs against the live preview, which only needs the
   * preview raster to be ready.
   */
  hasImage: boolean;
  filterName: string;
  filterStrength: number;
  effectIntensity: number;
  analysis: ImageAnalysis | null;
  adjustments: Adjustments;
  fileName: string;
  sourceMimeType: string | null;
  currentExifBytes: Uint8Array | null;
  viewMode: 'edited' | 'original' | 'studio';
  onViewModeChange: (value: 'edited' | 'original' | 'studio') => void;
  compareMode: boolean;
  onCompareModeChange: (value: boolean) => void;
  compareReveal: 'off' | 'playing';
  onPlayReveal: () => void;
  zoom: number;
  onZoomChange: (value: number) => void;
  exportSignal: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}${month}${day}_${hour}${minute}`;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  const userAgent = navigator.userAgent ?? '';
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(userAgent);
}

function createExportName(filterName: string, format: ExportFormat, sourceMimeType: string | null = null): string {
  const extension = resolveExportExtension(format, sourceMimeType);
  return `insta-studio_${filterName.toLowerCase().replace(/\s+/g, '_')}_${formatTimestamp()}.${extension}`;
}

function createCanvas(width: number, height: number): RenderCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(
  canvas: RenderCanvas,
  format: ExportFormat,
  quality: number,
  sourceMimeType: string | null = null,
): Promise<Blob> {
  const mime = resolveExportMime(format, sourceMimeType);
  const isLossless = mime === 'image/png';
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({
      type: mime,
      quality: isLossless ? undefined : quality / 100,
    });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Could not generate export blob'));
          return;
        }
        resolve(blob);
      },
      mime,
      isLossless ? undefined : quality / 100,
    );
  });
}

function applyWatermark(canvas: RenderCanvas): void {
  const context = canvas.getContext('2d');
  if (!context) return;

  const width = canvas.width;
  const height = canvas.height;

  context.save();
  context.globalAlpha = 0.1;
  context.fillStyle = '#ffffff';
  context.textAlign = 'right';
  context.textBaseline = 'bottom';
  context.font = `${Math.max(14, Math.round(width * 0.022))}px "DM Mono", monospace`;
  context.fillText('insta-studio', width - Math.max(18, width * 0.025), height - Math.max(18, height * 0.025));
  context.restore();
}

// Maps an EXIF orientation value (1..8) to the (width, height) of the
// post-orientation bitmap. Rotations 5..8 swap the dimensions; mirrors
// keep them.
function orientedDimensions(width: number, height: number, orientation: number): { width: number; height: number } {
  if (orientation >= 5 && orientation <= 8) {
    return { width: height, height: width };
  }
  return { width, height };
}

// Draws the rendered ImageData onto a canvas that has been rotated /
// mirrored to match the EXIF orientation. The putImageData call paints
// the pixels in the canvas's local coordinate system; the canvas itself
// is sized to the *oriented* dimensions so the rest of the export
// pipeline (resample, encode) sees the correct shape.
function drawImageDataToCanvas(imageData: ImageData, orientation: number): RenderCanvas {
  const { width, height } = orientedDimensions(imageData.width, imageData.height, orientation);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create export context');
  }

  if (orientation === 1) {
    context.putImageData(imageData, 0, 0);
    return canvas;
  }

  // The 8 EXIF orientations map to the canvas transform that turns
  // the source-coordinate bitmap into the display-coordinate bitmap.
  // We translate+rotate+scale to map (0,0)..(w,h) into the oriented
  // bounding box, then draw the image data offset so putImageData
  // hits the right slot in the buffer.
  switch (orientation) {
    case 2: // horizontal flip
      context.translate(width, 0);
      context.scale(-1, 1);
      context.putImageData(imageData, 0, 0);
      break;
    case 3: // 180° rotation
      context.translate(width, height);
      context.rotate(Math.PI);
      context.putImageData(imageData, 0, 0);
      break;
    case 4: // vertical flip
      context.translate(0, height);
      context.scale(1, -1);
      context.putImageData(imageData, 0, 0);
      break;
    case 5: // 90° CW + horizontal flip (transpose)
      context.rotate(Math.PI / 2);
      context.scale(1, -1);
      context.putImageData(imageData, 0, 0);
      break;
    case 6: // 90° CW
      context.rotate(Math.PI / 2);
      context.translate(0, -imageData.width);
      context.putImageData(imageData, 0, 0);
      break;
    case 7: // 90° CW + vertical flip (transverse)
      context.rotate(Math.PI / 2);
      context.translate(height, -imageData.width);
      context.scale(-1, 1);
      context.putImageData(imageData, 0, 0);
      break;
    case 8: // 90° CCW
      context.rotate(-Math.PI / 2);
      context.translate(-height, 0);
      context.putImageData(imageData, 0, 0);
      break;
    default:
      context.putImageData(imageData, 0, 0);
      break;
  }
  return canvas;
}

function resampleCanvas(source: RenderCanvas, size: ExportSize): RenderCanvas {
  const scale = size === '2x' ? 2 : size === '50%' ? 0.5 : 1;
  if (scale === 1) return source;

  const canvas = createCanvas(
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)),
  );
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create resample context');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const BottomBar: React.FC<BottomBarProps> = ({
  fullImageData,
  getFullImageData,
  hasImage,
  filterName,
  filterStrength,
  effectIntensity,
  analysis,
  adjustments,
  _fileName,
  sourceMimeType,
  currentExifBytes,
  viewMode,
  onViewModeChange,
  compareMode,
  onCompareModeChange,
  compareReveal,
  onPlayReveal,
  zoom,
  onZoomChange,
  exportSignal,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}) => {
  const [quality, setQuality] = useState(95);
  const [size, setSize] = useState<ExportSize>('original');
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  const [watermark, setWatermark] = useState(false);
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);

  const renderExportBlob = useCallback(
    async (targetFormat: ExportFormat, targetSize: ExportSize, targetQuality: number, withWatermark: boolean) => {
      // The full-resolution raster is now lazy. The hook
      // materializes it on first call and caches it for the
      // lifetime of the current image; the second export reuses
      // the same `ImageData` (no re-allocation). The first call
      // pays the cost; the rest of the session doesn't.
      const fullRaster = fullImageData ?? getFullImageData();
      if (!fullRaster) return null;

      setExporting(true);

      try {
        const settings = prepareFilterSettings(
          filterName,
          adjustments,
          {
            analysis,
            quality: 'export',
            strength: filterStrength,
            effectIntensity,
            // Run the export through the Float32 pipeline to keep sub-LSB
            // precision across the 5+ passes and avoid the per-pass
            // rounding that produces banding in smooth gradients. Preview
            // (the live canvas) stays on Uint8 for speed.
            precision: 'float32',
          },
          analysis ?? undefined,
        );

        const filtered = await renderFilterOnWorker(fullRaster, settings);
        // Apply EXIF orientation to the rendered pixels so a portrait-
        // orientation phone photo comes out the right way up. The
        // metadata re-injection below still tags the file with the
        // original orientation; downstream readers that *don't* honour
        // EXIF will see the correctly-oriented pixels.
        const orientation = getExifOrientation(currentExifBytes);
        const baseCanvas = drawImageDataToCanvas(filtered, orientation);
        const exportCanvas = resampleCanvas(baseCanvas, targetSize);

        if (withWatermark) {
          applyWatermark(exportCanvas);
        }

        const resolvedMime = resolveExportMime(targetFormat, sourceMimeType);
        const rawBlob = await canvasToBlob(exportCanvas, targetFormat, targetQuality, sourceMimeType);
        // Re-inject the original EXIF payload (JPEG, PNG, and WebP all
        // support it). The canvas encoder strips it; this restores the
        // user's orientation, camera info, etc. The dispatch lives in
        // `lib/exif.ts` and is format-aware underneath, but the storage
        // shape we pass in is format-agnostic (bare TIFF) thanks to the
        // import-time reader.
        if (resolvedMime === 'image/jpeg' || resolvedMime === 'image/png' || resolvedMime === 'image/webp') {
          return await withExifInjected(rawBlob, currentExifBytes);
        }
        return rawBlob;
      } finally {
        setExporting(false);
      }
    },
    [
      adjustments,
      analysis,
      currentExifBytes,
      effectIntensity,
      filterName,
      filterStrength,
      fullImageData,
      getFullImageData,
      sourceMimeType,
    ],
  );

  const handleDownload = useCallback(async () => {
    const blob = await renderExportBlob(format, size, quality, watermark);
    if (!blob) return;

    const link = document.createElement('a');
    link.download = createExportName(filterName, format, sourceMimeType);
    link.href = URL.createObjectURL(blob);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showDownloadToast(filterName);
  }, [filterName, format, quality, renderExportBlob, size, sourceMimeType, watermark]);

  const handleCopy = useCallback(async () => {
    const blob = await renderExportBlob('png', 'original', 100, false);
    if (!blob) return;

    setCopying(true);

    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showCopyToast();
    } catch (error) {
      console.error('Copy failed', error);
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
        <div
          className="flex items-center gap-0.5 rounded-full border border-border bg-background/60 p-0.5 font-mono-ui text-[10px] uppercase tracking-[0.14em]"
          role="radiogroup"
          aria-label="Compare view"
        >
          {(
            [
              { value: 'edited', label: 'B' },
              { value: 'original', label: 'A' },
              { value: 'studio', label: 'C' },
            ] as const
          ).map((entry) => {
            const active = viewMode === entry.value;
            const fullLabel =
              entry.value === 'edited' ? 'B · Adaptive' : entry.value === 'original' ? 'A · Original' : 'C · Studio';
            return (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={active}
                title={fullLabel}
                onClick={() => onViewModeChange(entry.value)}
                className={`flex h-6 w-7 items-center justify-center rounded-full transition-colors ${
                  active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <span className="font-mono-ui text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          {viewMode === 'edited' ? 'B · Adaptive' : viewMode === 'original' ? 'A · Original' : 'C · Studio'}
        </span>

        <button
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo"
          title={isMacPlatform() ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'}
          data-testid="undo-button"
          className="flex items-center gap-1.5 font-mono-ui text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Undo
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo"
          title={isMacPlatform() ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Shift+Z)'}
          data-testid="redo-button"
          className="flex items-center gap-1.5 font-mono-ui text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
        >
          <Redo2 className="w-3.5 h-3.5" />
          Redo
        </button>

        <button
          onClick={() => onCompareModeChange(!compareMode)}
          className={`flex items-center gap-1.5 font-mono-ui text-[11px] transition-colors ${
            compareMode ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <SplitSquareVertical className="w-3.5 h-3.5" />
          Compare
        </button>

        <button
          onClick={onPlayReveal}
          disabled={!hasImage}
          className={`flex items-center gap-1.5 font-mono-ui text-[11px] transition-colors ${
            compareReveal === 'playing'
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground'
          }`}
          title="Play an animated before/after reveal (Shift+C)"
        >
          <Play className="w-3.5 h-3.5" />
          <SlotLabel
            text={compareReveal === 'playing' ? 'Revealing…' : 'Reveal'}
            flashColor={compareReveal === 'playing'}
            skipUnchanged
            tone="inherit"
          />
        </button>

        {compareMode ? (
          <span className="font-mono-ui text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            <SlotLabel
              text={compareReveal === 'playing' ? 'Auto-cycling' : 'Drag slider on image'}
              flashColor={compareReveal === 'playing'}
              skipUnchanged
              tone="subtle"
            />
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
            title="PNG is lossless; JPG/WebP are lossy. &#39;Original&#39; preserves the source format when it&#39;s a supported export type, otherwise falls back to JPG."
          >
            <option value="jpeg">JPG</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
            <option value="original">Original</option>
          </select>
          <select
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono-ui text-[11px] text-foreground"
            disabled={resolveExportMime(format, sourceMimeType) === 'image/png'}
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
          <SlotLabel text={copying ? 'Copied' : 'Copy'} flashColor={copying} tone="muted" />
        </button>

        <button
          onClick={() => void handleDownload()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity font-mono-ui text-[11px]"
          disabled={exporting}
        >
          <Download className="w-3 h-3" />
          <SlotLabel
            text={exporting ? 'Exporting' : `Export ${format === 'png' ? 'PNG' : 'JPG'}`}
            flashColor={exporting}
            tone="inherit"
          />
        </button>
      </div>
    </div>
  );
};

export default BottomBar;
