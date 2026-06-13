import React, { useMemo, useState } from "react";
import { AlertTriangle, BarChart3 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ChannelHistogram, ClippingChannels, Histogram } from "@/lib/filterEngine";

interface HistogramBadgeProps {
  histogram: Histogram;
  channelHistogram: ChannelHistogram;
  clipping: ClippingChannels;
  className?: string;
}

const HISTOGRAM_WIDTH = 168;
const HISTOGRAM_HEIGHT = 56;

function summarize(histogram: Histogram) {
  let total = 0;
  let peak = 0;
  let sum = 0;
  for (let index = 0; index < histogram.luminance.length; index += 1) {
    const count = histogram.luminance[index];
    total += count;
    if (count > peak) peak = count;
    sum += count * index;
  }
  const mean = total === 0 ? 0 : sum / total;
  return { total, peak, mean };
}

function buildPath(data: Uint16Array, peak: number, width: number, height: number): string {
  if (peak <= 0) return "";
  const stepX = width / (data.length - 1);
  let path = "";
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index] / peak;
    const x = index * stepX;
    const y = height - value * height;
    path += index === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return path;
}

function describeClipping(clipping: ClippingChannels): string {
  const highlights: string[] = [];
  const shadows: string[] = [];
  if (clipping.highlight.r) highlights.push("R");
  if (clipping.highlight.g) highlights.push("G");
  if (clipping.highlight.b) highlights.push("B");
  if (clipping.shadow.r) shadows.push("R");
  if (clipping.shadow.g) shadows.push("G");
  if (clipping.shadow.b) shadows.push("B");
  if (highlights.length === 0 && shadows.length === 0) return "No clipping detected";
  const parts: string[] = [];
  if (highlights.length > 0) parts.push(`Highlights: ${highlights.join("/")}`);
  if (shadows.length > 0) parts.push(`Shadows: ${shadows.join("/")}`);
  return parts.join(" • ");
}

const HistogramBadge: React.FC<HistogramBadgeProps> = ({
  histogram,
  channelHistogram,
  clipping,
  className,
}) => {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarize(histogram), [histogram]);
  const luminancePath = useMemo(
    () => buildPath(histogram.luminance, summary.peak, HISTOGRAM_WIDTH, HISTOGRAM_HEIGHT),
    [histogram.luminance, summary.peak],
  );
  const redPath = useMemo(
    () => buildPath(channelHistogram.r, summary.peak, HISTOGRAM_WIDTH, HISTOGRAM_HEIGHT),
    [channelHistogram.r, summary.peak],
  );
  const greenPath = useMemo(
    () => buildPath(channelHistogram.g, summary.peak, HISTOGRAM_WIDTH, HISTOGRAM_HEIGHT),
    [channelHistogram.g, summary.peak],
  );
  const bluePath = useMemo(
    () => buildPath(channelHistogram.b, summary.peak, HISTOGRAM_WIDTH, HISTOGRAM_HEIGHT),
    [channelHistogram.b, summary.peak],
  );

  const hasClipping =
    clipping.highlight.r || clipping.highlight.g || clipping.highlight.b ||
    clipping.shadow.r || clipping.shadow.g || clipping.shadow.b;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "flex items-center gap-2 rounded-full border border-border bg-background/70 px-2.5 py-1 font-mono-ui text-[10px] uppercase tracking-[0.18em] text-muted-foreground shadow-md backdrop-blur-md transition-colors",
            hasClipping ? "border-destructive/60 text-destructive" : "hover:text-foreground",
            className,
          )}
          aria-label="Toggle histogram"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          <span>Histogram</span>
          {hasClipping ? <AlertTriangle className="h-3 w-3" /> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="border-border bg-popover p-3 text-foreground">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Histogram
            </p>
            {hasClipping ? (
              <span className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-destructive">
                Clipping
              </span>
            ) : (
              <span className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-primary">
                Clean
              </span>
            )}
          </div>
          <svg
            width={HISTOGRAM_WIDTH}
            height={HISTOGRAM_HEIGHT}
            viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`}
            className="rounded-md bg-background/80"
            role="img"
            aria-label="Luminance and channel histogram"
          >
            <rect x={0} y={0} width={HISTOGRAM_WIDTH} height={HISTOGRAM_HEIGHT} fill="transparent" />
            <path d={redPath} stroke="hsl(var(--destructive))" strokeWidth={1} fill="none" opacity={0.7} />
            <path d={greenPath} stroke="hsl(142 71% 45%)" strokeWidth={1} fill="none" opacity={0.7} />
            <path d={bluePath} stroke="hsl(217 91% 60%)" strokeWidth={1} fill="none" opacity={0.7} />
            <path d={luminancePath} stroke="hsl(var(--foreground))" strokeWidth={1.2} fill="none" opacity={0.55} />
          </svg>
          <p className="font-mono-ui text-[10px] text-muted-foreground">
            Mean {(summary.mean / 255 * 100).toFixed(0)}% • {summary.total.toLocaleString()} samples
          </p>
          <p className="font-mono-ui text-[10px] text-muted-foreground">
            {describeClipping(clipping)}
          </p>
        </div>
      </TooltipContent>
      {expanded ? (
        <div className="absolute right-4 top-4 z-20 rounded-xl border border-border bg-background/90 p-3 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Histogram
            </p>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(false);
              }}
              className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <svg
            width={HISTOGRAM_WIDTH * 1.4}
            height={HISTOGRAM_HEIGHT * 1.4}
            viewBox={`0 0 ${HISTOGRAM_WIDTH * 1.4} ${HISTOGRAM_HEIGHT * 1.4}`}
            className="rounded-md bg-background"
            role="img"
            aria-label="Expanded histogram"
          >
            <path d={redPath} stroke="hsl(var(--destructive))" strokeWidth={1.2} fill="none" opacity={0.8} />
            <path d={greenPath} stroke="hsl(142 71% 45%)" strokeWidth={1.2} fill="none" opacity={0.8} />
            <path d={bluePath} stroke="hsl(217 91% 60%)" strokeWidth={1.2} fill="none" opacity={0.8} />
          </svg>
        </div>
      ) : null}
    </Tooltip>
  );

};

export default HistogramBadge;
