import React, { useMemo } from "react";
import { Check, Info, Settings2, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  EXPORT_PROFILES,
  buildExportReceipt,
  getExportProfile,
  type ExportProfileId,
} from "@/lib/export";

interface ExportProfileMenuProps {
  activeProfileId: ExportProfileId;
  optimizeForSocial: boolean;
  onProfileChange: (id: ExportProfileId) => void;
  onOptimizeForSocialChange: (value: boolean) => void;
  /**
   * When the user turns the toggle ON, the parent can pick a
   * default profile (defaults to "instagram-feed" if not
   * provided). The toggle is a one-click "make it social-ready"
   * shortcut — it does not free the user from picking a profile.
   */
  optimizeForSocialProfileId?: ExportProfileId;
  /** Optional preview dimensions to show in the receipt line. */
  preview?: { width: number; height: number } | null;
  disabled?: boolean;
}

const ExportProfileMenu: React.FC<ExportProfileMenuProps> = ({
  activeProfileId,
  optimizeForSocial,
  onProfileChange,
  onOptimizeForSocialChange,
  optimizeForSocialProfileId = "instagram-feed",
  preview,
  disabled = false,
}) => {
  const activeProfile = useMemo(() => getExportProfile(activeProfileId), [activeProfileId]);

  // The receipt line: shown both in the trigger button and at
  // the top of the popover. We pass a synthetic "actual" size
  // from the preview when available, otherwise from the
  // resolved target dimensions of the profile.
  const receipt = useMemo(() => {
    if (preview) {
      return buildExportReceipt({
        profile: activeProfile,
        actualWidth: preview.width,
        actualHeight: preview.height,
        watermark: false,
      });
    }
    return activeProfile.label;
  }, [activeProfile, preview]);

  return (
    <Popover>
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Settings2 className="h-3 w-3" />
                <span className="hidden sm:inline">{activeProfile.label}</span>
                <span className="hidden md:inline text-muted-foreground">·</span>
                <span className="hidden md:inline text-muted-foreground normal-case tracking-normal">
                  {preview ? `${preview.width}×${preview.height}` : ""}
                </span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">Export profile · strict social-platform spec</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="border-b border-border bg-card/40 p-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-foreground">
              Export Profile
            </p>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Strict platform spec. The numbers below are <em>contracts</em> — what the file will be when it lands.
          </p>
          <div className="mt-2 rounded-md border border-border bg-background/60 p-2 font-mono-ui text-[10px] text-foreground">
            {receipt}
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto p-1.5">
          {EXPORT_PROFILES.map((profile) => {
            const active = profile.id === activeProfileId;
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => onProfileChange(profile.id)}
                className={`flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors ${
                  active
                    ? "bg-primary/10 ring-1 ring-primary/40"
                    : "hover:bg-secondary/50"
                }`}
                aria-pressed={active}
              >
                <div className="mt-0.5">
                  {active ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <div className="h-3.5 w-3.5 rounded-full border border-border" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-ui text-[11px] uppercase tracking-[0.12em] text-foreground">
                      {profile.label}
                    </span>
                    {profile.maxLongestEdge !== null ? (
                      <Badge variant="outline" className="h-4 px-1.5 font-mono-ui text-[9px] tracking-[0.1em]">
                        {profile.maxLongestEdge}px
                      </Badge>
                    ) : null}
                    {profile.srgb ? (
                      <Badge variant="outline" className="h-4 px-1.5 font-mono-ui text-[9px] tracking-[0.1em]">
                        sRGB
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                    {profile.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="border-t border-border bg-card/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Label
                htmlFor="optimize-for-social"
                className="flex items-center gap-1.5 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-foreground"
              >
                Optimize for Social
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 cursor-help text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[260px]">
                      When on, exports are auto-resized to a platform-safe longest edge, converted to sRGB, mildly
                      sharpened, and have EXIF stripped. Off keeps your custom format / size.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Snaps to {getExportProfile(optimizeForSocialProfileId).label} when on.
              </p>
            </div>
            <Switch
              id="optimize-for-social"
              checked={optimizeForSocial}
              onCheckedChange={(value) => {
                onOptimizeForSocialChange(value);
                if (value) onProfileChange(optimizeForSocialProfileId);
              }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default ExportProfileMenu;
