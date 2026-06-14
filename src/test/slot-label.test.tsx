import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotLabel } from "@/components/ui/slot-label";

type Listener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  listeners: Set<Listener>;
  addEventListener: (event: string, listener: Listener) => void;
  removeEventListener: (event: string, listener: Listener) => void;
}

function installMatchMedia(matches: boolean) {
  const state: FakeMediaQueryList = {
    matches,
    listeners: new Set(),
    addEventListener: (_event, listener) => state.listeners.add(listener),
    removeEventListener: (_event, listener) => state.listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => state);
  return {
    set(next: boolean) {
      state.matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of state.listeners) listener(event);
    },
  };
}

describe("SlotLabel", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders plain text when reduced motion is preferred", () => {
    installMatchMedia(true);
    const { container, rerender } = render(<SlotLabel text="Copy" tone="muted" />);
    // Reduced motion: no slot-text DOM, just a single span with the text.
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("Copy");
    expect(span?.getAttribute("aria-label")).toBe("Copy");
    expect(container.querySelector(".slot-text")).toBeNull();

    rerender(<SlotLabel text="Copied" tone="muted" />);
    expect(container.querySelector("span")?.textContent).toBe("Copied");
  });

  it("mounts the slot-text DOM when motion is allowed", () => {
    installMatchMedia(false);
    const { container } = render(<SlotLabel text="Copy" />);
    // The slot-text runtime builds `.slot-text` + per-character cells.
    expect(container.querySelector(".slot-text")).not.toBeNull();
  });

  it("updates aria-label when the text prop changes", () => {
    installMatchMedia(false);
    const { container, rerender } = render(<SlotLabel text="Copy" />);
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Copy");
    rerender(<SlotLabel text="Copied" />);
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Copied");
  });

  it("toggles to the reduced-motion path when the media query flips", () => {
    const handle = installMatchMedia(false);
    const { container, rerender } = render(<SlotLabel text="Copy" />);
    expect(container.querySelector(".slot-text")).not.toBeNull();

    act(() => {
      handle.set(true);
    });
    rerender(<SlotLabel text="Copy" />);

    // After the toggle, SlotLabel re-renders as a plain span — no slot-text.
    expect(container.querySelector(".slot-text")).toBeNull();
    expect(container.querySelector("span")?.textContent).toBe("Copy");
  });
});
