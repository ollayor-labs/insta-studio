import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crop, Check, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  CROP_RATIOS,
  type CropBox,
  type CropRatio,
  type CropState,
  clampBox,
  DEFAULT_CROP_BOX,
  detectActiveRatio,
  formatRatioLabel,
  resizeBoxToRatio,
} from "@/lib/crop";
import { showCropAppliedToast, showCropResetToast } from "@/lib/editorToasts";

interface CropModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceImage: HTMLImageElement | null;
  /**
   * The current crop state from the parent. The modal is a
   * controlled component — it doesn't own the canonical state.
   * The buttons highlight by *deriving* the active ratio from
   * `state.box`, so the canvas/box is the source of truth and
   * the buttons just mirror it.
   */
  state: CropState;
  onApply: (next: CropState) => void;
  /**
   * When true, the modal centers the crop box on the dominant
   * subject (a simple luminance-weighted center). Used by the
   * Auto-Center toggle from the critique.
   */
  autoCenter: boolean;
  onAutoCenterChange: (value: boolean) => void;
}

const MIN_BOX_RATIO = 0.05; // 5% of the image is the smallest allowed box dimension

// Pointer drag state. We resolve to an actual `CropBox` in normalized
// 0..1 image coordinates and commit it on pointerup.
interface DragState {
  mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se" | "resize-n" | "resize-s" | "resize-w" | "resize-e" | "create";
  startPointerX: number;
  startPointerY: number;
  startBox: CropBox;
  imageRect: DOMRect;
  ratio: number | null; // null = freeform
}

