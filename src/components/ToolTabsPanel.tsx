import React from "react";
import {
  SlidersHorizontal,
  Crop as CropIcon,
  Type,
  Aperture,
  Scissors,
  LayoutTemplate,
  Tags,
  type LucideIcon,
} from "lucide-react";
import type { Adjustments, FilterPreset, PresetRecommendation } from "@/lib/filterEngine";
import type { CropState } from "@/lib/crop";
import type { TextLayer } from "@/lib/text/types";
import type { MetadataPrivacy } from "@/lib/metadata";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import AdjustmentsPanel from "./AdjustmentsPanel";
import CropTool from "./tools/CropTool";
import GuidesTool from "./tools/GuidesTool";
import MetadataTool from "./tools/MetadataTool";
import TextTool from "./tools/TextTool";
import CutoutTool from "./tools/CutoutTool";
import BlurTool from "./tools/BlurTool";

type SceneMode = "adaptive" | "studio";

export interface ToolTabsPanelProps {
  // Tone (filter engine)
  activePreset: FilterPreset;
  recommendation?: PresetRecommendation;
  adjustments: Adjustments;
  filterStrength: number;
  effectIntensity: number;
  onFilterStrengthChange: (value: number) => void;
  onEffectIntensityChange: (value: number) => void;
  onChange: (key: keyof Adjustments, value: number) => void;
  onReset: () => void;
  onSavePreset: (name: string) => void;
  canSavePreset: boolean;
  sceneMode: SceneMode;
  onSceneModeChange: (mode: SceneMode) => void;

  // Crop
  sourceImage: HTMLImageElement | null;
  cropState: CropState;
  onCropChange: (next: CropState) => void;
  onOpenCropEditor: () => void;

  // Text
  textLayers: TextLayer[];
  selectedTextId: string | null;
  onSelectText: (id: string | null) => void;
  onTextLayersChange: (layers: TextLayer[]) => void;

  // Guides
  guidePlatform: string | null;
  onGuideChange: (id: string | null) => void;

  // Cutout (background remove)
  onCutoutApply: (result: {
    canvas: HTMLCanvasElement;
    mask: Uint8Array;
    maskW: number;
    maskH: number;
  }) => void;

  // Blur
  subjectMask: { data: Uint8Array; w: number; h: number } | null;
  onBlurApply: (canvas: HTMLCanvasElement) => void;

  // Metadata
  metadataFile: File | Blob | null;
  metadataPrivacy: MetadataPrivacy;
  onMetadataPrivacyChange: (p: MetadataPrivacy) => void;

  // Notifies the parent which tool tab is active (used to gate the
  // interactive text overlay on the canvas).
  onActiveToolChange?: (value: string) => void;
}

type ToolTab = { value: string; label: string; icon: LucideIcon };

const TOOL_TABS: ToolTab[] = [
  { value: "tone", label: "Tone", icon: SlidersHorizontal },
  { value: "crop", label: "Crop", icon: CropIcon },
  { value: "text", label: "Text", icon: Type },
  { value: "blur", label: "Blur", icon: Aperture },
  { value: "bg", label: "Cutout", icon: Scissors },
  { value: "guides", label: "Guides", icon: LayoutTemplate },
  { value: "meta", label: "Meta", icon: Tags },
];

const ToolTabsPanel: React.FC<ToolTabsPanelProps> = (props) => {
  return (
    <Tabs
      defaultValue="tone"
      onValueChange={props.onActiveToolChange}
      className="flex h-full w-full flex-col"
    >
      <TabsList className="grid h-auto w-full shrink-0 grid-cols-4 gap-1 rounded-none border-b border-border bg-transparent p-2">
        {TOOL_TABS.map(({ value, label, icon: Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="flex flex-col items-center gap-1 rounded-md px-1 py-1.5 text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-primary data-[state=active]:shadow-none"
          >
            <Icon className="h-4 w-4" />
            <span className="font-mono-ui text-[9px] uppercase tracking-[0.1em]">{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="tone" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <AdjustmentsPanel
          activePreset={props.activePreset}
          recommendation={props.recommendation}
          adjustments={props.adjustments}
          filterStrength={props.filterStrength}
          effectIntensity={props.effectIntensity}
          onFilterStrengthChange={props.onFilterStrengthChange}
          onEffectIntensityChange={props.onEffectIntensityChange}
          onChange={props.onChange}
          onReset={props.onReset}
          onSavePreset={props.onSavePreset}
          canSavePreset={props.canSavePreset}
          sceneMode={props.sceneMode}
          onSceneModeChange={props.onSceneModeChange}
        />
      </TabsContent>

      <TabsContent value="crop" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <CropTool
          cropState={props.cropState}
          onCropChange={props.onCropChange}
          sourceImage={props.sourceImage}
          onOpenEditor={props.onOpenCropEditor}
        />
      </TabsContent>

      <TabsContent value="text" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <TextTool
          layers={props.textLayers}
          selectedId={props.selectedTextId}
          onSelect={props.onSelectText}
          onLayersChange={props.onTextLayersChange}
        />
      </TabsContent>

      <TabsContent value="blur" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <BlurTool
          sourceImage={props.sourceImage}
          subjectMask={props.subjectMask}
          onApply={props.onBlurApply}
        />
      </TabsContent>

      <TabsContent value="bg" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <CutoutTool sourceImage={props.sourceImage} onApply={props.onCutoutApply} />
      </TabsContent>

      <TabsContent value="guides" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <GuidesTool activePlatform={props.guidePlatform} onPlatformChange={props.onGuideChange} />
      </TabsContent>

      <TabsContent value="meta" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <MetadataTool
          file={props.metadataFile}
          privacy={props.metadataPrivacy}
          onPrivacyChange={props.onMetadataPrivacyChange}
        />
      </TabsContent>
    </Tabs>
  );
};

export default ToolTabsPanel;
