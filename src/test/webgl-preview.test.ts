import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  isWebGlPreviewSupported,
  isWebGlDegraded,
  setWebGlDegraded,
  settingsRequireBlurPasses,
} from "@/lib/webgl-preview";
import type { ResolvedFilterSettings } from "@/lib/filterEngine";

/**
 * Tests for the WebGL preview backend that don't require a real
 * WebGL2 context. The actual shader compile / render path is
 * covered by manual browser smoke tests and by the broker's
 * fallback test (which uses a fake backend).
 */

function makeSettings(adjustments: Partial<ResolvedFilterSettings["adjustments"]> = {}): ResolvedFilterSettings {
  return {
    preset: {
      id: "Test",
      name: "Test",
      category: "Test",
      mood: "test",
      description: "test",
      whyItWorks: "test",
      defaultStrength: 1,
      tags: [],
      adjustments: {},
    },
    strength: 1,
    effectIntensity: 1,
    quality: "preview",
    precision: "uint8",
    analysis: null,
    adjustments: {
      brightness: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      temperature: 0,
      tint: 0,
      saturation: 0,
      vibrance: 0,
      fade: 0,
      vignette: 0,
      grain: 0,
      clarity: 0,
      sharpness: 0,
      bloom: 0,
      ...adjustments,
    } as ResolvedFilterSettings["adjustments"],
    curveLuts: { master: null, r: null, g: null, b: null },
    hsl: [],
  } as ResolvedFilterSettings;
}

describe("webgl-preview: feature detection", () => {
  it("reports WebGL as unavailable in jsdom (no OffscreenCanvas webgl2)", () => {
    // jsdom doesn't implement OffscreenCanvas.getContext("webgl2"),
    // so the default factory returns null.
    expect(isWebGlPreviewSupported()).toBe(false);
  });
});

describe("webgl-preview: degraded flag", () => {
  beforeEach(() => {
    setWebGlDegraded(false);
  });
  afterEach(() => {
    setWebGlDegraded(false);
  });

  it("starts in the not-degraded state", () => {
    expect(isWebGlDegraded()).toBe(false);
  });

  it("reflects set/reset transitions", () => {
    setWebGlDegraded(true);
    expect(isWebGlDegraded()).toBe(true);
    setWebGlDegraded(false);
    expect(isWebGlDegraded()).toBe(false);
  });
});

describe("webgl-preview: blur-pass detection", () => {
  it("treats zero clarity/sharpness/bloom as WebGL-eligible", () => {
    expect(settingsRequireBlurPasses(makeSettings())).toBe(false);
  });

  it("treats non-zero clarity as a blur pass (WebGL falls back to JS)", () => {
    expect(settingsRequireBlurPasses(makeSettings({ clarity: 10 }))).toBe(true);
  });

  it("treats non-zero sharpness as a blur pass", () => {
    expect(settingsRequireBlurPasses(makeSettings({ sharpness: 10 }))).toBe(true);
  });

  it("treats non-zero bloom as a blur pass", () => {
    expect(settingsRequireBlurPasses(makeSettings({ bloom: 10 }))).toBe(true);
  });
});
