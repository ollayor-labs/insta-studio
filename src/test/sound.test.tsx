import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cuelume", () => ({
  bind: vi.fn(),
  setEnabled: vi.fn(),
  play: vi.fn(),
}));

import { bind, setEnabled, play } from "cuelume";
import { SoundProvider, useSound } from "@/lib/sound/sound-provider";

type Listener = (event: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const state = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    listeners: new Set<Listener>(),
    addEventListener: (_e: string, l: Listener) => state.listeners.add(l),
    removeEventListener: (_e: string, l: Listener) => state.listeners.delete(l),
    dispatchEvent: () => true,
  };
  vi.stubGlobal("matchMedia", () => state);
  return {
    set(next: boolean) {
      state.matches = next;
      for (const l of state.listeners) l({ matches: next } as MediaQueryListEvent);
    },
  };
}

function Probe() {
  const { enabled, setEnabled: toggle, play: playCue } = useSound();
  return (
    <div>
      <span data-testid="enabled">{String(enabled)}</span>
      <button data-testid="toggle" onClick={() => toggle(!enabled)}>
        toggle
      </button>
      <button data-testid="play" onClick={() => playCue("success")}>
        play
      </button>
    </div>
  );
}

describe("SoundProvider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("enables sounds by default when reduced motion is off", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useSound(), { wrapper: SoundProvider });
    expect(result.current.enabled).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("disables sounds when the system requests reduced motion", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useSound(), { wrapper: SoundProvider });
    expect(result.current.enabled).toBe(false);
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it("respects a stored preference over the reduced-motion default", () => {
    installMatchMedia(true);
    localStorage.setItem("filtr.sound", "on");
    const { result } = renderHook(() => useSound(), { wrapper: SoundProvider });
    // Stored "on" wins even when reduced motion is requested.
    expect(result.current.enabled).toBe(true);
  });

  it("persists the preference and syncs cuelume when toggled", () => {
    installMatchMedia(false);
    const { getByTestId } = render(<SoundProvider><Probe /></SoundProvider>);
    act(() => {
      getByTestId("toggle").click();
    });
    expect(localStorage.getItem("filtr.sound")).toBe("off");
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("does not play when sounds are disabled", () => {
    installMatchMedia(false);
    const { getByTestId } = render(<SoundProvider><Probe /></SoundProvider>);
    act(() => {
      getByTestId("toggle").click(); // disable
    });
    act(() => {
      getByTestId("play").click();
    });
    expect(play).not.toHaveBeenCalled();
  });

  it("plays the requested cue when sounds are enabled", () => {
    installMatchMedia(false);
    const { getByTestId } = render(<SoundProvider><Probe /></SoundProvider>);
    act(() => {
      getByTestId("play").click();
    });
    expect(play).toHaveBeenCalledWith("success");
  });

  it("throws when useSound is used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSound())).toThrow(/useSound must be used within/);
    spy.mockRestore();
  });
});
