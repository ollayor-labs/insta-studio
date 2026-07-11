import Konva from "konva";
import type { TextLayer } from "./types";
import { fontsReadyForExport } from "./fonts";

/**
 * Flatten text layers onto a full-resolution export canvas context. Geometry is
 * stored normalized (0..1 in image space) and denormalized here against the
 * export dimensions so the on-screen preview matches the exported pixels.
 */
export async function drawTextLayers(
  ctx: CanvasRenderingContext2D,
  exportW: number,
  exportH: number,
  layers: TextLayer[],
): Promise<void> {
  if (!layers.length) return;

  await fontsReadyForExport(layers.map((l) => l.fontFamily));

  const container = document.createElement("div");
  const stage = new Konva.Stage({ container, width: exportW, height: exportH });
  const layer = new Konva.Layer();
  stage.add(layer);

  for (const l of layers) {
    const strokeWidth = (l.strokeWidthN ?? 0) * exportW;
    const node = new Konva.Text({
      x: l.x * exportW,
      y: l.y * exportH,
      text: l.text,
      fontSize: l.fontSizeN * exportW,
      fontFamily: l.fontFamily,
      fontStyle: l.fontStyle,
      fill: l.fill,
      align: l.align,
      lineHeight: l.lineHeight,
      letterSpacing: l.letterSpacingN * exportW,
      opacity: l.opacity,
      rotation: l.rotation,
      stroke: strokeWidth > 0 ? l.stroke : undefined,
      strokeWidth: strokeWidth > 0 ? strokeWidth : 0,
      shadowColor: l.shadowColor,
      shadowBlur: (l.shadowBlurN ?? 0) * exportW,
      shadowOffsetX: (l.shadowOffsetXN ?? 0) * exportW,
      shadowOffsetY: (l.shadowOffsetYN ?? 0) * exportW,
    });
    layer.add(node);
  }

  layer.draw();
  ctx.drawImage(stage.toCanvas({ pixelRatio: 1 }), 0, 0);
  stage.destroy();
}
