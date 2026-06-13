import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function getMatchMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(QUERY);
  } catch {
    return null;
  }
}

/**
 * Returns true when the user has expressed a preference for reduced
 * motion (system-level "Reduce motion" / browser-level setting). The
 * hook listens for live changes so the UI can react as soon as the
 * user toggles the system setting.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    const media = getMatchMedia();
    return media ? media.matches : false;
  });

  useEffect(() => {
    const media = getMatchMedia();
    if (!media) return;

    const handleChange = (event: MediaQueryListEvent) => {
      setReduce(event.matches);
    };

    // Sync once at mount in case the value changed between render and effect.
    setReduce(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return reduce;
}
