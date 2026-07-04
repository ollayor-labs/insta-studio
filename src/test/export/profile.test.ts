import { describe, expect, it } from "vitest";
import {
  buildExportReceipt,
  EXPORT_PROFILES,
  getExportProfile,
  resolveTargetDimensions,
} from "@/lib/export";

describe("export profile / EXPORT_PROFILES", () => {
  it("exposes the documented set of profiles", () => {
    const ids = EXPORT_PROFILES.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "custom",
        "instagram-feed",
        "instagram-square",
        "instagram-story",
        "x-feed",
      ]),
    );
  });

  it("treats 'custom' as the no-constraint default", () => {
    const custom = getExportProfile("custom");
    expect(custom.maxLongestEdge).toBeNull();
    expect(formatFor(custom)).toContain("jpeg");
  });

  it("falls back to 'custom' for an unknown id", () => {
    const profile = getExportProfile("nope" as never);
    expect(profile.id).toBe("custom");
  });
});

describe("export profile / resolveTargetDimensions", () => {
  it("passes through the source dimensions for 'custom'", () => {
    const result = resolveTargetDimensions(2400, 1600, getExportProfile("custom"));
    expect(result.width).toBe(2400);
    expect(result.height).toBe(1600);
    expect(result.longestEdge).toBe(2400);
  });

  it("caps the longer edge at the profile's max for instagram-feed", () => {
    const result = resolveTargetDimensions(2400, 3000, getExportProfile("instagram-feed"));
    expect(result.longestEdge).toBeLessThanOrEqual(1350);
  });

  it("preserves the source aspect ratio when capping", () => {
    const result = resolveTargetDimensions(4000, 3000, getExportProfile("instagram-feed"));
    // 4000 / 3000 = 4/3, so capping width to 1350 -> height = 1350 / (4/3) = 1012.5 -> 1013
    expect(result.width).toBe(1350);
    expect(result.height).toBe(1013);
  });

  it("does not upscale small images", () => {
    const result = resolveTargetDimensions(800, 600, getExportProfile("instagram-feed"));
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });
});

describe("export profile / buildExportReceipt", () => {
  it("includes the profile label and the actual dimensions", () => {
    const profile = getExportProfile("instagram-feed");
    const receipt = buildExportReceipt({
      profile,
      actualWidth: 1350,
      actualHeight: 1013,
      watermark: false,
    });
    expect(receipt).toContain("Instagram Feed");
    expect(receipt).toContain("1350");
    expect(receipt).toContain("1013");
  });

  it("flags sRGB and sharpening when the profile enables them", () => {
    const profile = getExportProfile("instagram-feed");
    const receipt = buildExportReceipt({
      profile,
      actualWidth: 1350,
      actualHeight: 1620,
      watermark: false,
    });
    expect(receipt).toContain("sRGB");
    expect(receipt).toContain("Sharpened");
  });

  it("does not mention sRGB for the custom profile", () => {
    const profile = getExportProfile("custom");
    const receipt = buildExportReceipt({
      profile,
      actualWidth: 2400,
      actualHeight: 1600,
      watermark: false,
    });
    expect(receipt).not.toContain("sRGB");
  });

  it("includes watermark when requested and eligible", () => {
    const profile = getExportProfile("instagram-feed");
    const receipt = buildExportReceipt({
      profile,
      actualWidth: 1350,
      actualHeight: 1620,
      watermark: true,
    });
    expect(receipt).toContain("Watermarked");
  });
});

function formatFor(profile: { format: "jpeg" | "png" | "webp" }): string {
  return profile.format;
}
