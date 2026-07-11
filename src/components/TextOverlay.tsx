import React, { useEffect, useRef } from "react";
import { Stage, Layer, Text, Transformer } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { TextLayer } from "@/lib/text/types";

export interface TextOverlayProps {
  width: number; // preview display px of the image box
  height: number;
  layers: TextLayer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (layer: TextLayer) => void;
}

/**
 * Interactive react-konva overlay for editing text layers. Renders each layer
 * using denormalized-to-preview values and writes changes back normalized so
 * geometry survives crop / resize / zoom and matches the export flatten.
 */
const TextOverlay: React.FC<TextOverlayProps> = ({
  width,
  height,
  layers,
  selectedId,
  onSelect,
  onChange,
}) => {
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef<Record<string, Konva.Text | null>>({});

  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const node = selectedId ? nodeRefs.current[selectedId] : null;
    if (node) {
      tr.nodes([node]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedId, layers, width, height]);

  const handleStageMouseDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    // Deselect when clicking on empty area (the stage itself).
    if (e.target === e.target.getStage()) {
      onSelect(null);
    }
  };

  return (
    <Stage
      width={width}
      height={height}
      style={{ position: "absolute", inset: 0, zIndex: 20 }}
      onMouseDown={handleStageMouseDown}
      onTouchStart={handleStageMouseDown}
    >
      <Layer>
        {layers.map((l) => (
          <Text
            key={l.id}
            ref={(node: Konva.Text | null) => {
              nodeRefs.current[l.id] = node;
            }}
            x={l.x * width}
            y={l.y * height}
            text={l.text}
            fontSize={l.fontSizeN * width}
            fontFamily={l.fontFamily}
            fontStyle={l.fontStyle}
            fill={l.fill}
            align={l.align}
            lineHeight={l.lineHeight}
            letterSpacing={l.letterSpacingN * width}
            opacity={l.opacity}
            rotation={l.rotation}
            stroke={(l.strokeWidthN ?? 0) > 0 ? l.stroke : undefined}
            strokeWidth={(l.strokeWidthN ?? 0) * width}
            shadowColor={l.shadowColor}
            shadowBlur={(l.shadowBlurN ?? 0) * width}
            shadowOffsetX={(l.shadowOffsetXN ?? 0) * width}
            shadowOffsetY={(l.shadowOffsetYN ?? 0) * width}
            draggable
            onMouseDown={() => onSelect(l.id)}
            onTap={() => onSelect(l.id)}
            onDragEnd={(e) => {
              const node = e.target as Konva.Text;
              onChange({
                ...l,
                x: node.x() / width,
                y: node.y() / height,
              });
            }}
            onTransformEnd={(e) => {
              const node = e.target as Konva.Text;
              // Bake the scale into fontSize (normalized) and reset scale to 1.
              const scale = node.scaleX();
              const nextFontSizeN = (l.fontSizeN * scale);
              node.scaleX(1);
              node.scaleY(1);
              onChange({
                ...l,
                x: node.x() / width,
                y: node.y() / height,
                rotation: node.rotation(),
                fontSizeN: Math.max(0.005, nextFontSizeN),
              });
            }}
          />
        ))}
        <Transformer
          ref={transformerRef}
          rotateEnabled
          enabledAnchors={["middle-left", "middle-right"]}
          keepRatio={false}
          boundBoxFunc={(oldBox, newBox) => {
            if (newBox.width < 5) return oldBox;
            return newBox;
          }}
        />
      </Layer>
    </Stage>
  );
};

export default TextOverlay;
