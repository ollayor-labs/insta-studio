import React from "react";
import type { LucideIcon } from "lucide-react";

interface ToolStubProps {
  icon: LucideIcon;
  title: string;
  blurb: string;
  planned: string[];
}

/**
 * Placeholder shown inside a tool tab that has not been implemented yet.
 * Keeps the tabbed panel navigable during the phased build-out.
 */
const ToolStub: React.FC<ToolStubProps> = ({ icon: Icon, title, blurb, planned }) => (
  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card/60">
      <Icon className="h-5 w-5 text-primary" />
    </div>
    <h3 className="font-display text-base text-foreground">{title}</h3>
    <p className="mt-1 font-mono-ui text-[10px] uppercase tracking-[0.16em] text-primary">
      Coming soon
    </p>
    <p className="mt-3 max-w-[15rem] text-[12px] leading-relaxed text-muted-foreground">{blurb}</p>
    {planned.length ? (
      <ul className="mt-4 space-y-1.5 text-left">
        {planned.map((item) => (
          <li
            key={item}
            className="flex items-start gap-2 text-[11px] leading-relaxed text-secondary-foreground"
          >
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
            {item}
          </li>
        ))}
      </ul>
    ) : null}
  </div>
);

export default ToolStub;
