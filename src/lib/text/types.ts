export interface TextLayer {
  id: string;
  text: string;
  x: number;
  y: number; // normalized 0..1 top-left in IMAGE space
  fontSizeN: number; // normalized to image width (e.g. 0.08)
  fontFamily: string;
  fontStyle: string; // "normal" | "bold" | "italic" | "bold italic"
  fill: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacingN: number; // normalized to image width
  opacity: number; // 0..1
  rotation: number; // degrees
  stroke?: string;
  strokeWidthN?: number; // normalized
  shadowColor?: string;
  shadowBlurN?: number;
  shadowOffsetXN?: number;
  shadowOffsetYN?: number;
}

/**
 * Create a new text layer with sensible defaults. Any provided fields in
 * `partial` override the defaults. IDs are generated via crypto.randomUUID().
 */
export function createTextLayer(partial?: Partial<TextLayer>): TextLayer {
  return {
    id: crypto.randomUUID(),
    text: "Your text",
    x: 0.5,
    y: 0.45,
    fontSizeN: 0.08,
    fontFamily: "Inter",
    fontStyle: "normal",
    fill: "#ffffff",
    align: "left",
    lineHeight: 1.1,
    letterSpacingN: 0,
    opacity: 1,
    rotation: 0,
    stroke: undefined,
    strokeWidthN: 0,
    shadowColor: "#000000",
    shadowBlurN: 0,
    shadowOffsetXN: 0,
    shadowOffsetYN: 0,
    ...partial,
  };
}
