import React from "react";
import { EyeOff, Frame } from "lucide-react";
import { GUIDE_PLATFORMS } from "@/lib/guides";

export interface GuidesToolProps {
  activePlatform: string | null;
  onPlatformChange: (id: string | null) => void;
}

/**
 * Tool panel for toggling the Safe-Area Guides overlay. Picking a platform
 * shows that platform's UI-chrome zones over the preview; the overlay is
 * preview-only and never affects an export.
 */
const GuidesTool: React.FC<GuidesToolProps> = ({ activePlatform, onPlatformChange }) => {
  const isOff = activePlatform === null;

  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Frame className="h-4 w-4 text-primary" />
        <h2 className="font-display text-lg text-foreground">Safe-Area Guides</h2>
      </div>
      <p className="-mt-2 px-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-primary">
        Overlay only — never exported
      </p>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onPlatformChange(null)}
          className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
            isOff
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-card/50 text-muted-foreground hover:text-foreground"
          }`}
        >
          <EyeOff className="h-3.5 w-3.5 shrink-0" />
          <span className="font-mono-ui text-[12px] uppercase tracking-[0.12em]">Off</span>
        </button>

        {GUIDE_PLATFORMS.map((platform) => {
          const isActive = platform.id === activePlatform;
          return (
            <button
              key={platform.id}
              type="button"
              onClick={() => onPlatformChange(platform.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card/50 text-secondary-foreground hover:text-foreground"
              }`}
            >
              <span className="text-[13px] leading-tight">{platform.label}</span>
              <span className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {platform.aspectLabel}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default GuidesTool;
