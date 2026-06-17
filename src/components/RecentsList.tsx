import React, { useEffect, useState } from "react";
import { Clock, Trash2, X } from "lucide-react";
import type { RecentMeta } from "@/lib/recents";

interface RecentsListProps {
  recents: RecentMeta[];
  isReady: boolean;
  onSelect: (record: RecentMeta) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
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

const RecentsList: React.FC<RecentsListProps> = ({ recents, isReady, onSelect, onRemove, onClear }) => {
  // Hold a now-tick for "X minutes ago" labels. We re-render once a minute,
  // not on every state change.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  if (!isReady) return null;
  if (recents.length === 0) return null;

  return (
    <div className="w-full max-w-xl space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          <span className="font-mono-ui text-[10px] uppercase tracking-[0.18em]">Recent</span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 font-mono-ui text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors"
        >
          <Trash2 className="w-3 h-3" />
          Clear
        </button>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {recents.map((record) => {
          return (
            <div
              key={record.id}
              className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-secondary/40"
            >
              <button
                type="button"
                onClick={() => onSelect(record)}
                className="block h-full w-full"
                title={`${record.name} \u00b7 ${formatRelativeTime(record.addedAt, now)}`}
                aria-label={`Open ${record.name}`}
              >
                {/*
                  No thumbnail: the recents list no longer holds the
                  full source blob, so we can't `URL.createObjectURL`
                  here. The placeholder below shows the file extension
                  and file size so the user can still tell entries
                  apart at a glance. (A follow-up could store a tiny
                  thumbnail blob alongside the source in IDB if
                  thumbnails turn out to be essential.)
                */}
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 font-mono-ui text-[10px] text-muted-foreground/70 uppercase">
                  <span>{record.name.split(".").pop() ?? ""}</span>
                  <span className="opacity-60">{(record.size / 1024).toFixed(0)} KB</span>
                </div>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                  <div className="truncate text-left font-mono-ui text-[10px] text-white">
                    {record.name}
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onRemove(record.id)}
                className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-background/85 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground group-hover:flex"
                aria-label={`Remove ${record.name} from recents`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RecentsList;
