import * as React from 'react';
import { SlotText, type SlotTextProps } from 'slot-text/react';
import { chromatic } from 'slot-text';

import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';

type SlotLabelTone = 'inherit' | 'primary' | 'muted' | 'subtle';

interface SlotLabelProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'onAnimationStart' | 'onAnimationEnd' | 'onDrag' | 'onDragStart' | 'onDragEnd'> {
  /** Text to display and animate to on change. */
  text: string;
  /**
   * When true, the new text rolls in with a brief chromatic tint that fades
   * back to the resting color. Useful for confirmation states (`Copied`).
   */
  flashColor?: boolean;
  /**
   * Skip the roll animation when the new text equals the previous text.
   * Defaults to `false` so every state change plays a roll.
   */
  skipUnchanged?: boolean;
  /** Roll direction. Defaults to `"down"`, matching the slot-text default. */
  direction?: 'up' | 'down';
  /**
   * Visual tone. Defaults to `"inherit"` so the label picks up the
   * surrounding button / chip color (e.g. a primary button child still
   * renders as `text-primary-foreground`). Set this when the label sits
   * inside a non-colored wrapper and you need to set the color yourself.
   */
  tone?: SlotLabelTone;
}

const TONE_CLASSES: Record<SlotLabelTone, string> = {
  // `text-current` is the safest fallback: the label never overrides the
  // parent button's color, so primary buttons still render their
  // `text-primary-foreground` children correctly.
  inherit: 'text-current',
  primary: 'text-primary',
  muted: 'text-muted-foreground',
  // Used for the small "Auto-cycling" / "Drag slider on image" chip.
  subtle: 'text-muted-foreground/80',
};

/**
 * A short, stateful label that rolls between values rather than swapping
 * them. Wraps the dependency-free `slot-text` controller and is the one
 * place that knows about that dependency — the rest of the app should
 * reach for `<SlotLabel>` instead of importing from `slot-text` directly.
 *
 * The component is keyboard / screen-reader friendly: the underlying
 * `SlotText` sets `aria-label` to the current text on every render, and
 * the wrapped `<span>` is non-interactive so it does not steal focus.
 *
 * Reduced-motion users get the static text (no roll, no chromatic tint).
 */
export const SlotLabel = React.forwardRef<HTMLSpanElement, SlotLabelProps>(
  (
    {
      text,
      flashColor = false,
      skipUnchanged = false,
      direction = 'down',
      tone = 'inherit',
      className,
      ...rest
    },
    ref,
  ) => {
    const prefersReducedMotion = usePrefersReducedMotion();

    // When motion is reduced, render plain text in the same tone so the
    // label is still visually consistent with the rest of the UI. This
    // also lets us skip the chromatic flash path, which would still play
    // a color fade even if the slide were disabled.
    if (prefersReducedMotion) {
      return (
        <span
          ref={ref}
          aria-label={text}
          className={cn('inline-flex whitespace-pre font-mono-ui', TONE_CLASSES[tone], className)}
        >
          {text}
        </span>
      );
    }

    // Build the slot-text options. `chromatic()` returns a per-glyph
    // color function, which is what produces the rainbow sweep across
    // confirmation rolls. We only attach it when requested so non-flash
    // labels stay color-stable and cheaper to paint.
    const options: SlotTextProps['options'] = {
      direction,
      skipUnchanged,
      ...(flashColor ? { color: chromatic({ saturation: 0.55, lightness: 0.65 }) } : {}),
    };

    return (
      <SlotText
        ref={ref}
        text={text}
        options={options}
        aria-label={text}
        className={cn('inline-flex whitespace-pre font-mono-ui', TONE_CLASSES[tone], className)}
        {...rest}
      />
    );
  },
);
SlotLabel.displayName = 'SlotLabel';
