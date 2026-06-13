import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

type Listener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  listeners: Set<Listener>;
  addEventListener: (event: string, listener: Listener) => void;
  removeEventListener: (event: string, listener: Listener) => void;
  dispatchEvent: (event: Event) => boolean;
}

function installMatchMedia(matches: boolean): { current: FakeMediaQueryList; set: (next: boolean) => void } {
  const state: FakeMediaQueryList = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    listeners: new Set(),
    addEventListener: (_event, listener) => state.listeners.add(listener),
    removeEventListener: (_event, listener) => state.listeners.delete(listener),
    dispatchEvent: () => true,
  };
  vi.stubGlobal("matchMedia", () => state);
  return {
    get current() {
      return state;
    },
    set(next: boolean) {
      state.matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of state.listeners) listener(event);
    },
  };
}

describe("usePrefersReducedMotion", () => {
  beforeEach(() => {
    // Reset stub between tests so each case installs its own.
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the media query matches at mount", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("returns false when the media query does not match at mount", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("updates when the media query changes", () => {
    const handle = installMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => {
      handle.set(true);
    });
    expect(result.current).toBe(true);
  });

  it("returns false when matchMedia is unavailable", () => {
    // Don't install the stub — matchMedia is already provided by jsdom
    // through setup.ts, so override it to throw.
    vi.stubGlobal("matchMedia", () => {
      throw new Error("matchMedia unsupported");
    });
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});
