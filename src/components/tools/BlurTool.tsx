import React, { useEffect, useMemo, useRef, useState } from "react";
import { Aperture, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyBlur, type BlurOptions } from "@/lib/blur";

export interface BlurToolProps {
  sourceImage: HTMLImageElement | null;
  subjectMask: { data: Uint8Array; w: number; h: number } | null; // from Cutout, may be null
  onApply: (canvas: HTMLCanvasElement) => void;
}

type BlurType = "whole" | "tilt" | "radial" | "background";

const TYPE_OPTIONS: Array<{ value: BlurType; label: string }> = [
  { value: "whole", label: "Whole" },
  { value: "tilt", label: "Tilt-shift" },
  { value: "radial", label: "Radial" },
  { value: "background", label: "Background" },
];

const PREVIEW_MAX = 200;

/** Local slider styled to match AdjustmentsPanel's SliderField. */
function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1 px-1">
      <div className="flex items-center justify-between">
        <span className="font-mono-ui text-[11px] text-muted-foreground">{label}</span>
        <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums w-10 text-right">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="filtr-slider"
      />
    </div>
  );
}

const BlurTool: React.FC<BlurToolProps> = ({ sourceImage, subjectMask, onApply }) => {
  const [type, setType] = useState<BlurType>("whole");
  const [strength, setStrength] = useState(40);
  // Tilt-shift.
  const [center, setCenter] = useState(50); // 0..100 → y position
  const [halfWidth, setHalfWidth] = useState(15); // 0..100 → band half width
  const [feather, setFeather] = useState(15); // 0..100 → edge softness
  // Radial: single "focus size" that drives inner/outer.
  const [focusSize, setFocusSize] = useState(35); // 0..100

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const [applying, setApplying] = useState(false);

  // If Background gets selected but the mask disappears, fall back to Whole.
  useEffect(() => {
    if (type === "background" && !subjectMask) setType("whole");
  }, [type, subjectMask]);

  const buildOptions = useMemo(() => {
    return (): BlurOptions => {
      switch (type) {
        case "tilt":
          return {
            type: "tilt",
            strength,
            center: center / 100,
            halfWidth: halfWidth / 100,
            feather: feather / 100,
          };
        case "radial": {
          const inner = (focusSize / 100) * 0.5;
          return {
            type: "radial",
            strength,
            cx: 0.5,
            cy: 0.5,
            inner,
            outer: inner + 0.2,
          };
        }
        case "background":
          // subjectMask is guaranteed non-null here (type guarded below).
          return { type: "background", strength, subjectMask: subjectMask! };
        case "whole":
        default:
          return { type: "whole", strength };
      }
    };
  }, [type, strength, center, halfWidth, feather, focusSize, subjectMask]);

  // Debounced downscaled live preview.
  useEffect(() => {
    if (!sourceImage) return;
    if (type === "background" && !subjectMask) return;

    const handle = window.setTimeout(() => {
      const canvas = previewRef.current;
      if (!canvas) return;
      const nw = sourceImage.naturalWidth || sourceImage.width;
      const nh = sourceImage.naturalHeight || sourceImage.height;
      if (!nw || !nh) return;
      const scale = Math.min(1, PREVIEW_MAX / Math.max(nw, nh));
      const pw = Math.max(1, Math.round(nw * scale));
      const ph = Math.max(1, Math.round(nh * scale));

      let options = buildOptions();
      // Downscale the subject mask to preview size to keep things fast.
      if (options.type === "background") {
        options = { ...options, subjectMask: options.subjectMask };
      }

      try {
        const result = applyBlur(sourceImage, pw, ph, options);
        canvas.width = pw;
        canvas.height = ph;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(result, 0, 0);
      } catch {
        // Preview is best-effort; ignore transient failures.
      }
    }, 180);

    return () => window.clearTimeout(handle);
  }, [sourceImage, subjectMask, buildOptions, type]);

  const handleApply = () => {
    if (!sourceImage) return;
    setApplying(true);
    // Defer to next frame so the button state paints before the heavy work.
    window.requestAnimationFrame(() => {
      try {
        const nw = sourceImage.naturalWidth || sourceImage.width;
        const nh = sourceImage.naturalHeight || sourceImage.height;
        const canvas = applyBlur(sourceImage, nw, nh, buildOptions());
        onApply(canvas);
      } finally {
        setApplying(false);
      }
    });
  };

  if (!sourceImage) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card/60">
          <ImageOff className="h-5 w-5 text-primary" />
        </div>
        <h3 className="font-display text-base text-foreground">Blur</h3>
        <p className="mt-3 max-w-[15rem] text-[12px] leading-relaxed text-muted-foreground">
          Load an image to bake a whole-image, tilt-shift, radial, or background blur into it.
        </p>
      </div>
    );
  }

  const backgroundDisabled = !subjectMask;

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-1">
          <h2 className="font-display text-lg text-foreground">Blur</h2>
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-primary">Bake into image</p>
        </div>
        <Aperture className="h-4 w-4 text-primary" />
      </div>

      {/* Type selector */}
      <div
        role="radiogroup"
        aria-label="Blur type"
        className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-card/50 p-0.5 font-mono-ui text-[10px] uppercase tracking-[0.12em]"
      >
        {TYPE_OPTIONS.map((option) => {
          const disabled = option.value === "background" && backgroundDisabled;
          const active = type === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              title={disabled ? "Run Cutout first to blur the background" : undefined}
              onClick={() => setType(option.value)}
              className={`rounded-md px-2 py-1.5 transition-colors ${
                active
                  ? "bg-primary text-primary-foreground"
                  : disabled
                    ? "text-muted-foreground/40 cursor-not-allowed"
                    : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {backgroundDisabled ? (
        <p className="-mt-2 px-1 font-mono-ui text-[10px] leading-relaxed text-muted-foreground">
          Run Cutout first to blur the background.
        </p>
      ) : null}

      {/* Live preview */}
      <div className="flex items-center justify-center rounded-xl border border-border bg-card/50 p-3">
        <canvas
          ref={previewRef}
          className="max-h-[200px] max-w-full rounded-md"
          aria-label="Blur preview"
        />
      </div>

      {/* Strength (always) */}
      <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-mono-ui text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Strength
          </span>
          <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums">{strength}%</span>
        </div>
        <SliderField label="Amount" value={strength} min={0} max={100} suffix="%" onChange={setStrength} />
      </div>

      {/* Type-specific controls */}
      {type === "tilt" ? (
        <div className="space-y-2">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
            Tilt-shift
          </p>
          <div className="rounded-xl border border-border bg-card/50 py-2 space-y-2">
            <SliderField label="Position" value={center} min={0} max={100} onChange={setCenter} />
            <SliderField label="Band width" value={halfWidth} min={0} max={50} onChange={setHalfWidth} />
            <SliderField label="Feather" value={feather} min={0} max={50} onChange={setFeather} />
          </div>
        </div>
      ) : null}

      {type === "radial" ? (
        <div className="space-y-2">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
            Radial
          </p>
          <div className="rounded-xl border border-border bg-card/50 py-2 space-y-2">
            <SliderField label="Focus size" value={focusSize} min={0} max={100} onChange={setFocusSize} />
          </div>
        </div>
      ) : null}

      {type === "background" ? (
        <p className="px-1 font-mono-ui text-[10px] leading-relaxed text-muted-foreground">
          Subject stays sharp; everything else blurs by the strength above.
        </p>
      ) : null}

      <Button
        type="button"
        onClick={handleApply}
        disabled={applying}
        className="w-full gap-2 font-mono-ui text-[12px]"
      >
        <Aperture className="h-4 w-4" />
        {applying ? "Applying…" : "Apply blur"}
      </Button>
    </div>
  );
};

export default BlurTool;
