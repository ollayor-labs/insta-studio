import React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
import type { TextLayer } from "@/lib/text/types";
import { createTextLayer } from "@/lib/text/types";
import { TEXT_FONTS } from "@/lib/text/fonts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface TextToolProps {
  layers: TextLayer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onLayersChange: (layers: TextLayer[]) => void;
}

function hasStyle(fontStyle: string, token: "bold" | "italic"): boolean {
  return fontStyle.split(" ").includes(token);
}

function toggleStyle(fontStyle: string, token: "bold" | "italic"): string {
  const parts = new Set(fontStyle.split(" ").filter((p) => p && p !== "normal"));
  if (parts.has(token)) parts.delete(token);
  else parts.add(token);
  // Preserve conventional ordering: "bold italic".
  const ordered = ["bold", "italic"].filter((t) => parts.has(t));
  return ordered.length ? ordered.join(" ") : "normal";
}

function LabeledSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1 px-1">
      <div className="flex items-center justify-between">
        <span className="font-mono-ui text-[11px] text-muted-foreground">{label}</span>
        <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="filtr-slider"
      />
    </div>
  );
}

const TextTool: React.FC<TextToolProps> = ({
  layers,
  selectedId,
  onSelect,
  onLayersChange,
}) => {
  const selected = layers.find((l) => l.id === selectedId) ?? null;

  const addText = () => {
    const layer = createTextLayer({ text: "Your text", x: 0.5, y: 0.45 });
    onLayersChange([...layers, layer]);
    onSelect(layer.id);
  };

  const removeLayer = (id: string) => {
    onLayersChange(layers.filter((l) => l.id !== id));
    if (selectedId === id) onSelect(null);
  };

  const update = (patch: Partial<TextLayer>) => {
    if (!selected) return;
    const next = { ...selected, ...patch };
    onLayersChange(layers.map((l) => (l.id === next.id ? next : l)));
  };

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-1">
          <h2 className="font-display text-lg text-foreground">Text</h2>
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-primary">
            Typography
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addText}
          className="h-8 gap-1.5 font-mono-ui text-[11px]"
        >
          <Plus className="h-3 w-3" />
          Add text
        </Button>
      </div>

      {/* Layer list */}
      {layers.length ? (
        <div className="rounded-xl border border-border bg-card/50 p-1 space-y-0.5">
          {layers.map((l) => (
            <div
              key={l.id}
              className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
                l.id === selectedId ? "bg-primary/15" : "hover:bg-card/80"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(l.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Type className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate text-[12px] text-foreground/90">
                  {l.text.trim() || "(empty)"}
                </span>
              </button>
              <button
                type="button"
                aria-label="Delete text layer"
                onClick={() => removeLayer(l.id)}
                className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-1 font-mono-ui text-[11px] leading-relaxed text-muted-foreground">
          Add text to get started.
        </p>
      )}

      {/* Property editors for the selected layer */}
      {selected ? (
        <div className="space-y-4">
          {/* Text content */}
          <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-2">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              Content
            </p>
            <textarea
              value={selected.text}
              onChange={(e) => update({ text: e.target.value })}
              rows={2}
              placeholder="Type here…"
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {/* Font + style */}
          <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              Typeface
            </p>
            <Select
              value={selected.fontFamily}
              onValueChange={(family) => update({ fontFamily: family })}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Font" />
              </SelectTrigger>
              <SelectContent>
                {TEXT_FONTS.map((f) => (
                  <SelectItem key={f.family} value={f.family}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={hasStyle(selected.fontStyle, "bold")}
                onClick={() =>
                  update({ fontStyle: toggleStyle(selected.fontStyle, "bold") })
                }
                className={`flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors ${
                  hasStyle(selected.fontStyle, "bold")
                    ? "bg-primary text-primary-foreground"
                    : "bg-card/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                <Bold className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={hasStyle(selected.fontStyle, "italic")}
                onClick={() =>
                  update({ fontStyle: toggleStyle(selected.fontStyle, "italic") })
                }
                className={`flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors ${
                  hasStyle(selected.fontStyle, "italic")
                    ? "bg-primary text-primary-foreground"
                    : "bg-card/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                <Italic className="h-3.5 w-3.5" />
              </button>

              <div className="ml-auto flex items-center gap-1">
                {(
                  [
                    { value: "left", Icon: AlignLeft },
                    { value: "center", Icon: AlignCenter },
                    { value: "right", Icon: AlignRight },
                  ] as const
                ).map(({ value, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={selected.align === value}
                    onClick={() => update({ align: value })}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors ${
                      selected.align === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-card/50 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            </div>

            <LabeledSlider
              label="Size"
              value={selected.fontSizeN}
              min={0.02}
              max={0.3}
              step={0.001}
              display={`${Math.round(selected.fontSizeN * 100)}%`}
              onChange={(v) => update({ fontSizeN: v })}
            />
          </div>

          {/* Color + opacity */}
          <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              Fill
            </p>
            <div className="flex items-center gap-2 px-1">
              <span className="font-mono-ui text-[11px] text-muted-foreground">Color</span>
              <input
                type="color"
                value={selected.fill}
                onChange={(e) => update({ fill: e.target.value })}
                className="ml-auto h-7 w-12 cursor-pointer rounded border border-border bg-transparent"
              />
            </div>
            <LabeledSlider
              label="Opacity"
              value={selected.opacity}
              min={0}
              max={1}
              step={0.01}
              display={`${Math.round(selected.opacity * 100)}%`}
              onChange={(v) => update({ opacity: v })}
            />
          </div>

          {/* Stroke */}
          <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              Stroke
            </p>
            <div className="flex items-center gap-2 px-1">
              <span className="font-mono-ui text-[11px] text-muted-foreground">Color</span>
              <input
                type="color"
                value={selected.stroke ?? "#000000"}
                onChange={(e) => update({ stroke: e.target.value })}
                className="ml-auto h-7 w-12 cursor-pointer rounded border border-border bg-transparent"
              />
            </div>
            <LabeledSlider
              label="Width"
              value={selected.strokeWidthN ?? 0}
              min={0}
              max={0.02}
              step={0.0005}
              display={(selected.strokeWidthN ?? 0).toFixed(4)}
              onChange={(v) => update({ strokeWidthN: v })}
            />
          </div>

          {/* Shadow */}
          <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              Shadow
            </p>
            <div className="flex items-center gap-2 px-1">
              <span className="font-mono-ui text-[11px] text-muted-foreground">Color</span>
              <input
                type="color"
                value={selected.shadowColor ?? "#000000"}
                onChange={(e) => update({ shadowColor: e.target.value })}
                className="ml-auto h-7 w-12 cursor-pointer rounded border border-border bg-transparent"
              />
            </div>
            <LabeledSlider
              label="Blur"
              value={selected.shadowBlurN ?? 0}
              min={0}
              max={0.05}
              step={0.001}
              display={(selected.shadowBlurN ?? 0).toFixed(3)}
              onChange={(v) => update({ shadowBlurN: v })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default TextTool;
