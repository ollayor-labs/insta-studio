export type CueName =
  | "idle"
  | "chime"
  | "sparkle"
  | "droplet"
  | "bloom"
  | "whisper"
  | "tick"
  | "press"
  | "release"
  | "toggle"
  | "success";

/** Spread onto a raw `<button>` to add soft press + release cues (mouse only). */
export const cuePressRelease = {
  "data-cuelume-press": "",
  "data-cuelume-release": "",
} as const;

/** Spread onto a raw `<button>` to add a toggle click cue. */
export const cueToggle = {
  "data-cuelume-toggle": "",
} as const;
