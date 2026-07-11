// Importing the fontsource CSS here ensures the @font-face rules are pulled in
// wherever fonts.ts is imported (we intentionally do not edit main.tsx).
import "@fontsource/inter";
import "@fontsource/oswald";
import "@fontsource/bebas-neue";
import "@fontsource/playfair-display";

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