const CropModal: React.FC<CropModalProps> = ({
  open,
  onOpenChange,
  sourceImage,
  state,
  onApply,
  autoCenter,
  onAutoCenterChange,
}) => {
  // The modal keeps a *working* copy of the box. The parent owns
  // the canonical state — the working copy is what the user
  // drags around. The apply button commits the working copy back
  // to the parent; the cancel button (or the X / Escape) throws
  // it away. The active ratio buttons *also* read from the
  // working copy so they update live as the user drags.
  const [workingBox, setWorkingBox] = useState<CropBox>(state.box);
  const [workingRatio, setWorkingRatio] = useState<CropRatio>(state.ratio);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // When the modal opens, sync the working copy to the parent's
  // state. The parent state is the "last applied" box; if the
  // user reopens the modal after the source image changed, we
  // reset to the full image (the parent decides that via the
  // initial state on image-load).
  useEffect(() => {
    if (open) {
      setWorkingBox(state.box);
      setWorkingRatio(state.ratio);
    }
  }, [open, state.box, state.ratio]);

  // Derive the active ratio from the working box. The buttons
  // read this to highlight themselves. The canvas/box is the
  // source of truth; the buttons only mirror it.
  const activeRatio = useMemo(() => detectActiveRatio(workingBox), [workingBox]);
  const ratioLocked = workingRatio !== "free" && workingRatio === activeRatio;

  // The stage is sized to fit the image at a max display size.
  // The box itself is in 0..1 image coords and styled as a
  // percentage, so we don't need to project to pixels here.
  const boxStyle = useMemo(() => {
    return {
      left: `${workingBox.x * 100}%`,
      top: `${workingBox.y * 100}%`,
      width: `${workingBox.w * 100}%`,
      height: `${workingBox.h * 100}%`,
    };
  }, [workingBox]);

  // Image source for the preview. We render the actual image so
  // the crop box overlays the real pixels — the user can see
  // exactly what they're cutting.
  const imageUrl = useMemo(() => {
    if (!sourceImage) return null;
    return sourceImage.src;
  }, [sourceImage]);

  // Start a drag from a handle (corner/edge) or from inside the
  // box (move). The drag state is kept in a ref so the move
  // handler doesn't have to re-create callbacks on every frame.
  const startDrag = useCallback(
    (
      event: React.PointerEvent<HTMLDivElement>,
      mode: DragState["mode"],
      imageRect: DOMRect,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        mode,
        startPointerX: event.clientX,
        startPointerY: event.clientY,
        startBox: { ...workingBox },
        imageRect,
        ratio: ratioLocked ? CROP_RATIOS.find((entry) => entry.id === workingRatio)?.ratio ?? null : null,
      };
      setIsDragging(true);
    },
    [workingBox, ratioLocked, workingRatio],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      const mode: DragState["mode"] = (event.currentTarget.dataset.handle as DragState["mode"]) ?? "move";
      startDrag(event, mode, rect);
    },
    [startDrag],
  );

  // Pointermove updates the working box from the drag state. We
  // honor the locked ratio (if any) by computing the resize from
  // the dominant axis. The math is intentionally conservative —
  // we clamp aggressively so a fast drag never pushes the box
  // outside the image.
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const imageW = drag.imageRect.width;
      const imageH = drag.imageRect.height;
      if (imageW <= 0 || imageH <= 0) return;

      const dxNorm = (event.clientX - drag.startPointerX) / imageW;
      const dyNorm = (event.clientY - drag.startPointerY) / imageH;
      const start = drag.startBox;
      let nextBox: CropBox = start;

      if (drag.mode === "move") {
        nextBox = { x: start.x + dxNorm, y: start.y + dyNorm, w: start.w, h: start.h };
      } else {
        // Resize. The mode tells us which edges are pinned.
        let x = start.x;
        let y = start.y;
        let w = start.w;
        let h = start.h;
        if (drag.mode === "resize-se") {
          w = start.w + dxNorm;
          h = start.h + dyNorm;
        } else if (drag.mode === "resize-sw") {
          x = start.x + dxNorm;
          w = start.w - dxNorm;
          h = start.h + dyNorm;
        } else if (drag.mode === "resize-ne") {
          w = start.w + dxNorm;
          y = start.y + dyNorm;
          h = start.h - dyNorm;
        } else if (drag.mode === "resize-nw") {
          x = start.x + dxNorm;
          y = start.y + dyNorm;
          w = start.w - dxNorm;
          h = start.h - dyNorm;
        } else if (drag.mode === "resize-n") {
          y = start.y + dyNorm;
          h = start.h - dyNorm;
        } else if (drag.mode === "resize-s") {
          h = start.h + dyNorm;
        } else if (drag.mode === "resize-w") {
          x = start.x + dxNorm;
          w = start.w - dxNorm;
        } else if (drag.mode === "resize-e") {
          w = start.w + dxNorm;
        }

        // Enforce the locked aspect ratio by adjusting the
        // non-dominant axis to match. We pick the axis that
        // changed more (relative to the start box) as the
        // dominant one — this matches what Figma / Photoshop
        // do and feels natural for a drag.
        if (drag.ratio !== null) {
          const dW = Math.abs(w - start.w);
          const dH = Math.abs(h - start.h);
          if (dW / Math.max(start.w, 0.0001) >= dH / Math.max(start.h, 0.0001)) {
            h = w / drag.ratio;
            // If we're resizing from the top edge (n/nw/ne),
            // the box's top needs to follow so the height
            // change is absorbed there, not at the bottom.
            if (drag.mode === "resize-nw" || drag.mode === "resize-ne" || drag.mode === "resize-n") {
              y = start.y + (start.h - h);
            }
          } else {
            w = h * drag.ratio;
            if (drag.mode === "resize-nw" || drag.mode === "resize-sw" || drag.mode === "resize-w") {
              x = start.x + (start.w - w);
            }
          }
        }

        // Enforce the minimum size: at least MIN_BOX_RATIO of
        // the image on both axes. If the user drags past the
        // minimum, we clamp and keep the opposite edge pinned.
        if (w < MIN_BOX_RATIO) {
          w = MIN_BOX_RATIO;
          if (drag.mode === "resize-nw" || drag.mode === "resize-sw" || drag.mode === "resize-w") {
            x = start.x + (start.w - MIN_BOX_RATIO);
          }
          if (drag.ratio !== null) h = w / drag.ratio;
        }
        if (h < MIN_BOX_RATIO) {
          h = MIN_BOX_RATIO;
          if (drag.mode === "resize-nw" || drag.mode === "resize-ne" || drag.mode === "resize-n") {
            y = start.y + (start.h - MIN_BOX_RATIO);
          }
          if (drag.ratio !== null) w = h * drag.ratio;
        }

        nextBox = { x, y, w, h };
      }
      setWorkingBox(clampBox(nextBox));
    },
    [],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = null;
    setIsDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer was already released (e.g. lost capture from
      // a focus change). Swallow.
    }
  }, []);

  // Click a preset ratio button. The buttons are *dumb* — they
  // just snap the box to the new ratio. The active highlight is
  // derived from the box, not the click; clicking 4:5 when the
  // box is already 4:5 is still a no-op snap (a slight resize
  // maybe), which is fine.
  const handleRatioClick = useCallback(
    (ratioId: CropRatio) => {
      const spec = CROP_RATIOS.find((entry) => entry.id === ratioId);
      if (!spec) return;
      setWorkingRatio(ratioId);
      if (spec.ratio === null) {
        // Free: do nothing to the box, just clear the lock.
        return;
      }
      // Snap the box to the new ratio, anchored at its center.
      // We use the *current* active ratio as the locked ratio
      // for the snap math if there is one; otherwise the box
      // gets a fresh snap from the center.
      setWorkingBox((box) => resizeBoxToRatio(box, spec.ratio, 0.5, 0.5));
    },
    [],
  );

  // Reset to the full image (freeform).
  const handleReset = useCallback(() => {
    setWorkingBox(DEFAULT_CROP_BOX);
    setWorkingRatio("free");
    showCropResetToast();
  }, []);

  // Commit the working state to the parent and close. The
  // apply button is the single source of mutation, so cancel
  // (close without apply) cleanly discards the working copy.
  const handleApply = useCallback(() => {
    // The locked ratio follows the box — if the user dragged
    // the box off-ratio, we keep the ratio in "free" so the
    // next open doesn't snap them back. If the box is on a
    // preset, we keep the preset lock.
    const finalRatio: CropRatio = activeRatio === "free" ? workingRatio : activeRatio;
    onApply({ box: workingBox, ratio: finalRatio });
    showCropAppliedToast(formatRatioLabel(finalRatio));
    onOpenChange(false);
  }, [workingBox, workingRatio, activeRatio, onApply, onOpenChange]);

  // Display preview: show the image at max 600x500 with a
  // darkened overlay outside the crop box. The overlay is
  // a single absolutely-positioned div with a CSS mask —
  // the box itself is the "hole" in the mask.
  const overlayMask = useMemo(() => {
    const insetX = workingBox.x * 100;
    const insetY = workingBox.y * 100;
    const rightInset = 100 - (workingBox.x + workingBox.w) * 100;
    const bottomInset = 100 - (workingBox.y + workingBox.h) * 100;
    return {
      clipPath: `inset(${insetY}% ${rightInset}% ${bottomInset}% ${insetX}%)`,
    };
  }, [workingBox]);

  if (!sourceImage) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[calc(100vw-32px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crop className="h-4 w-4 text-primary" />
            Crop
            <Badge variant="outline" className="ml-2 font-mono-ui text-[10px] tracking-[0.14em]">
              {formatRatioLabel(activeRatio)}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Drag the box to set the crop. The buttons below mirror the box — pick a preset or drag freely.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Preview stage with crop overlay */}
          <div
            ref={stageRef}
            className="relative mx-auto overflow-hidden rounded-lg border border-border bg-[hsl(var(--filtr-surface))]"
            style={{
              aspectRatio: `${sourceImage.naturalWidth} / ${sourceImage.naturalHeight}`,
              maxWidth: "100%",
              maxHeight: "min(60vh, 520px)",
              width: "auto",
              touchAction: "none",
            }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                draggable={false}
                className="absolute inset-0 h-full w-full select-none object-contain"
                style={{ userSelect: "none", pointerEvents: "none" }}
              />
            ) : null}

            {/* Dimmed overlay: covers the whole image, the box
                "cuts out" via clip-path. Implemented as a single
                layer with a mask so we don't have to position
                four strips. */}
            <div
              className="absolute inset-0 bg-black/55 transition-[clip-path] duration-100"
              style={overlayMask}
              aria-hidden
            />

            {/* The crop box. The whole box is the "move" target;
                the eight handle dots around the edges are the
                resize targets. */}
            <div
              data-handle="move"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className={`absolute cursor-move touch-none border-2 border-primary shadow-[0_0_0_1px_rgba(0,0,0,0.6)] ${
                isDragging ? "" : "transition-[left,top,width,height] duration-100"
              }`}
              style={boxStyle}
            >
              {/* Rule of thirds grid */}
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute left-1/3 top-0 h-full w-px bg-white/40" />
                <div className="absolute left-2/3 top-0 h-full w-px bg-white/40" />
                <div className="absolute top-1/3 left-0 w-full h-px bg-white/40" />
                <div className="absolute top-2/3 left-0 w-full h-px bg-white/40" />
              </div>

              {/* Resize handles — 8 of them, one per corner and
                  edge. The data-handle attribute tells the
                  pointer-down handler which edge to resize. */}
              {(
                [
                  ["resize-nw", "top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"],
                  ["resize-n", "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize"],
                  ["resize-ne", "top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"],
                  ["resize-w", "top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize"],
                  ["resize-e", "top-1/2 right-0 translate-x-1/2 -translate-y-1/2 cursor-ew-resize"],
                  ["resize-sw", "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"],
                  ["resize-s", "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize"],
                  ["resize-se", "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"],
                ] as const
              ).map(([handle, classes]) => (
                <div
                  key={handle}
                  data-handle={handle}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`absolute h-3 w-3 rounded-full border-2 border-primary bg-background shadow-sm ${classes}`}
                />
              ))}

              {/* Dimensions readout */}
              <div className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background/95 px-2 py-0.5 font-mono-ui text-[10px] tracking-[0.12em] text-foreground shadow-md backdrop-blur">
                {Math.round(workingBox.w * sourceImage.naturalWidth)} × {Math.round(workingBox.h * sourceImage.naturalHeight)} px
              </div>
            </div>
          </div>

          {/* Ratio buttons + auto-center toggle */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {CROP_RATIOS.map((spec) => {
                const active = activeRatio === spec.id;
                return (
                  <TooltipProvider key={spec.id} delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleRatioClick(spec.id)}
                          className={`flex h-9 items-center gap-1 rounded-md border px-2.5 font-mono-ui text-[11px] uppercase tracking-[0.12em] transition-colors ${
                            active
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
                          }`}
                          aria-pressed={active}
                        >
                          {active ? <Check className="h-3 w-3" /> : null}
                          {spec.label}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{spec.description}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })}
            </div>

            <div className="flex items-center gap-3 border-l border-border pl-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="crop-auto-center"
                  checked={autoCenter}
                  onCheckedChange={onAutoCenterChange}
                />
                <Label
                  htmlFor="crop-auto-center"
                  className="cursor-pointer font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                >
                  Auto-Center
                </Label>
              </div>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleReset}
                      className="h-9 gap-1.5 font-mono-ui text-[10px] uppercase tracking-[0.14em]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Reset to full image</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Apply Crop
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CropModal;
