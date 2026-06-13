import React, { useState } from "react";
import { BookmarkPlus, Check, RotateCcw } from "lucide-react";
import type { Adjustments, FilterPreset, PresetRecommendation } from "@/lib/filterEngine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SceneMode = "adaptive" | "studio";

interface AdjustmentsPanelProps {
  activePreset: FilterPreset;
  recommendation?: PresetRecommendation;
  adjustments: Adjustments;
  filterStrength: number;
  effectIntensity: number;
  onFilterStrengthChange: (value: number) => void;
  onEffectIntensityChange: (value: number) => void;
  onChange: (key: keyof Adjustments, value: number) => void;
  onReset: () => void;
  onSavePreset: (name: string) => void;
  canSavePreset: boolean;
  sceneMode: SceneMode;
  onSceneModeChange: (mode: SceneMode) => void;
}

interface SliderConfig {
  key: keyof Adjustments;
  label: string;
  min: number;
  max: number;
}

const SLIDER_SECTIONS: Array<{
  title: string;
  sliders: SliderConfig[];
}> = [
  {
    title: "Tone",
    sliders: [
      { key: "brightness", label: "Brightness", min: -100, max: 100 },
      { key: "contrast", label: "Contrast", min: -100, max: 100 },
      { key: "highlights", label: "Highlights", min: -100, max: 100 },
      { key: "shadows", label: "Shadows", min: -100, max: 100 },
      { key: "whites", label: "Whites", min: -100, max: 100 },
      { key: "blacks", label: "Blacks", min: -100, max: 100 },
    ],
  },
  {
    title: "Color",
    sliders: [
      { key: "saturation", label: "Saturation", min: -100, max: 100 },
      { key: "vibrance", label: "Vibrance", min: -100, max: 100 },
      { key: "temperature", label: "Temperature", min: -100, max: 100 },
      { key: "tint", label: "Tint", min: -100, max: 100 },
    ],
  },
  {
    title: "Detail",
    sliders: [
      { key: "clarity", label: "Clarity", min: -100, max: 100 },
      { key: "sharpness", label: "Sharpness", min: -100, max: 100 },
      { key: "bloom", label: "Bloom", min: 0, max: 100 },
    ],
  },
  {
    title: "Finish",
    sliders: [
      { key: "fade", label: "Fade", min: 0, max: 100 },
      { key: "grain", label: "Grain", min: 0, max: 100 },
      { key: "vignette", label: "Vignette", min: 0, max: 100 },
    ],
  },
];

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const isCentered = min < 0;

  return (
    <div className="space-y-1 px-1">
      <div className="flex items-center justify-between">
        <span className="font-mono-ui text-[11px] text-muted-foreground">{label}</span>
        <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums w-10 text-right">
          {value > 0 ? `+${value}` : value}
        </span>
      </div>
      <div className="relative">
        {isCentered ? (
          <div className="absolute top-1/2 left-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-muted-foreground/30" />
        ) : null}
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="filtr-slider"
        />
      </div>
    </div>
  );
}

const AdjustmentsPanel: React.FC<AdjustmentsPanelProps> = ({
  activePreset,
  recommendation,
  adjustments,
  filterStrength,
  effectIntensity,
  onFilterStrengthChange,
  onEffectIntensityChange,
  onChange,
  onReset,
  onSavePreset,
  canSavePreset,
  sceneMode,
  onSceneModeChange,
}) => {
  const [saveName, setSaveName] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const handleSave = () => {
    const trimmed = saveName.trim() || `Custom ${activePreset.name}`;
    onSavePreset(trimmed);
    setSaveName("");
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1200);
  };
  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-1">
          <h2 className="font-display text-lg text-foreground">Adjust</h2>
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-primary">
            {activePreset.category}
          </p>
        </div>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors font-mono-ui text-[11px]"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      <div
        role="radiogroup"
        aria-label="Scene adaptation mode"
        className="flex items-center rounded-lg border border-border bg-card/50 p-0.5 font-mono-ui text-[10px] uppercase tracking-[0.14em]"
      >
        <button
          type="button"
          role="radio"
          aria-checked={sceneMode === "adaptive"}
          onClick={() => onSceneModeChange("adaptive")}
          className={`flex-1 rounded-md px-2 py-1.5 transition-colors ${
            sceneMode === "adaptive"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Adaptive
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sceneMode === "studio"}
          onClick={() => onSceneModeChange("studio")}
          className={`flex-1 rounded-md px-2 py-1.5 transition-colors ${
            sceneMode === "studio"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Studio
        </button>
      </div>
      <p className="-mt-2 px-1 font-mono-ui text-[10px] leading-relaxed text-muted-foreground">
        {sceneMode === "adaptive"
          ? "Engine reduces aggressive adjustments on portraits, low-light, and bright scenes."
          : "Engine applies the preset exactly. No scene-aware overrides."}
      </p>

      <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-mono-ui text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Save Preset
          </span>
          <span className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {activePreset.id.startsWith("custom-") || activePreset.category === "Custom"
              ? "Custom"
              : `From ${activePreset.name}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={saveName}
            onChange={(event) => setSaveName(event.target.value)}
            placeholder="My preset name"
            className="h-8 text-xs"
            disabled={!canSavePreset}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSave();
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleSave}
            disabled={!canSavePreset}
            className="h-8 gap-1.5 font-mono-ui text-[11px]"
          >
            {savedFlash ? <Check className="h-3 w-3" /> : <BookmarkPlus className="h-3 w-3" />}
            {savedFlash ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/70 px-3 py-3 space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-mono-ui text-[11px] uppercase tracking-[0.16em] text-foreground">
              {activePreset.name}
            </h3>
            {recommendation ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono-ui text-[9px] uppercase tracking-[0.12em] text-primary">
                Recommended
              </span>
            ) : null}
          </div>
          <p className="text-[12px] leading-relaxed text-foreground/90">{activePreset.mood}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{activePreset.description}</p>
        </div>

        <div className="space-y-1">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Why it works
          </p>
          <p className="text-[11px] leading-relaxed text-secondary-foreground">
            {activePreset.whyItWorks}
          </p>
          {recommendation?.reasons.length ? (
            <p className="text-[11px] leading-relaxed text-primary/90">
              Best match because of {recommendation.reasons.join(" and ")}.
            </p>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-mono-ui text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Preset Strength
          </span>
          <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums">
            {filterStrength}%
          </span>
        </div>
        <SliderField
          label="Strength"
          value={filterStrength}
          min={0}
          max={100}
          onChange={onFilterStrengthChange}
        />
      </div>

      <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-mono-ui text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Master Intensity
          </span>
          <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums">
            {effectIntensity}%
          </span>
        </div>
        <SliderField
          label="Intensity"
          value={effectIntensity}
          min={0}
          max={100}
          onChange={onEffectIntensityChange}
        />
      </div>

      {SLIDER_SECTIONS.map((section) => (
        <div key={section.title} className="space-y-2">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground px-1">
            {section.title}
          </p>
          <div className="rounded-xl border border-border bg-card/50 py-2 space-y-2">
            {section.sliders.map(({ key, label, min, max }) => (
              <SliderField
                key={key}
                label={label}
                value={adjustments[key]}
                min={min}
                max={max}
                onChange={(value) => onChange(key, value)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

export default AdjustmentsPanel;
