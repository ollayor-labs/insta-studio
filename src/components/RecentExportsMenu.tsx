import React, { useEffect, useMemo, useState } from "react";
import { History, Trash2, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type ExportHistoryRecord } from "@/lib/export";

interface RecentExportsMenuProps {
  history: ExportHistoryRecord[];
  onApply: (record: ExportHistoryRecord) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  disabled?: boolean;
  /**
   * Controlled popover state. The page passes these so a
   * post-export "View" action in the receipt toast can pop
   * the menu open without coupling the menu to internal
   * trigger refs.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function formatRelativeTime(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.round(delta / minute)}m ago`;
  if (delta < day) return `${Math.round(delta / hour)}h ago`;
  return `${Math.round(delta / day)}d ago`;
}

const RecentExportsMenu: React.FC<RecentExportsMenuProps> = ({
  history,
  onApply,
  onRemove,
  onClear,
  disabled = false,
  open,
  onOpenChange,
}) => {
  // Refresh "Xm ago" labels every minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  // Build per-id object URLs for thumbnails. Same pattern as
  // RecentsList: small (128px) JPEGs, revoked on unmount.
  const thumbUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of history) {
      if (!record.thumbBlob) continue;
      try {
        map.set(record.id, URL.createObjectURL(record.thumbBlob));
      } catch {
        // Some test environments reject createObjectURL; skip
        // silently.
      }
    }
    return map;
  }, [history]);

  useEffect(() => {
    return () => {
      for (const url of thumbUrls.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [thumbUrls]);

  const count = history.length;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className="relative flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <History className="h-3 w-3" />
                <span className="hidden sm:inline">Exports</span>
                {count > 0 ? (
                  <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary/15 px-1 font-mono-ui text-[9px] tracking-normal text-primary">
                    {count}
                  </span>
                ) : null}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">Recent exports — click to re-apply settings</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b border-border bg-card/40 p-3">
          <div className="flex items-center gap-2">
            <History className="h-3.5 w-3.5 text-primary" />
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-foreground">
              Recent Exports
            </p>
            {count > 0 ? (
              <span className="font-mono-ui text-[10px] text-muted-foreground">({count})</span>
            ) : null}
          </div>
          {count > 0 ? (
            <button
              type="button"
              onClick={onClear}
              className="flex items-center gap-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          ) : null}
        </div>

        {count === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.14em]">No exports yet</p>
            <p className="mt-1 text-[11px]">Exports you run will show up here.</p>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto p-1.5">
            {history.map((record) => {
              const url = thumbUrls.get(record.id);
              return (
                <div
                  key={record.id}
                  className="group flex items-center gap-2 rounded-md p-1.5 transition-colors hover:bg-secondary/50"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onApply(record);
                      onOpenChange?.(false);
                    }}
                    className="flex flex-1 items-center gap-2 text-left"
                    title={`Re-apply ${record.profileLabel} settings`}
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border bg-secondary/40">
                      {url ? (
                        <img
                          src={url}
                          alt=""
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center font-mono-ui text-[8px] text-muted-foreground">
                          {record.format.toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono-ui text-[10px] uppercase tracking-[0.12em] text-foreground">
                          {record.profileLabel}
                        </span>
                        <span className="font-mono-ui text-[10px] text-muted-foreground">
                          {record.width}×{record.height}
                        </span>
                      </div>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {record.filterName} · {formatRelativeTime(record.date, now)}
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(record.id)}
                    aria-label={`Remove ${record.fileName}`}
                    className="hidden h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background/80 hover:text-foreground group-hover:flex"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default RecentExportsMenu;
