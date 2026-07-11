import React from "react";
import type { CropBox } from "@/lib/crop";

interface CropFrameOverlayProps {
  box: CropBox;
  /** When true, always show (Crop tool active). Otherwise the overlay
   *  only appears when the box is an actual crop (not the full image). */
  active: boolean;
}

function isFullImage(box: CropBox): boolean {
  return box.x <= 0.001 && box.y <= 0.001 && box.w >= 0.999 && box.h >= 0.999;
}

/**
 * Non-interactive crop preview drawn over the displayed image box. Dims the
 * area outside the crop and draws a rule-of-thirds frame so the user sees
 * exactly what will be exported. Drag-editing still lives in CropModal.
 */
const CropFrameOverlay: React.FC<CropFrameOverlayProps> = ({ box, active }) => {
  if (!active && isFullImage(box)) return null;

  const insetY = box.y * 100;
  const insetX = box.x * 100;
  const rightInset = 100 - (box.x + box.w) * 100;
  const bottomInset = 100 - (box.y + box.h) * 100;

  const frameStyle: React.CSSProperties = {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-[16]" aria-hidden>
      {/* Solid black overlay outside the crop box via a massive box-shadow. */}
      <div
        className="absolute border border-primary/90 shadow-[0_0_0_9999px_#000]"
        style={frameStyle}
      >
        {/* Rule-of-thirds guides. */}
        <div className="absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute top-1/3 left-0 h-px w-full bg-white/30" />
          <div className="absolute top-2/3 left-0 h-px w-full bg-white/30" />
        </div>
      </div>
    </div>
  );
};

export default CropFrameOverlay;
