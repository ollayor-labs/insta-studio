import React from "react";
import { getGuidePlatform } from "@/lib/guides";

export interface SafeAreaOverlayProps {
  platformId: string | null;
  className?: string;
}

/**
 * Preview-only overlay that draws a platform's UI-chrome "safe area" zones on
 * top of the displayed image. Must be mounted inside a `position:relative`
 * parent that matches the image display box; it fills that parent exactly.
 *
 * Uses a plain SVG with a 0..100 viewBox and `preserveAspectRatio="none"` so
 * normalized region fractions map directly to fraction * 100 coordinates,
 * stretching to whatever aspect ratio the display box happens to be.
 *
 * This is never included in an export — it lives purely in the UI layer.
 */
const SafeAreaOverlay: React.FC<SafeAreaOverlayProps> = ({ platformId, className }) => {
  const platform = getGuidePlatform(platformId);
  if (!platform) return null;

  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      {platform.regions.map((region, index) => {
        const x = region.x * 100;
        const y = region.y * 100;
        const w = region.w * 100;
        const h = region.h * 100;
        return (
          <g key={`${region.label}-${index}`}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="hsl(0 70% 50% / 0.18)"
              stroke="hsl(0 70% 60% / 0.5)"
              strokeWidth={0.4}
              strokeDasharray="1.5 1"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={x + w / 2}
              y={y + h / 2}
              fill="hsl(0 80% 88% / 0.9)"
              fontSize={2.4}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.02em" }}
            >
              {region.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export default SafeAreaOverlay;
