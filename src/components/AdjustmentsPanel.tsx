import React from "react";
import { Adjustments } from "@/lib/filterEngine";
import { RotateCcw } from "lucide-react";

interface AdjustmentsPanelProps {
  adjustments: Adjustments;
  onChange: (key: keyof Adjustments, value: number) => void;
  onReset: () => void;
}

interface SliderConfig {
  key: keyof Adjustments;
  label: string;
  min: number;
  max: number;
  step?: number;
}

const SLIDERS: SliderConfig[] = [
  { key: "exposure", label: "Exposure", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "temperature", label: "Temperature", min: -100, max: 100 },
  { key: "tint", label: "Tint", min: -100, max: 100 },
  { key: "clarity", label: "Clarity", min: 0, max: 100 },
  { key: "grain", label: "Grain", min: 0, max: 100 },
  { key: "vignette", label: "Vignette", min: 0, max: 100 },
  { key: "fade", label: "Fade", min: 0, max: 100 },
];

const AdjustmentsPanel: React.FC<AdjustmentsPanelProps> = ({ adjustments, onChange, onReset }) => {
  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="font-display text-lg text-foreground">Adjust</h2>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors font-mono-ui text-[11px]"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      <div className="space-y-2.5">
        {SLIDERS.map(({ key, label, min, max, step = 1 }) => {
          const value = adjustments[key];
          const isCenter = min < 0;
          const pct = isCenter
            ? ((value - min) / (max - min)) * 100
            : (value / max) * 100;

          return (
            <div key={key} className="space-y-1 px-1">
              <div className="flex items-center justify-between">
                <span className="font-mono-ui text-[11px] text-muted-foreground">{label}</span>
                <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums w-8 text-right">
                  {value > 0 ? `+${value}` : value}
                </span>
              </div>
              <div className="relative">
                {isCenter && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-px h-2 bg-muted-foreground/30"
                    style={{ left: "50%" }}
                  />
                )}
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={value}
                  onChange={(e) => onChange(key, Number(e.target.value))}
                  className="filtr-slider"
                  style={{
                    background: isCenter
                      ? `linear-gradient(to right, hsl(var(--filtr-slider-track)) 0%, hsl(var(--filtr-slider-track)) ${Math.min(50, pct)}%, hsl(var(--filtr-amber)) ${Math.min(50, pct)}%, hsl(var(--filtr-amber)) ${Math.max(50, pct)}%, hsl(var(--filtr-slider-track)) ${Math.max(50, pct)}%, hsl(var(--filtr-slider-track)) 100%)`
                      : `linear-gradient(to right, hsl(var(--filtr-amber)) 0%, hsl(var(--filtr-amber)) ${pct}%, hsl(var(--filtr-slider-track)) ${pct}%, hsl(var(--filtr-slider-track)) 100%)`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AdjustmentsPanel;
