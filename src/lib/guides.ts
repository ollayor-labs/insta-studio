/**
 * Safe-Area Guides configuration.
 *
 * Regions are expressed as normalized fractions in the 0..1 range where
 * (x, y) is the top-left corner and (w, h) is the size, both relative to the
 * displayed image box. These describe the platform UI chrome zones (profile
 * bars, action rails, captions, edges) that overlap creator content so users
 * can keep important subjects clear of them. Guides are preview-only and are
 * never baked into an export.
 */

export interface GuideRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface GuidePlatform {
  id: string;
  label: string;
  aspectLabel: string;
  regions: GuideRegion[];
}

export const GUIDE_PLATFORMS: GuidePlatform[] = [
  {
    id: "ig-story",
    label: "Instagram Story",
    aspectLabel: "9:16",
    regions: [
      { x: 0, y: 0, w: 1, h: 0.081, label: "Profile / menu" },
      { x: 0, y: 0.919, w: 1, h: 0.081, label: "Send message" },
    ],
  },
  {
    id: "ig-reels",
    label: "Instagram Reels",
    aspectLabel: "9:16",
    regions: [
      { x: 0, y: 0, w: 1, h: 0.056, label: "Top bar" },
      { x: 0, y: 0.833, w: 1, h: 0.167, label: "Caption / audio" },
      { x: 0, y: 0, w: 0.056, h: 1, label: "Edge" },
      { x: 0.889, y: 0, w: 0.111, h: 1, label: "Action rail" },
    ],
  },
  {
    id: "tiktok",
    label: "TikTok",
    aspectLabel: "9:16",
    regions: [
      { x: 0, y: 0, w: 1, h: 0.068, label: "Tabs / search" },
      { x: 0, y: 0.875, w: 1, h: 0.125, label: "Caption / nav" },
      { x: 0.889, y: 0.35, w: 0.111, h: 0.55, label: "Action rail" },
      { x: 0, y: 0, w: 0.046, h: 1, label: "Edge" },
    ],
  },
  {
    id: "yt-shorts",
    label: "YouTube Shorts",
    aspectLabel: "9:16",
    regions: [
      { x: 0, y: 0, w: 1, h: 0.063, label: "Top" },
      { x: 0, y: 0.818, w: 1, h: 0.182, label: "Title / channel" },
      { x: 0.889, y: 0.3, w: 0.111, h: 0.6, label: "Action rail" },
      { x: 0, y: 0, w: 0.056, h: 1, label: "Edge" },
    ],
  },
  {
    id: "ig-feed-45",
    label: "Instagram Feed 4:5",
    aspectLabel: "4:5",
    regions: [
      { x: 0, y: 0, w: 1, h: 0.1, label: "Grid crop" },
      { x: 0, y: 0.9, w: 1, h: 0.1, label: "Grid crop" },
    ],
  },
];

export function getGuidePlatform(id: string | null): GuidePlatform | null {
  if (!id) return null;
  return GUIDE_PLATFORMS.find((platform) => platform.id === id) ?? null;
}
