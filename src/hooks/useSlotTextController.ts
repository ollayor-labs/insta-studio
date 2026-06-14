import { useEffect, useRef } from 'react';
import { slotText, type FlashOptions, type SlotOptions, type SlotTextController } from 'slot-text';

import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

/**
 * Imperative `slot-text` controller bound to the lifetime of a host element.
 *
 * Most callers should reach for the declarative `<SlotLabel />` component
 * first — it covers the simple text-change case. This hook exists for the
 * one interaction that needs the imperative `flash` flow: a button that
 * rolls to a confirmation message and then auto-reverts (Copy → Copied →
 * Copy), with a 1.4s dwell on the confirmation. `flash` is spam-safe — a
 * second click restarts the revert timer rather than queueing extra rolls.
 *
 * The hook creates the controller on mount and tears it down on unmount,
 * so the DOM observers that `slot-text` attaches are released as soon as
 * the host element leaves the tree. When the user prefers reduced motion,
 * the controller is never created and the returned ref points at a span
 * that the caller can update with plain text.
 */
export function useSlotTextController<T extends HTMLElement = HTMLSpanElement>(
  initialText: string,
  options?: SlotOptions,
) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const elementRef = useRef<T | null>(null);
  const controllerRef = useRef<SlotTextController | null>(null);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const element = elementRef.current;
    if (!element) return;
    if (controllerRef.current) return;

    controllerRef.current = slotText(element, initialText, options);
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // options intentionally not in deps: options that change at runtime
    // are passed through to `.set` / `.flash` by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReducedMotion]);

  return {
    ref: elementRef,
    set(next: string, nextOptions?: SlotOptions) {
      controllerRef.current?.set(next, nextOptions);
    },
    flash(next: string, flashOptions?: FlashOptions) {
      controllerRef.current?.flash(next, flashOptions);
    },
  };
}
