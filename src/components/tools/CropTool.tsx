import React from "react";
import { Crop, Maximize2, RotateCcw } from "lucide-react";
import {
  CROP_RATIOS,
  DEFAULT_CROP_BOX,
  DEFAULT_CROP_STATE,
  boxToPixelRect,
  detectActiveRatio,
  formatRatioLabel,
  resizeBoxToRatio,
  type CropRatioSpec,
  type CropState,
} from "@/lib/crop";
import { Button } from "@/components/ui/button";

export interface CropToolProps {
  cropState: CropState;
  onCropChange: (next: CropState) => void;
  sourceImage: HTMLImageElement | null;
  onOpenEditor: () => void;
}

const CropTool: React.FC<CropToolProps> = ({
  cropState,
  onCropChange,
  sourceImage,
  onOpenEditor,
}) => {
  const activeRatio = detectActiveRatio(cropState.box);

  const handleRatio = (spec: CropRatioSpec) => {
    if (spec.ratio === null) {
      onCropChange({ box: cropState.box, ratio: "free" });
      return;
    }
    const nextBox = resizeBoxToRatio(DEFAULT_CROP_BOX, spec.ratio, 0.5, 0.5);
    onCropChange({ box: nextBox, ratio: spec.id });
  };

  const pixelRect = sourceImage
    ? boxToPixelRect(cropState.box, sourceImage.naturalWidth, sourceImage.naturalHeight)
    : null;

  if (!sourceImage) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card/60">
          <Crop className="h-5 w-5 text-primary" />
        </div>
        <h3 className="font-display text-base text-foreground">Crop &amp; Resize</h3>
        <p className="mt-3 max-w-[15rem] text-[12px] leading-relaxed text-muted-foreground">
          Load an image to crop
        </p>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-1">
          <h2 className="font-display text-lg text-foreground">Crop &amp; Resize</h2>
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-primary">
            {formatRatioLabel(activeRatio)}
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono-ui text-[9px] uppercase tracking-[0.12em] text-primary">
          {activeRatio === "free" ? "Free" : activeRatio}
        </span>
      </div>

      <div className="space-y-2">
        <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
          Aspect Ratio
        </p>
        <div className="grid grid-cols-4 gap-2">
          {CROP_RATIOS.map((spec) => {
            const isActive =
              spec.ratio === null ? activeRatio === "free" : activeRatio === spec.id;
            return (
              <button
                key={spec.id}
                type="button"
                title={spec.description}
                onClick={() => handleRatio(spec)}
                className={`flex flex-col items-center justify-center rounded-xl border px-1.5 py-2 transition-colors ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card/50 text-muted-foreground hover:text-foreground hover:border-primary/40"
                }`}
              >
                <span className="font-mono-ui text-[11px] tabular-nums">{spec.label}</span>
                <span className="mt-0.5 text-[8px] leading-tight text-muted-foreground truncate max-w-full">
                  {spec.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-1">
        <span className="font-mono-ui text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Crop Size
        </span>
        <p className="font-mono-ui text-[13px] text-secondary-foreground tabular-nums">
          {pixelRect ? `${pixelRect.width} × ${pixelRect.height} px` : "—"}
        </p>
      </div>

      <div className="space-y-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onOpenEditor}
          className="w-full gap-1.5 font-mono-ui text-[11px]"
        >
          <Maximize2 className="h-3 w-3" />
          Fine-tune in editor
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onCropChange(DEFAULT_CROP_STATE)}
          className="w-full gap-1.5 font-mono-ui text-[11px] text-muted-foreground hover:text-primary"
        >
          <RotateCcw className="h-3 w-3" />
          Reset crop
        </Button>
      </div>
    </div>
  );
};

export default CropTool;
