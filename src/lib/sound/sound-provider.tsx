/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { bind, play as cuelumePlay, setEnabled as setCuelumeEnabled } from "cuelume";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { CueName } from "./sound-cues";

const STORAGE_KEY = "filtr.sound";

interface SoundContextValue {
  /** Whether interaction sounds are currently audible. */
  enabled: boolean;
  /** Toggle sounds on/off and persist the preference. */
  setEnabled: (value: boolean) => void;
  /** Play a cue imperatively — respects the enabled flag. */
  play: (cue: CueName) => void;
}

const SoundContext = createContext<SoundContextValue | null>(null);

function readStored(): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // localStorage unavailable (private mode, SSR) — fall through.
  }
  return null;
}

export function SoundProvider({ children }: { children: ReactNode }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const hasStoredPref = useRef(readStored() !== null);
  const [enabled, setEnabledState] = useState<boolean>(() => {
    const stored = readStored();
    if (stored !== null) return stored;
    return !prefersReducedMotion;
  });

  // Wire cuelume's declarative attribute listeners once, globally.
  useEffect(() => {
    bind();
  }, []);

  // Keep cuelume's internal mute flag in sync with our preference.
  useEffect(() => {
    setCuelumeEnabled(enabled);
  }, [enabled]);

  // Respect a system-level "reduce motion" request — but only when the
  // user hasn't made an explicit choice, so an opt-in still honored.
  useEffect(() => {
    if (prefersReducedMotion && !hasStoredPref.current) setEnabledState(false);
  }, [prefersReducedMotion]);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  const play = useCallback(
    (cue: CueName) => {
      if (!enabled) return;
      cuelumePlay(cue);
    },
    [enabled],
  );

  const value = useMemo<SoundContextValue>(
    () => ({ enabled, setEnabled, play }),
    [enabled, setEnabled, play],
  );

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function useSound(): SoundContextValue {
  const ctx = useContext(SoundContext);
  if (!ctx) {
    throw new Error("useSound must be used within a SoundProvider");
  }
  return ctx;
}
