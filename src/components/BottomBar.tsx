import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Crop, Download, ImageDown, Play, Redo2, SplitSquareVertical, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { prepareFilterSettings, type Adjustments, type ImageAnalysis } from '@/lib/filterEngine';
import { renderFilterOnWorker } from '@/lib/filter-worker';
import { resolveExportExtension, resolveExportMime } from '@/lib/exportFormat';
import { getExifOrientation, withExifInjected } from '@/lib/exif';
import { drawTextLayers } from '@/lib/text/renderTextLayers';
import type { TextLayer } from '@/lib/text/types';
import { stripGpsFromJpegDataUrl, type MetadataPrivacy } from '@/lib/metadata';
import {
  showCopyFailedToast,
  showCopyToast,
} from '@/lib/editorToasts';
import { SlotLabel } from '@/components/ui/slot-label';
import { detectActiveRatio, formatRatioLabel, type CropState } from '@/lib/crop';
import { cropImageDataOffscreen } from '@/lib/crop';
import {
  getExportProfile,
  applyUnsharpMask,
  resampleForProfile,
  resolveTargetDimensions,
  type ExportProfile,
  type ExportProfileId,
  type ExportHistoryRecord,
} from '@/lib/export';
import ExportProfileMenu from '@/components/ExportProfileMenu';
import RecentExportsMenu from '@/components/RecentExportsMenu';

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
  /** Text layers flattened into the export (normalized to image space). */
  textLayers?: TextLayer[];
  /** Metadata privacy choice applied at export time. */
  metadataPrivacy?: MetadataPrivacy;
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
  /** Current crop state. Applied to the export pipeline so the
   *  downloaded file matches what the user sees in the canvas. */
  cropState: CropState;
  onOpenCropModal: () => void;
  /** Strict export profile applied on top of the user's format /
   *  size / quality choices. */
  exportProfileId: ExportProfileId;
  optimizeForSocial: boolean;
  onExportProfileChange: (id: ExportProfileId) => void;
  onOptimizeForSocialChange: (value: boolean) => void;
  /** Export history shown in the dropdown next to the export button. */
  exportHistory: ExportHistoryRecord[];
  exportHistoryReady: boolean;
  exportHistorySupported: boolean;
  onRemoveExport: (id: string) => void;
  onClearExports: () => void;
  exportHistoryOpen?: boolean;
  onExportHistoryOpenChange?: (open: boolean) => void;
  /**
   * Called after a successful download. The page uses this to
   * push the export history record (with the encoded blob as
   * the thumbnail source) and to show the receipt toast. We
   * pass the blob + the resolved metadata so the page can
   * build the record without re-deriving anything.
   */
  onExportSuccess: (info: {
    blob: Blob;
    fileName: string;
    profile: ExportProfile;
    actualWidth: number;
    actualHeight: number;
    format: 'jpeg' | 'png' | 'webp';
    quality: number;
    watermark: boolean;
  }) => void;
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

// A box is "the full image" when it covers the whole normalized
// space within 1px tolerance. We use this to skip the crop
// pipeline entirely when the user hasn't cropped at all.
function isFullImageCrop(box: { x: number; y: number; w: number; h: number }): boolean {
  return (
    box.x <= 0.001 &&
    box.y <= 0.001 &&
    box.w >= 0.999 &&
    box.h >= 0.999
  );
}

