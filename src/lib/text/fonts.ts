// Importing the latin subset only keeps the text-overlay bundle small; the
// editor UI is latin-only, and full cyrillic/greek/vietnamese subsets would
// ship unused glyphs. @fontsource/<family>/latin.css pulls just `latin`.
import "@fontsource/inter/latin.css";
import "@fontsource/oswald/latin.css";
import "@fontsource/bebas-neue/latin.css";
import "@fontsource/playfair-display/latin.css";

export interface FontOption {
  label: string;
  family: string;
}

/** Curated set of typefaces available for text layers. */
export const TEXT_FONTS: FontOption[] = [
  { label: "Inter", family: "Inter" },
  { label: "Oswald", family: "Oswald" },
  { label: "Bebas Neue", family: "Bebas Neue" },
  { label: "Playfair Display", family: "Playfair Display" },
];

/**
 * Ensure the requested font families are fully loaded before an export flatten,
 * so Konva/canvas rasterizes the correct glyphs rather than a fallback face.
 */
export async function fontsReadyForExport(families: string[]): Promise<void> {
  const unique = Array.from(new Set(families.filter(Boolean)));
  if (typeof document === "undefined" || !("fonts" in document)) return;

  await Promise.all(
    unique.map((family) =>
      document.fonts.load(`16px "${family}"`).catch(() => undefined),
    ),
  );
  await document.fonts.ready;
}
