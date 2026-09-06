import React, { useEffect, useMemo, useState } from "react";
import { Scissors, Sparkles, Check, ImageOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useBackgroundRemoval } from "@/hooks/useBackgroundRemoval";
import {
  compositeCutout,
  type CutoutBackground,
} from "@/lib/cutout";
import { formatFileSize } from "@/lib/fileSize";

export interface CutoutToolProps {
  sourceImage: HTMLImageElement | null;
  onApply: (result: {
    canvas: HTMLCanvasElement;
    mask: Uint8Array;
    maskW: number;
    maskH: number;
  }) => void;
}

interface MaskState {
  mask: Uint8Array;
  width: number;
  height: number;
}

const PRESET_COLORS: { label: string; color: string }[] = [
  { label: "White", color: "#FFFFFF" },
  { label: "Black", color: "#000000" },
  { label: "Gold", color: "#D4A574" },
];

/**
 * Cutout tab — on-device AI background removal. Downloads a ~44MB model on
 * first use, then runs entirely in the browser (WebGPU when available, WASM
 * otherwise).
 */
const CutoutTool: React.FC<CutoutToolProps> = ({ sourceImage, onApply }) => {
  const {
    removeBackground,
    warmup,
    progress,
    phase,
    device,
    loaded,
    total,
    status,
    error,
  } = useBackgroundRemoval();
  const [maskState, setMaskState] = useState<MaskState | null>(null);
  const [background, setBackground] = useState<CutoutBackground>({
    kind: "transparent",
  });
  const [customColor, setCustomColor] = useState("#D4A574");

  // Pre-fetch the model as soon as the user opens the Cutout tab — this
  // hides the silent worker-script + WASM fetches behind their exploration
  // of the panel, so the first "Remove background" click responds faster.
  useEffect(() => {
    warmup();
  }, [warmup]);

  const isBusy = status === "loading" || status === "running";
  const isPreparing = status === "loading" && phase === "init";
  const isDownloading = status === "loading" && phase === "download";
  const isInferring = (status === "running") || (status === "loading" && phase === "inference");

  // WASM runs single-threaded without cross-origin isolation — call it out
  // so the user knows inference may take a while.
  const isCpuMode = device === "wasm";

  const disabled = !sourceImage;

  const handleRemove = async () => {
    if (!sourceImage) return;
    try {
      const result = await removeBackground(sourceImage);
      setMaskState({
        mask: result.mask,
        width: result.width,
        height: result.height,
      });
    } catch {
      // Error surfaced via hook `error`/`status`.
    }
  };

  const handleApply = () => {
    if (!sourceImage || !maskState) return;
    const canvas = compositeCutout(
      sourceImage,
      maskState.mask,
      maskState.width,
      maskState.height,
      background,
    );
    onApply({
      canvas,
      mask: maskState.mask,
      maskW: maskState.width,
      maskH: maskState.height,
    });
  };

  const isBgActive = (bg: CutoutBackground): boolean => {
    if (bg.kind !== background.kind) return false;
    if (bg.kind === "color" && background.kind === "color") {
      return bg.color.toLowerCase() === background.color.toLowerCase();
    }
    return true;
  };

  const swatchButtons = useMemo(
    () =>
      PRESET_COLORS.map(({ label, color }) => {
        const active = isBgActive({ kind: "color", color });
        return (
          <button
            key={color}
            type="button"
            title={label}
            onClick={() => setBackground({ kind: "color", color })}
            className={`h-9 w-9 rounded-md border transition-colors ${
              active ? "border-primary ring-2 ring-primary/40" : "border-border"
            }`}
            style={{ backgroundColor: color }}
          />
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [background],
  );

  if (disabled) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
        <ImageOff className="h-6 w-6 text-muted-foreground" />
        <p className="font-mono-ui text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Load an image to remove its background
        </p>
      </div>
    );
  }

  // Build the active status caption. Order matters: inference > download >
  // preparing, because the worker posts an explicit "inference" phase that
  // arrives after the download finishes.
  const statusLabel = isInferring
    ? "Processing…"
    : isDownloading
      ? "Downloading model…"
      : isPreparing
        ? "Preparing AI engine…"
        : null;

  // Byte readout for the download phase, when the worker reports bytes.
  const byteReadout =
    isDownloading && loaded != null && total != null && total > 0
      ? `${formatFileSize(loaded)} / ${formatFileSize(total)}`
      : isDownloading
        ? `${Math.round(progress)}%`
        : null;

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Scissors className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg text-foreground">Cutout</h2>
      </div>
      <p className="-mt-2 px-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-primary">
        Downloads a ~44MB AI model on first use (then cached)
      </p>

      <Button
        type="button"
        className="w-full"
        onClick={handleRemove}
        disabled={isBusy}
      >
        <Sparkles className="h-4 w-4" />
        {isBusy
          ? isDownloading
            ? "Downloading model…"
            : isInferring
              ? "Processing…"
              : "Preparing…"
          : maskState
            ? "Re-run removal"
            : "Remove background"}
      </Button>

      {/* Preparing phase: worker + WASM fetch are silent (no byte progress),
          so show an indeterminate spinner instead of a stuck 0% bar. */}
      {isPreparing && (
        <div className="flex items-center gap-2 px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {statusLabel}
          </p>
        </div>
      )}

      {/* Download phase: the only phase with real byte-level progress. */}
      {isDownloading && (
        <div className="space-y-1 px-1">
          <Progress value={progress} className="h-2" />
          <div className="flex items-center justify-between">
            <p className="font-mono-ui text-[10px] tracking-[0.12em] text-muted-foreground">
              {byteReadout}
            </p>
            <p className="font-mono-ui text-[10px] tracking-[0.12em] text-muted-foreground">
              {Math.round(progress)}%
            </p>
          </div>
        </div>
      )}

      {/* Inference phase: no byte progress available — show an indeterminate
          spinner with the device hint so the user knows it's still working. */}
      {isInferring && (
        <div className="space-y-1 px-1">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {statusLabel}
            </p>
          </div>
          {isCpuMode && (
            <p className="font-mono-ui text-[10px] tracking-[0.12em] text-muted-foreground/80">
              Running on CPU — this may take a bit
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono-ui text-[11px] text-destructive">
          {error}
        </p>
      )}

      {maskState && (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="px-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Background
          </p>

          <button
            type="button"
            onClick={() => setBackground({ kind: "transparent" })}
            className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
              isBgActive({ kind: "transparent" })
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card/50 text-secondary-foreground hover:text-foreground"
            }`}
          >
            <span className="font-mono-ui text-[12px] uppercase tracking-[0.12em]">
              Transparent
            </span>
            {isBgActive({ kind: "transparent" }) && <Check className="h-3.5 w-3.5" />}
          </button>

          <div className="flex items-center gap-2 px-1">
            {swatchButtons}
            <label
              className={`relative h-9 w-9 cursor-pointer overflow-hidden rounded-md border ${
                background.kind === "color" &&
                !PRESET_COLORS.some(
                  (p) => p.color.toLowerCase() === customColor.toLowerCase(),
                ) &&
                isBgActive({ kind: "color", color: customColor })
                  ? "border-primary ring-2 ring-primary/40"
                  : "border-border"
              }`}
              style={{ backgroundColor: customColor }}
              title="Custom color"
            >
              <input
                type="color"
                value={customColor}
                onChange={(e) => {
                  setCustomColor(e.target.value);
                  setBackground({ kind: "color", color: e.target.value });
                }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
          </div>

          <Button type="button" className="w-full" onClick={handleApply}>
            <Check className="h-4 w-4" />
            Apply cutout
          </Button>
        </div>
      )}
    </div>
  );
};

export default CutoutTool;