// Read a RenderCanvas's pixels back to an ImageData. We need this
// because the crop helper works on ImageData (the only common
// denominator across OffscreenCanvas / 2D canvas) but our export
// pipeline builds the oriented base as a 2D canvas.
function canvasToImageData(canvas: RenderCanvas): ImageData {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not read pixels from export canvas');
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Wrap an ImageData into a fresh RenderCanvas for downstream
// resampling. Offscreen when available, plain canvas otherwise.
function imageDataToCanvas(imageData: ImageData): RenderCanvas {
  const out = createCanvas(imageData.width, imageData.height);
  const ctx = out.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas for cropped image');
  }
  ctx.putImageData(imageData, 0, 0);
  return out;
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

// Remove only the GPS block from an already-encoded JPEG blob. piexifjs is
// JPEG-only, so callers gate this on `image/jpeg`. Any failure returns the
// original blob unchanged (the metadata helper swallows parse errors).
async function stripGpsFromJpegBlob(blob: Blob): Promise<Blob> {
  try {
    const dataUrl = await blobToDataUrl(blob);
    const stripped = stripGpsFromJpegDataUrl(dataUrl);
    if (stripped === dataUrl) return blob;
    return await (await fetch(stripped)).blob();
  } catch {
    return blob;
  }
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
  // `fileName` is kept on the props for callers that want to
  // thread it into future receipt strings; the receipt is
  // built from the resolved profile dimensions today.
  fileName: _fileName,
  sourceMimeType,
  currentExifBytes,
  textLayers,
  metadataPrivacy = 'keep',
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
  cropState,
  onOpenCropModal,
  exportProfileId,
  optimizeForSocial,
  onExportProfileChange,
  onOptimizeForSocialChange,
  exportHistory,
  onRemoveExport,
  onClearExports,
  exportHistoryOpen,
  onExportHistoryOpenChange,
  onExportSuccess,
}) => {
  const [size, setSize] = useState<ExportSize>('original');
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The most recent export's actual output dimensions. The
  // download handler reads these to build the receipt and the
  // history record. They're set inside `renderExportBlob` and
  // read by `handleDownload` immediately after.
  const lastExportWidthRef = React.useRef<number | null>(null);
  const lastExportHeightRef = React.useRef<number | null>(null);
  // Preview dimensions for the ExportProfileMenu. The full
  // raster is lazy (allocated on first export); the preview
  // raster is always available once an image is loaded. We
  // surface the *source* dimensions here, which is what the
  // user sees in the canvas anyway. Computing the full-res
  // dimensions on every render would trigger a setState on
  // the parent (the lazy raster materializer) inside a render
  // phase, which React forbids.
  const previewDims = useMemo(() => {
    if (!fullImageData) return null;
    return { width: fullImageData.width, height: fullImageData.height };
  }, [fullImageData]);

  // The export pipeline. The order of operations is:
  //   1. Render the full-resolution ImageData through the filter
  //      engine (float32 precision, all passes).
  //   2. Apply the crop box (if any) — the user sees this in the
  //      CropModal, and the export must match.
  //   3. Apply the export profile — the strict spec (longest
  //      edge, sRGB, sharpen). The profile is the *contract*.
  //   4. Apply the user's chosen size scale and watermark.
  //   5. Encode and re-inject EXIF.
  //
  // The receipt is generated last and reflects the *actual*
  // output dimensions (which can differ from the source if the
  // profile capped the longest edge).
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
            precision: 'float32',
          },
          analysis ?? undefined,
        );

        const filtered = await renderFilterOnWorker(fullRaster, settings);

        // Apply EXIF orientation. The re-injection below still
        // tags the file with the original orientation; downstream
        // readers that *don't* honour EXIF will see the
        // correctly-oriented pixels.
        const orientation = getExifOrientation(currentExifBytes);
        const oriented = drawImageDataToCanvas(filtered, orientation);

        // Step 1b: flatten text layers onto the full-resolution oriented
        // canvas, BEFORE crop — so a crop trims the text exactly as it
        // does the image (matching the editor's WYSIWYG overlay). Text
        // geometry is normalized to image space, so it lands correctly at
        // any output resolution.
        if (textLayers && textLayers.length > 0) {
          const textCtx = oriented.getContext('2d') as CanvasRenderingContext2D | null;
          if (textCtx) {
            await drawTextLayers(textCtx, oriented.width, oriented.height, textLayers);
          }
        }

        // Step 2: crop. The crop box is in normalized image
        // coordinates; we project to the oriented canvas's pixel
        // space. If the box is the default full image we skip the
        // crop pipeline (no-op).
        const cropped: RenderCanvas = isFullImageCrop(cropState.box)
          ? oriented
          : (() => {
              const { imageData } = cropImageDataOffscreen(canvasToImageData(oriented), cropState.box);
              return imageDataToCanvas(imageData);
            })();

        // Step 3: export profile. The profile's maxLongestEdge
        // caps the longer side; the shorter side follows the
        // source aspect. The sharpening pass runs *after* the
        // resize (so the radius is in the output space, not the
        // source space).
        const profile = getExportProfile(exportProfileId);
        const targetDims = resolveTargetDimensions(cropped.width, cropped.height, profile);
        const profileCanvas = resampleForProfile(cropped, targetDims.width, targetDims.height);
        if (profile.sharpen > 0) {
          applyUnsharpMask(profileCanvas, profile.sharpen);
        }

        // Step 4: user's size scale + watermark.
        const exportCanvas = resampleCanvas(profileCanvas, targetSize);
        if (withWatermark && profile.watermarkEligible) {
          applyWatermark(exportCanvas);
        }

        // Stash the actual output dimensions for the receipt and
        // the history record. The download handler reads these
        // *after* the await resolves.
        lastExportWidthRef.current = exportCanvas.width;
        lastExportHeightRef.current = exportCanvas.height;

        // Step 5: encode + EXIF re-injection.
        const resolvedMime = resolveExportMime(targetFormat, sourceMimeType);
        const rawBlob = await canvasToBlob(exportCanvas, targetFormat, targetQuality, sourceMimeType);
        // Metadata privacy. "strip-all" drops every tag: the canvas encode
        // already stripped EXIF, so we just skip re-injection. Otherwise
        // re-inject the source EXIF, then optionally remove GPS only.
        if (metadataPrivacy === 'strip-all') {
          return rawBlob;
        }
        if (resolvedMime === 'image/jpeg' || resolvedMime === 'image/png' || resolvedMime === 'image/webp') {
          const injected = await withExifInjected(rawBlob, currentExifBytes);
          if (metadataPrivacy === 'strip-gps' && resolvedMime === 'image/jpeg') {
            return await stripGpsFromJpegBlob(injected);
          }
          return injected;
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
      cropState.box,
      effectIntensity,
      exportProfileId,
      filterName,
      filterStrength,
      fullImageData,
      getFullImageData,
      sourceMimeType,
      textLayers,
      metadataPrivacy,
      lastExportHeightRef,
      lastExportWidthRef,
    ],
  );

  const handleDownload = useCallback(async () => {
    try {
      const blob = await renderExportBlob(format, size, 95, false);
      if (!blob) return;

      const profile = getExportProfile(exportProfileId);
      const exportName = createExportName(filterName, format, sourceMimeType);

      const link = document.createElement('a');
      link.download = exportName;
      link.href = URL.createObjectURL(blob);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      // The receipt toast is fired by the page (so the user sees it
      // alongside the history write); we just notify the page that
      // an export succeeded with everything it needs.
      onExportSuccess({
        blob,
        fileName: exportName,
        profile,
        actualWidth: lastExportWidthRef.current ?? 0,
        actualHeight: lastExportHeightRef.current ?? 0,
        format: profile.format,
        quality: profile.id === 'custom' ? 95 : profile.quality,
        watermark: false,
      });
    } catch (error) {
      console.error('Export failed', error);
    }
  }, [
    exportProfileId,
    filterName,
    format,
    renderExportBlob,
    size,
    sourceMimeType,
    onExportSuccess,
  ]);

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
        </div>

        <button
          onClick={onOpenCropModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background text-foreground hover:border-primary/40 hover:text-primary transition-colors font-mono-ui text-[11px]"
          title="Crop (K)"
        >
          <Crop className="w-3 h-3" />
          <SlotLabel
            text={isFullImageCrop(cropState.box) ? 'Crop' : formatRatioLabel(detectActiveRatio(cropState.box))}
            flashColor={false}
            tone="inherit"
          />
        </button>

        <ExportProfileMenu
          activeProfileId={exportProfileId}
          optimizeForSocial={optimizeForSocial}
          onProfileChange={onExportProfileChange}
          onOptimizeForSocialChange={onOptimizeForSocialChange}
          preview={previewDims}
        />

        <RecentExportsMenu
          history={exportHistory}
          onApply={(record) => {
            // Re-applying an export means restoring the exact
            // settings the user had at the time. Profile + the
            // social-toggle snap are the composable knobs.
            onExportProfileChange(record.profileId);
            onOptimizeForSocialChange(record.optimizeForSocial);
          }}
          onRemove={onRemoveExport}
          onClear={onClearExports}
          open={exportHistoryOpen}
          onOpenChange={onExportHistoryOpenChange}
        />

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
