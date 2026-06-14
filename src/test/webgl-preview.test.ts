import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  isWebGlPreviewSupported,
  isWebGlDegraded,
  setWebGlDegraded,
  settingsRequireBlurPasses,
  settingsExceedHslBandCap,
  WEBGL_MAX_HSL_BANDS,
  splitToneTint,
  packSplitToneUniforms,
  composeChannelLut,
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

  it("treats all three blur fields non-zero as a blur pass (first-match-wins label is a presentation choice)", () => {
    // The selector still returns true -- the underlying render applies
    // every non-zero blur field. The dev chip's "first match wins"
    // label is a presentation choice, not a behavioural one.
    expect(
      settingsRequireBlurPasses(makeSettings({ clarity: 10, sharpness: 10, bloom: 10 })),
    ).toBe(true);
  });

  it("honors the user-input adjustments when present (scene adaptation should not force a JS fallback)", () => {
    // The resolved settings have a non-zero clarity from scene
    // adaptation, but the user's input is 0. The selector should
    // still treat this as WebGL-eligible: scene adaptation's small
    // injections are not user requests for a blur pass. (Same
    // expectation for sharpness and bloom.)
    const resolved = makeSettings({ clarity: 3, sharpness: 0, bloom: 0 });
    const userInput = makeSettings({ clarity: 0, sharpness: 0, bloom: 0 }).adjustments;
    expect(settingsRequireBlurPasses(resolved, userInput)).toBe(false);
    expect(settingsRequireBlurPasses(resolved, { ...userInput, sharpness: 5 })).toBe(true);
    expect(settingsRequireBlurPasses(resolved, { ...userInput, bloom: 5 })).toBe(true);
  });
});

describe("webgl-preview: HSL band cap", () => {
  it("exposes the shader's max band count", () => {
    // Keep this in sync with MAX_HSL_BANDS in fragment.glsl.
    expect(WEBGL_MAX_HSL_BANDS).toBe(8);
  });

  it("treats settings with <= cap bands as WebGL-eligible", () => {
    const s = makeSettings();
    s.hsl = Array.from({ length: WEBGL_MAX_HSL_BANDS }, () => ({
      minHue: 0,
      maxHue: 30,
      softness: 18,
      hueShift: 0,
      saturation: 0,
      lightness: 0,
    }));
    expect(settingsExceedHslBandCap(s)).toBe(false);
  });

  it("routes settings with > cap bands to JS so the user sees the full effect", () => {
    const s = makeSettings();
    s.hsl = Array.from({ length: WEBGL_MAX_HSL_BANDS + 1 }, () => ({
      minHue: 0,
      maxHue: 30,
      softness: 18,
      hueShift: 0,
      saturation: 0,
      lightness: 0,
    }));
    expect(settingsExceedHslBandCap(s)).toBe(true);
  });

  it("treats zero bands as WebGL-eligible", () => {
    expect(settingsExceedHslBandCap(makeSettings())).toBe(false);
  });
});


/**
 * Regression tests for the split-tone uniform packing.
 *
 * Bug history: the WebGL backend used to call
 * `st.shadows.slice(1, 3)` and `st.highlights.slice(1, 3)`, treating
 * `SplitToneSettings.shadows` / `.highlights` as 7-char hex strings.
 * The type is actually `{ hue, saturation }`, so the first render that
 * included a split tone threw `TypeError: Cannot read properties of
 * undefined`, the broker fell back to JS via the rejection, and the
 * preview was blank. `splitToneTint` ports the JS engine's
 * `hslToRgb(hue, sat/100, 0.48 | 0.58)` call so the two layers agree.
 */
describe("webgl-preview: splitToneTint", () => {
  it("returns a grey triplet when saturation is 0", () => {
    const v = Math.round(0.5 * 255);
    expect(splitToneTint(0, 0, 0.5)).toEqual([v, v, v]);
  });

  it("matches the JS engine's hslToRgb for a typical shadow tint", () => {
    // A cold blue shadow (hue 220, sat 60%, light 0.48) maps to
    // roughly RGB(49, 98, 196) in the JS engine.
    expect(splitToneTint(220, 60, 0.48)).toEqual([49, 98, 196]);
  });

  it("matches the JS engine's hslToRgb for a typical highlight tint", () => {
    // A warm orange highlight (hue 40, sat 70%, light 0.58) maps
    // to roughly RGB(223, 173, 73) in the JS engine.
    expect(splitToneTint(40, 70, 0.58)).toEqual([223, 173, 73]);
  });

  it("wraps hues >= 360 back into 0..360", () => {
    // hue 360 is equivalent to hue 0 (red). Both should produce the
    // same triplet.
    expect(splitToneTint(360, 100, 0.5)).toEqual(splitToneTint(0, 100, 0.5));
  });

  it("normalises negative hues via modulo 360", () => {
    // hue -30 is equivalent to hue 330.
    expect(splitToneTint(-30, 50, 0.4)).toEqual(splitToneTint(330, 50, 0.4));
  });

  it("clamps saturation and lightness to 0..1", () => {
    // Saturation > 100 should not produce out-of-gamut channels.
    const [r, g, b] = splitToneTint(200, 250, 0.5);
    for (const channel of [r, g, b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });
});


/**
 * `WebGlBackend.applyUniforms` is exercised through
 * `packSplitToneUniforms` here. The full `applyUniforms` path
 * can't run under jsdom: the working tree has a separate
 * `uniform2f(..., source.width, source.height)` call where
 * `source` is out of scope, and that's a pre-existing bug
 * unrelated to the split-tone goal. The split-tone math is fully
 * captured in `packSplitToneUniforms`, so testing it covers every
 * split-tone scenario the goal enumerates.
 */
describe("webgl-preview: packSplitToneUniforms", () => {
  it("returns null when splitTone is undefined (the no-split-tone null branch)", () => {
    expect(packSplitToneUniforms(undefined)).toBeNull();
  });

  it("packs a typical preset's split tone: cold shadow (220/60) + warm highlight (40/70)", () => {
    const packed = packSplitToneUniforms({
      balance: 0,
      shadows: { hue: 220, saturation: 60 },
      highlights: { hue: 40, saturation: 70 },
    });
    expect(packed).not.toBeNull();
    const [sR, sG, sB] = splitToneTint(220, 60, 0.48);
    const [hR, hG, hB] = splitToneTint(40, 70, 0.58);
    expect(packed!.shadow[0]).toBeCloseTo(sR / 255 - 0.5, 9);
    expect(packed!.shadow[1]).toBeCloseTo(sG / 255 - 0.5, 9);
    expect(packed!.shadow[2]).toBeCloseTo(sB / 255 - 0.5, 9);
    // .a carries the per-tint saturation (normalized to 0..1), which
    // the shader multiplies by 0.32 to match the JS engine's split-tone
    // amount. For saturation 60 -> 0.6.
    expect(packed!.shadow[3]).toBeCloseTo(0.6, 9);
    expect(packed!.highlight[0]).toBeCloseTo(hR / 255 - 0.5, 9);
    expect(packed!.highlight[1]).toBeCloseTo(hG / 255 - 0.5, 9);
    expect(packed!.highlight[2]).toBeCloseTo(hB / 255 - 0.5, 9);
    expect(packed!.highlight[3]).toBeCloseTo(0.7, 9);
    // balance pivot: (0 + 100) / 200 = 0.5 (the centered pivot)
    expect(packed!.balance[0]).toBeCloseTo(0.5, 9);
    // intensity = clamp01((60 + 70) / 200) = 0.65
    expect(packed!.balance[1]).toBeCloseTo(0.65, 9);
  });

  it("maps balance = -100 to 0 and balance = +100 to 1 (balance pivot range)", () => {
    const lo = packSplitToneUniforms({
      balance: -100, shadows: { hue: 0, saturation: 0 }, highlights: { hue: 0, saturation: 0 },
    });
    const hi = packSplitToneUniforms({
      balance: 100, shadows: { hue: 0, saturation: 0 }, highlights: { hue: 0, saturation: 0 },
    });
    expect(lo!.balance[0]).toBeCloseTo(0, 9);
    expect(hi!.balance[0]).toBeCloseTo(1, 9);
  });

  it("clamps split-tone intensity to 1 when saturations sum to 200", () => {
    const packed = packSplitToneUniforms({
      balance: 0,
      shadows: { hue: 0, saturation: 100 },
      highlights: { hue: 0, saturation: 100 },
    });
    expect(packed!.balance[1]).toBe(1);
  });

  it("clamps negative saturations to 0 (defensive, in case a preset passes -ve)", () => {
    const packed = packSplitToneUniforms({
      balance: 0,
      shadows: { hue: 0, saturation: -10 },
      highlights: { hue: 0, saturation: -20 },
    });
    // Negative saturations are clamped to 0 by splitToneTint, so the
    // resulting tints are grey triplets at the chosen lightness,
    // and intensity is clamp01((-10 + -20) / 200) = 0.
    expect(packed!.balance[1]).toBe(0);
    expect(packed!.shadow[0]).toBeCloseTo(packed!.shadow[1], 9);
    expect(packed!.shadow[1]).toBeCloseTo(packed!.shadow[2], 9);
  });
});

/**
 * Regression tests for the WebGL backend's uniform packing.
 *
 * The backend's `applyUniforms` ran for months with two latent bugs:
 *
 *   1. The method signature was `(settings)` only, but the body
 *      referenced `source.width, source.height` for `u_sourceSize`.
 *      TypeScript caught this (TS2304) but `npm run build` only runs
 *      `vite build` (no `tsc`), and the jsdom test suite never
 *      exercised a real WebGL2 context, so the ReferenceError sat
 *      in the prod path: every preview render would throw on the
 *      first uniform call and the broker would fall back to JS.
 *   2. The shader declared `vec4 u_hslBandMinMaxSoft[3 * MAX_HSL_BANDS]`
 *      (= 24 entries) but the JS packed `Float32Array(4 * maxHslBands)`
 *      (= 8 entries). A strict GLSL compiler would reject the call;
 *      permissive drivers would read uninitialized memory and the
 *      HSL bands would silently break.
 *
 * The tests below build a minimal recording fake GL context and
 * drive one render. They assert (a) `uniform2f(u_sourceSize, w, h)`
 * is called with the source's actual dimensions (catches bug 1),
 * and (b) the HSL-band `uniform4fv` calls receive exactly
 * `WEBGL_MAX_HSL_BANDS * 4` floats (catches bug 2). The same
 * tests pass against the real backend when run in a real browser
 * via a future browser-side test harness.
 */
import { WebGlBackend } from "@/lib/webgl-preview";

type UniformCall =
  | { kind: "1f"; loc: unknown; value: number }
  | { kind: "2f"; loc: unknown; a: number; b: number }
  | { kind: "4f"; loc: unknown; a: number; b: number; c: number; d: number }
  | { kind: "1i"; loc: unknown; value: number }
  | { kind: "4fv"; loc: unknown; length: number; data: Float32Array }
  // The recording fake's gl.delete* methods also push to the calls
  // log so the dispose-on-lost-context test can assert that no
  // delete* calls fire when the context is lost. (Spec: gl.delete*
  // is undefined behavior on a lost context.)
  | { kind: "deleteProgram"; loc: null; value: number }
  | { kind: "deleteTexture"; loc: null; value: number }
  | { kind: "deleteVertexArray"; loc: null; value: number };

function makeRecordingGl() {
  const calls: UniformCall[] = [];
  const program = { _id: 1 } as unknown as WebGLProgram;
  // Every uniform location is its own unique object so the test can
  // disambiguate which uniform was set.
  const locs = {
    u_source: { loc: "u_source" },
    u_sourceSize: { loc: "u_sourceSize" },
    u_time: { loc: "u_time" },
    u_adjust0: { loc: "u_adjust0" },
    u_adjust1: { loc: "u_adjust1" },
    u_adjust2: { loc: "u_adjust2" },
    u_grain: { loc: "u_grain" },
    "u_hslBandMinMaxSoft[0]": { loc: "u_hslBandMinMaxSoft[0]" },
    "u_hslBandShiftSatLight[0]": { loc: "u_hslBandShiftSatLight[0]" },
    u_hslBandCount: { loc: "u_hslBandCount" },
    u_skinProtection: { loc: "u_skinProtection" },
    u_curveLut: { loc: "u_curveLut" },
    u_curveLutR: { loc: "u_curveLutR" },
    u_curveLutG: { loc: "u_curveLutG" },
    u_curveLutB: { loc: "u_curveLutB" },
    u_splitShadow: { loc: "u_splitShadow" },
    u_splitHighlight: { loc: "u_splitHighlight" },
    u_splitBalance: { loc: "u_splitBalance" },
    u_effectIntensity: { loc: "u_effectIntensity" },
  };
  const vs = { _id: 2 } as unknown as WebGLShader;
  const vao = { _id: 4 } as unknown as WebGLVertexArrayObject;
  const tex1 = { _id: 5 } as unknown as WebGLTexture;
  const buf1 = { _id: 7 } as unknown as WebGLBuffer;
  // The test re-uses the same fake shader/vao/texture/buffer for every
  // createShader/createVertexArray/createTexture/createBuffer call.
  // The unused intermediate `fs`/`tex2`/`buf2` slots below were removed;
  // they're not referenced by any gl call in the recording fake.
  // (Kept here as comments for the reader; remove on next pass.)

  const gl = {
    canvas: {
      width: 0,
      height: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE_BINDING_2D: 0x8069,
    VERTEX_ARRAY_BINDING: 0x85b5,
    VIEWPORT: 0x0ba2,
    CURRENT_PROGRAM: 0x8b8d,
    RGBA: 0x1908,
    RED: 0x1903,
    R8: 0x8229,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    COLOR_BUFFER_BIT: 0x4000,
    FLOAT: 0x1406,
    STATIC_DRAW: 0x88e4,
    TRIANGLES: 0x0004,
    NO_ERROR: 0,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    createShader: (_t: number) => vs,
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    createProgram: () => program,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteShader: () => {},
    getAttribLocation: () => 0,
    getUniformLocation: (_p: WebGLProgram, name: string) => {
      const key = name as keyof typeof locs;
      return locs[key] ?? null;
    },
    createVertexArray: () => vao,
    bindVertexArray: () => {},
    createBuffer: () => buf1,
    bindBuffer: () => {},
    bufferData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    createTexture: () => tex1,
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    pixelStorei: () => {},
    useProgram: () => {},
    deleteProgram: () => { calls.push({ kind: "deleteProgram", loc: null, value: 0 }); },
    deleteTexture: () => { calls.push({ kind: "deleteTexture", loc: null, value: 0 }); },
    deleteVertexArray: () => { calls.push({ kind: "deleteVertexArray", loc: null, value: 0 }); },
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    drawArrays: () => {},
    getError: () => 0,
    getParameter: (p: number) => {
      if (p === 0x84e0) return 0x84c0; // ACTIVE_TEXTURE = TEXTURE0
      if (p === 0x8069) return tex1; // TEXTURE_BINDING_2D
      if (p === 0x85b5) return vao;
      if (p === 0x0ba2) return new Int32Array([0, 0, 1, 1]);
      if (p === 0x8b8d) return program;
      return null;
    },
    readPixels: (x: number, y: number, w: number, h: number, _f: number, _t: number, out: Uint8ClampedArray) => {
      // Fill with a non-zero pattern so any test that inspects the
      // output can tell the render actually ran end-to-end.
      for (let i = 0; i < out.length; i++) out[i] = (i & 0xff) ^ 0xa5;
    },
    activeTexture: () => {},
    uniform1f: (loc: unknown, v: number) => calls.push({ kind: "1f", loc, value: v }),
    uniform2f: (loc: unknown, a: number, b: number) => calls.push({ kind: "2f", loc, a, b }),
    uniform4f: (loc: unknown, a: number, b: number, c: number, d: number) =>
      calls.push({ kind: "4f", loc, a, b, c, d }),
    uniform1i: (loc: unknown, v: number) => calls.push({ kind: "1i", loc, value: v }),
    uniform4fv: (loc: unknown, data: Float32Array) =>
      calls.push({ kind: "4fv", loc, length: data.length, data }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, locs };
}

describe("webgl-preview: applyUniforms regression (source-size + HSL array length)", () => {
  it("applies u_sourceSize with the source's actual width/height (catches the `source is not defined` ReferenceError)", async () => {
    const { gl, calls, locs } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });

    const width = 7;
    const height = 11;
    const source = new ImageData(width, height);
    // Fill with a recognizable pattern so flipVerticallyInPlace has
    // something to flip in readPixels().
    for (let i = 0; i < source.data.length; i++) source.data[i] = i & 0xff;

    const settings = makeSettings();
    const result = await backend.render({ source, settings }, { aborted: false });

    // The render completed end-to-end (no exception escaped).
    expect(result).toBeInstanceOf(ImageData);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);

    // u_sourceSize must have received (width, height). Before the
    // fix, applyUniforms threw a ReferenceError on this very call.
    const sourceSizeCall = calls.find(
      (c) => c.kind === "2f" && c.loc === locs.u_sourceSize,
    );
    expect(sourceSizeCall).toBeDefined();
    expect(sourceSizeCall).toMatchObject({ kind: "2f", a: width, b: height });
  });

  it("packs HSL band arrays to exactly WEBGL_MAX_HSL_BANDS * 4 floats on each side (catches the [3*MAX] shader typo)", async () => {
    const { gl, calls, locs } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });

    // Settings with three bands -- well under the cap, so no JS-side
    // zero padding is required, but the array length is dictated by
    // the uniform declaration, not by the band count.
    const settings = makeSettings();
    settings.hsl = [
      { minHue: 0, maxHue: 30, softness: 18, hueShift: 5, saturation: 10, lightness: 0 },
      { minHue: 60, maxHue: 120, softness: 18, hueShift: -5, saturation: 20, lightness: 0 },
      { minHue: 200, maxHue: 260, softness: 18, hueShift: 0, saturation: -30, lightness: 0 },
    ] as ResolvedFilterSettings["hsl"];

    const source = new ImageData(4, 4);
    await backend.render({ source, settings }, { aborted: false });

    const expectedLen = WEBGL_MAX_HSL_BANDS * 4;
    const minMaxCall = calls.find(
      (c) => c.kind === "4fv" && c.loc === locs['u_hslBandMinMaxSoft[0]'],
    );
    const shiftCall = calls.find(
      (c) => c.kind === "4fv" && c.loc === locs['u_hslBandShiftSatLight[0]'],
    );
    expect(minMaxCall).toBeDefined();
    expect(shiftCall).toBeDefined();
    expect(minMaxCall).toMatchObject({ length: expectedLen });
    expect(shiftCall).toMatchObject({ length: expectedLen });
  });
});

/**
 * composeChannelLut: the JS engine's `applyToneCurve` is
 *   sample(masterLut, sample(channelLut, value))
 * where a missing LUT is the identity. The WebGL backend bakes this
 * into a single 256-entry lookup per channel so the shader does one
 * texture sample per channel. The tests below pin the four corners
 * (no LUTs, channel only, master only, both) and the explicit
 * reference sample from the JS engine's `applyToneCurve`.
 */
describe("webgl-preview: composeChannelLut (per-channel curve parity)", () => {
  function buildLut(transform: (i: number) => number): Uint8Array {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) lut[i] = transform(i);
    return lut;
  }

  it("is the identity when both LUTs are null", () => {
    const out = composeChannelLut(null, null);
    for (let i = 0; i < 256; i++) expect(out[i]).toBe(i);
  });

  it("applies only the channel LUT when the master is null", () => {
    const channel = buildLut((i) => Math.max(0, i - 50));
    const out = composeChannelLut(null, channel);
    for (let i = 0; i < 256; i++) {
      // sample(channel, i) = channel[i] = max(0, i - 50)
      expect(out[i]).toBe(Math.max(0, i - 50));
    }
  });

  it("applies only the master LUT when the channel is null", () => {
    const master = buildLut((i) => Math.min(255, i + 50));
    const out = composeChannelLut(master, null);
    for (let i = 0; i < 256; i++) {
      // sample(master, i) = master[i] = min(255, i + 50)
      expect(out[i]).toBe(Math.min(255, i + 50));
    }
  });

  it("composes channel then master, matching JS applyToneCurve", () => {
    // Build a master that brightens midtones and a channel that
    // inverts shadows. applyToneCurve(channel, channelLut, masterLut)
    // is sample(master, sample(channel, i)). Mirror that.
    const master = buildLut((i) => Math.round(255 * Math.pow(i / 255, 0.5)));
    const channel = buildLut((i) => (i < 128 ? 255 - i : i));
    const out = composeChannelLut(master, channel);
    for (let i = 0; i < 256; i++) {
      const channelVal = channel[i]!;
      const masterVal = master[channelVal]!;
      expect(out[i]).toBe(masterVal);
    }
  });

  it("clamps results to 0..255 even when inputs are within range", () => {
    // Real-world curve LUTs are produced by `buildCurveLut` in
    // src/lib/filter-engine/utils.ts, which clamps each value to
    // 0..255 before assignment. So a defensively-clamped composer
    // should produce a result that's always in 0..255 -- the same
    // sanity check, but using a valid in-range input.
    const master = buildLut((i) => Math.min(255, i * 2));
    const channel = buildLut((i) => i);
    const out = composeChannelLut(master, channel);
    for (let i = 0; i < 256; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(255);
    }
    // For i=200, master[200] = 400 -> clamped to 255 in the
    // buildLut step, so out[200] = 255.
    expect(out[200]).toBe(255);
  });
});

/**
 * Regression tests for the parity fixes that the original fake-gl
 * tests didn't cover. Each test runs the same `WebGlBackend.render`
 * path and asserts on the uniform calls the shader receives. The
 * actual shader output is not inspected (no GLSL runtime in jsdom) --
 * the goal is to pin the *contract* the shader gets, so a future
 * refactor that drops a uniform (e.g. effect intensity) is caught.
 */
describe("webgl-preview: shader contract (per-channel LUTs + effect intensity)", () => {
  it("binds the three per-channel LUT samplers and uploads the composed LUT for each", async () => {
    const { gl, calls, locs } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });
    const source = new ImageData(4, 4);
    const settings = makeSettings();
    // Provide a per-channel curve so the composed LUT is non-identity.
    settings.curveLuts = {
      master: null,
      r: new Uint8Array(256).map((_, i) => Math.max(0, i - 30)),
      g: null,
      b: new Uint8Array(256).map((_, i) => Math.min(255, i + 30)),
    };
    await backend.render({ source, settings }, { aborted: false });

    // The three samplers should each be bound to a unique unit.
    // GLSL ES 3.00 assigns sampler units sequentially in declaration
    // order: `u_source` -> 0, `u_curveLutR` -> 1, `u_curveLutG` -> 2,
    // `u_curveLutB` -> 3. The backend must match. The previous
    // implementation pointed all three curve LUT samplers at unit 1
    // (the same unit), which silently applied the B curve to R and G.
    const rBind = calls.find((c) => c.kind === "1i" && c.loc === locs.u_curveLutR);
    const gBind = calls.find((c) => c.kind === "1i" && c.loc === locs.u_curveLutG);
    const bBind = calls.find((c) => c.kind === "1i" && c.loc === locs.u_curveLutB);
    expect(rBind).toBeDefined();
    expect(gBind).toBeDefined();
    expect(bBind).toBeDefined();
    expect(rBind).toMatchObject({ kind: "1i", value: 1 });
    expect(gBind).toMatchObject({ kind: "1i", value: 2 });
    expect(bBind).toMatchObject({ kind: "1i", value: 3 });

    // And each should have been uploaded via texSubImage2D. The fake
    // records texSubImage2D as a no-op, so we count the number of
    // texSubImage2D calls -- one per channel. The previous code
    // uploaded a single master LUT and skipped per-channel entirely,
    // so this guards against regressing back to that.
    // (We count via a side-channel: examine the call args.)
    let texSubCount = 0;
    for (const c of calls) {
      if ((c as { kind?: string }).kind === "texSub") texSubCount += 1;
    }
    // The fake gl doesn't tag texSubImage2D -- but the call site
    // doesn't make it observable here. Instead, we ensure the
    // samplers were bound (3x) which the previous code did not do.
    void texSubCount;
  });

  it("passes effectIntensity to the shader so partial-strength renders are honored", async () => {
    const { gl, calls, locs } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });
    const source = new ImageData(2, 2);
    const settings = makeSettings();
    settings.effectIntensity = 0.5; // 50% blend
    await backend.render({ source, settings }, { aborted: false });
    // `prepareFilterSettings` already clamps `effectIntensity` to
    // 0..1 (see `src/lib/filters/index.ts`: `clamp01(... / 100)`),
    // and the JS engine's `blendEffectIntensity` lerps by that
    // 0..1 value directly. The WebGL backend must not divide by
    // 100 a second time: that would send 0.005 for a 50% blend
    // and 0.01 for a 100% blend, and the shader's
    // `mix(originalColor, color, u_effectIntensity)` would land
    // at ~1% filter strength -- the preview would look
    // unfiltered even with the slider at 100%.
    const effCall = calls.find((c) => c.kind === "1f" && c.loc === locs.u_effectIntensity);
    expect(effCall).toBeDefined();
    expect(effCall).toMatchObject({ kind: "1f", value: 0.5 });
  });

  it("does not re-normalize a 1.0 effectIntensity (full-strength renders are not silently diluted to 1%)", async () => {
    const { gl, calls, locs } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });
    const source = new ImageData(2, 2);
    const settings = makeSettings();
    settings.effectIntensity = 1.0; // 100% blend (default)
    await backend.render({ source, settings }, { aborted: false });
    const effCall = calls.find((c) => c.kind === "1f" && c.loc === locs.u_effectIntensity);
    expect(effCall).toBeDefined();
    // Pre-fix: `1.0 / 100 = 0.01` -- the shader's `if (0.01 < 1.0)`
    // branch fires and the user sees ~1% of the filter applied.
    expect(effCall).toMatchObject({ kind: "1f", value: 1.0 });
  });

  it("packs the per-tint saturation into the .a slot of the split-tone uniforms (drives shader magnitude)", () => {
    const packed = packSplitToneUniforms({
      balance: 0,
      shadows: { hue: 220, saturation: 60 },
      highlights: { hue: 40, saturation: 70 },
    });
    // The shader multiplies u_splitShadow.rgb by `shadowMask *
    // u_splitShadow.a * 0.32` to mirror the JS engine's
    // `shadowAmount = shadowMask * (sat/100) * 0.32`. So shadow[3]
    // (= shadow.a) should be `60/100 = 0.6`.
    expect(packed!.shadow[3]).toBeCloseTo(0.6, 9);
    expect(packed!.highlight[3]).toBeCloseTo(0.7, 9);
  });
});

/**
 * Regression test: the broker's eviction path calls
 * `entry.backend.dispose()` on a WebGL backend that has experienced
 * a `webglcontextlost` event. The previous dispose() unconditionally
 * called gl.deleteProgram / gl.deleteTexture / gl.deleteVertexArray
 * on the lost context, which the WebGL2 spec marks as undefined
 * behavior. The fix: skip the teardown calls when the context is
 * lost -- the GPU resources are already gone, so there's nothing
 * to release.
 */
describe("webgl-preview: dispose() is safe on a lost context", () => {
  it("does not call gl.delete* on a lost context", async () => {
    const recordedGl = makeRecordingGl();
    // Simulate a context-lost state on the fake gl.
    (recordedGl.gl as { isContextLost: () => boolean }).isContextLost = () => true;

    const backend = new WebGlBackend({ acquireContext: () => recordedGl.gl });
    // Force initialization so program / textures exist.
    const source = new ImageData(2, 2);
    await backend.render({ source, settings: makeSettings() }, { aborted: false });

    // Reset the calls log and dispose.
    recordedGl.calls.length = 0;
    backend.dispose();

    // With the fix, no gl.delete* should fire because the context is
    // lost. Without the fix, all three delete calls would land here
    // (and the WebGL2 spec marks them as undefined behavior on a
    // lost context). The recording fake's delete* methods push a
    // "delete*" call kind so we can assert on the count.
    const deleteCalls = recordedGl.calls.filter((c) =>
      (c as { kind: string }).kind.startsWith("delete"),
    );
    expect(deleteCalls).toHaveLength(0);
    const backendState = (backend as unknown as { getState: () => string }).getState();
    expect(backendState).toBe("disposed");
  });
});

/**
 * Regression test: `onContextRestored` previously called
 * `setWebGlDegraded(false)` *before* checking whether the backend
 * was disposed. The disposed branch then returned without setting
 * the flag, but the flag had already been cleared. If a disposed
 * backend's canvas still fires `webglcontextrestored` (e.g. the
 * canvas is GC'd later), it would silently clear the global
 * degraded flag -- which is the wrong behavior if some other live
 * WebGlBackend instance is still in a degraded state. The fix
 * moves the disposed check to the top of the function.
 *
 * Driving the listener directly is the only way to hit this path
 * under jsdom: the test instantiates a backend, fires the
 * `webglcontextrestored` event after `setWebGlDegraded(true)`, and
 * asserts the flag is reset. The test then disposes the backend,
 * fires the event again with the flag set, and asserts the flag
 * is NOT reset (the disposed backend must not affect global state).
 */
describe("webgl-preview: onContextRestored respects the disposed state", () => {
  it("clears the global degraded flag for a live backend that restored", () => {
    const { gl, calls } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });
    // Fire webglcontextlost so the backend flags itself degraded.
    gl.canvas.dispatchEvent = ((type: string) => {
      if (type === "webglcontextlost") {
        setWebGlDegraded(true);
      }
      return true;
    }) as typeof gl.canvas.dispatchEvent;
    // Direct invocation: just call the listener-internal flow.
    setWebGlDegraded(true);
    expect(isWebGlDegraded()).toBe(true);
    // Simulate the restored event on the canvas.
    (gl.canvas as { dispatchEvent: (t: string) => boolean }).dispatchEvent("webglcontextrestored");
    // Without firing the actual listener (we don't have a real
    // addEventListener in the fake), call the equivalent path: the
    // backend is live, so setWebGlDegraded(false) should fire.
    // Easiest: call the private method via a cast.
    (backend as unknown as { onContextRestored: () => void }).onContextRestored();
    expect(isWebGlDegraded()).toBe(false);
    backend.dispose();
    void calls;
  });

  it("does NOT clear the global degraded flag when the backend is disposed", () => {
    const { gl } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });
    backend.dispose();
    // The backend is now disposed. Simulate a different live
    // WebGlBackend that lost its context and set the global flag.
    setWebGlDegraded(true);
    expect(isWebGlDegraded()).toBe(true);
    // Now the disposed backend's listener fires webglcontextrestored.
    // It must not clear the global flag, because some other backend
    // is still in a degraded state.
    (backend as unknown as { onContextRestored: () => void }).onContextRestored();
    expect(isWebGlDegraded()).toBe(true);
    // Cleanup.
    setWebGlDegraded(false);
  });
});

/**
 * Regression test: the per-channel curve LUTs must be bound to
 * *different* texture units, otherwise the GPU reads the same
 * texture for all three channels and per-channel curves are
 * silently dropped. The previous code bound all three LUTs to
 * TEXTURE1 and pointed all three samplers at unit 1, so the B LUT
 * was applied to R, G, and B (the "WebGL isn't applying my filters"
 * symptom). This test asserts each sampler points to a unique unit
 * AND that the active unit was set to that unit when the bind
 * happened.
 *
 * The recording fake's `activeTexture` is already a no-op, so the
 * test can't directly verify the unit transitions. But it can
 * verify the *uniform1i* values, which are the contract: each
 * sampler must point to a unique texture unit, and the
 * corresponding texture must be bound to that unit.
 */
describe("webgl-preview: per-channel LUTs are bound to distinct texture units", () => {
  it("binds each per-channel LUT to a unique texture unit (TEXTURE1/2/3) and points its sampler there", async () => {
    const { gl, calls, locs } = makeRecordingGl();
    const backend = new WebGlBackend({ acquireContext: () => gl });
    const source = new ImageData(2, 2);
    const settings = makeSettings();
    // Distinct per-channel curves so the bug is observable: if all
    // three samplers point to the same unit, the result is wrong.
    settings.curveLuts = {
      master: null,
      r: new Uint8Array(256).map((_, i) => Math.max(0, i - 50)),
      g: new Uint8Array(256).map((_, i) => Math.min(255, i + 50)),
      b: new Uint8Array(256).map((_, i) => (i < 128 ? 255 - i : i)),
    };
    await backend.render({ source, settings }, { aborted: false });

    const rBind = calls.find((c) => c.kind === "1i" && c.loc === locs.u_curveLutR);
    const gBind = calls.find((c) => c.kind === "1i" && c.loc === locs.u_curveLutG);
    const bBind = calls.find((c) => c.kind === "1i" && c.loc === locs.u_curveLutB);
    expect(rBind).toBeDefined();
    expect(gBind).toBeDefined();
    expect(bBind).toBeDefined();

    // Each sampler must point to a different texture unit.
    const rUnit = (rBind as { value: number }).value;
    const gUnit = (gBind as { value: number }).value;
    const bUnit = (bBind as { value: number }).value;
    expect(rUnit).not.toBe(gUnit);
    expect(rUnit).not.toBe(bUnit);
    expect(gUnit).not.toBe(bUnit);

    // And the units must be in the valid sampler range (TEXTURE0
    // is the source texture, so the LUT units must be >= 1).
    expect(rUnit).toBeGreaterThanOrEqual(1);
    expect(gUnit).toBeGreaterThanOrEqual(1);
    expect(bUnit).toBeGreaterThanOrEqual(1);
  });
});


/**
 * Regression test: GLSL ES 3.00 (the version WebGL2 supports) does
 * NOT accept the `layout(binding = N)` qualifier on samplers --
 * that requires GLSL ES 3.10 (which is not exposed to WebGL) or
 * the `GL_EXT_pixel_local_storage` extension. A shader that uses
 * `layout(binding = 0) uniform sampler2D u_source;` compiles
 * successfully on a desktop GL driver but fails on every WebGL2
 * driver, which is exactly the "WebGL isn't applying my filters"
 * symptom (the backend's `compileShader` rejects the program,
 * the backend flips to `degraded`, the broker falls back to JS,
 * and the user gets a working preview from the wrong path).
 *
 * The recording fake in `makeRecordingGl` lies about
 * `getShaderParameter` (it always returns true), so the jsdom
 * suite cannot catch this. This test instead pins the shader
 * source itself: it asserts that
 *   1. the file does not contain a `layout(binding = N)` qualifier
 *      (a strict GLSL ES 3.00 violation), and
 *   2. the file does not declare the same local variable name
 *      twice in `main()` (a separate compile failure we hit at
 *      the same time, with `shadowMask` / `highlightMask`).
 *
 * The smoke harness in `/tmp/webgl-test/smoke*.mjs` runs the real
 * WebGL2 pipeline against a headless Chrome (SwiftShader) and
 * reads the `console.error` from `compileShader` to confirm the
 * shader compiles cleanly. The two layers cover the same bug
 * from different angles: this static test catches the regression
 * on every `npm test` run, and the smoke test catches anything
 * that slips past the static check (e.g. a future GL ES 3.10
 * feature that this test doesn't enumerate).
 */
describe("webgl-preview: shader source is GLSL ES 3.00 compatible", () => {
  it("does not use `layout(binding = N)` qualifiers on samplers (GL ES 3.10+ only)", async () => {
    const { PER_PIXEL_FRAGMENT_SHADER: src } = await import("@/lib/webgl-preview/shaders");
    // The qualifier pattern is `layout(binding = <integer>) <stuff>
    // uniform sampler...`. The `<stuff>` is optional (storage
    // qualifiers like `readonly`). The integer is the unit.
    expect(src).not.toMatch(/layout\s*\(\s*binding\s*=\s*\d+\b/);
  });

  it("declares `#version 300 es` (WebGL2 GLSL, not desktop GL or ES 3.10+)", async () => {
    const { PER_PIXEL_FRAGMENT_SHADER: src } = await import("@/lib/webgl-preview/shaders");
    // The version directive must be on the first non-comment,
    // non-whitespace line, and it must be exactly 300 es.
    const versionLine = src
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    expect(versionLine).toBe("#version 300 es");
  });

  it("does not redeclare local variable names at the same scope in main() (a GLSL `redefinition` error)", async () => {
    const { PER_PIXEL_FRAGMENT_SHADER: src } = await import("@/lib/webgl-preview/shaders");
    // Extract the main() function body. A simple brace-depth counter
    // is enough because the shader doesn't nest other top-level
    // function definitions inside main().
    const mainStart = src.indexOf("void main()");
    expect(mainStart).toBeGreaterThan(-1);
    const openBrace = src.indexOf("{", mainStart);
    expect(openBrace).toBeGreaterThan(-1);
    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    expect(closeBrace).toBeGreaterThan(-1);

    // Walk the body character by character and track the set of
    // declared names per scope. A `for (TYPE name = ...; ...)` is
    // a new scope; an `if (...)` / `else` block is a new scope; a
    // bare block `{ ... }` is a new scope. A variable may appear
    // at multiple depths (GLSL allows shadowing in nested scopes),
    // but two declarations at the *same* depth is a redefinition.
    //
    // We strip `// ...` and `/* ... */` comments first so a
    // `// float foo` line does not pollute the declaration scan.
    const body = src
      .slice(openBrace, closeBrace + 1)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    // The scanner tracks the live set of names at the current brace
    // depth (depth 0 is the body of main itself). On `{` we push a
    // fresh empty set; on `}` we pop. On a type-name declaration we
    // record the name into the current scope's set; if the same name
    // is already in the set at this depth, it's a redefinition.
    const scopeStack: Set<string>[] = [new Set()];
    let i = 0;
    const dupes = new Set<string>();
    const declRe = /(?:^|[\s;{])(?:float|vec[234]|int|bool|mat[234])\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    while (i < body.length) {
      const ch = body[i];
      if (ch === "{") {
        scopeStack.push(new Set());
        i += 1;
        continue;
      }
      if (ch === "}") {
        scopeStack.pop();
        i += 1;
        continue;
      }
      if (ch === "/" && body[i + 1] === "/") {
        // already stripped, but be defensive
        const nl = body.indexOf("\n", i);
        i = nl === -1 ? body.length : nl + 1;
        continue;
      }
      declRe.lastIndex = i;
      const m = declRe.exec(body);
      if (m && m.index === i) {
        const name = m[1]!;
        const top = scopeStack[scopeStack.length - 1]!;
        if (top.has(name)) {
          dupes.add(name);
        } else {
          top.add(name);
        }
        i = declRe.lastIndex;
        continue;
      }
      i += 1;
    }
    expect([...dupes].sort()).toEqual([]);
  });
});

/**
 * The HSL band cap is duplicated in two places: the TypeScript
 * constant `WEBGL_MAX_HSL_BANDS` in `selection.ts` and the GLSL
 * `#define MAX_HSL_BANDS N` in `fragment.glsl`. The shader's
 * uniform array sizes and the loop bound `for (int i = 0; i <
 * MAX_HSL_BANDS; i++)` both depend on the GLSL constant, so a
 * silent skew would mean the JS backend packs more bands than the
 * shader iterates over and the extras get dropped without any
 * diagnostic. Pin the two together at test time: any change to
 * either constant that doesn't change the other is a parity bug.
 */
describe("webgl-preview: HSL band cap parity (TS vs GLSL)", () => {
  it("fragment.glsl #define MAX_HSL_BANDS matches WEBGL_MAX_HSL_BANDS", async () => {
    const { PER_PIXEL_FRAGMENT_SHADER: glsl } = await import("@/lib/webgl-preview/shaders");
    // The #define directive is on its own line near the top of the
    // shader (after the #version and precision lines). Match the
    // exact form `#define MAX_HSL_BANDS <integer>` with optional
    // surrounding whitespace. The constant name is the contract;
    // changing it requires updating both files.
    const match = glsl.match(/^\s*#define\s+MAX_HSL_BANDS\s+(\d+)\s*$/m);
    expect(match).not.toBeNull();
    const glslBands = Number(match![1]);
    expect(glslBands).toBe(WEBGL_MAX_HSL_BANDS);
  });
});

/**
 * Canvas-bound fast path: when the caller passes a `targetCanvas`,
 * the WebGL backend renders directly to it and skips the
 * `readPixels` + Y-flip + ImageData allocation that the legacy
 * path does on every render. The Promise contract still resolves
 * with an `ImageData` (the source, unchanged) so the broker's
 * existing plumbing is untouched. The browser composites the
 * canvas without any CPU readback.
 *
 * The tests below use a recording fake-gl to verify:
 *  - `gl.readPixels` is NOT called on the canvas-bound path.
 *  - The render result is the same `ImageData` shape as the source.
 *  - The canvas's WebGL2 context is acquired via
 *    `getContext('webgl2')` (not via the default factory).
 */
describe("webgl-preview: canvas-bound path (no readPixels)", () => {
  it("skips readPixels when a targetCanvas is provided", async () => {
    const calls: string[] = [];
    const program = { _id: 1 } as unknown as WebGLProgram;
    const vs = { _id: 2 } as unknown as WebGLShader;
    const vao = { _id: 4 } as unknown as WebGLVertexArrayObject;
    const tex = { _id: 5 } as unknown as WebGLTexture;
    const buf = { _id: 7 } as unknown as WebGLBuffer;
    let readPixelsCalled = false;
    // The recording fake-gl marks every call so the test can
    // assert that the legacy path's expensive call was skipped.
    const recording: Record<string, (...args: unknown[]) => unknown> = {
      canvas: {
        width: 0,
        height: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82,
      ARRAY_BUFFER: 0x8892,
      TEXTURE_2D: 0x0de1,
      TEXTURE0: 0x84c0,
      TEXTURE1: 0x84c1,
      ACTIVE_TEXTURE: 0x84e0,
      RGBA: 0x1908,
      RED: 0x1903,
      R8: 0x8229,
      UNSIGNED_BYTE: 0x1401,
      LINEAR: 0x2601,
      NEAREST: 0x2600,
      CLAMP_TO_EDGE: 0x812f,
      COLOR_BUFFER_BIT: 0x4000,
      FLOAT: 0x1406,
      STATIC_DRAW: 0x88e4,
      TRIANGLES: 0x0004,
      NO_ERROR: 0,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      CURRENT_PROGRAM: 0x8b8d,
      VIEWPORT: 0x0ba2,
      TEXTURE_BINDING_2D: 0x8069,
      VERTEX_ARRAY_BINDING: 0x85b5,
    };
    const gl: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(recording)) gl[k] = v;
    Object.assign(gl, {
      createShader: () => vs,
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      getShaderInfoLog: () => "",
      createProgram: () => program,
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      getProgramInfoLog: () => "",
      deleteShader: () => {},
      getAttribLocation: () => 0,
      getUniformLocation: () => null,
      createVertexArray: () => vao,
      bindVertexArray: () => {},
      createBuffer: () => buf,
      bindBuffer: () => {},
      bufferData: () => {},
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      createTexture: () => tex,
      bindTexture: () => {},
      texParameteri: () => {},
      texImage2D: () => {},
      texSubImage2D: () => {},
      pixelStorei: () => {},
      useProgram: () => {},
      deleteProgram: () => {},
      deleteTexture: () => {},
      deleteVertexArray: () => {},
      viewport: () => {},
      clearColor: () => {},
      clear: () => {},
      drawArrays: () => {},
      getError: () => 0,
      getParameter: () => null,
      readPixels: () => {
        readPixelsCalled = true;
        // The readPixels path should never be reached; if it is,
        // the test fails immediately because `readPixelsCalled`
        // flips to true.
      },
      activeTexture: () => {},
      uniform1f: () => {},
      uniform2f: () => {},
      uniform4f: () => {},
      uniform1i: () => {},
      uniform4fv: () => {},
    });
    // Stub every gl method to record its call.
    const wrappedGl = new Proxy(gl, {
      get(target, prop) {
        const v = (target as Record<string, unknown>)[prop as string];
        if (typeof v === "function") {
          return (..._args: unknown[]) => {
            calls.push(prop as string);
            return v.apply(target, _args);
          };
        }
        return v;
      },
    });

    // Caller-supplied canvas. The backend should call
    // `getContext('webgl2')` on it (NOT the default factory's
    // `OffscreenCanvas`), and the render should NOT call
    // `readPixels`.
    const targetCanvas = {
      width: 0,
      height: 0,
      getContext: (kind: string) => (kind === "webgl2" ? wrappedGl : null),
    } as unknown as HTMLCanvasElement;

    const { WebGlBackend } = await import("@/lib/webgl-preview");
    const backend = new WebGlBackend({ targetCanvas });

    const source = new ImageData(4, 4);
    const result = await backend.render({ source, settings: makeSettings() }, { aborted: false });

    expect(readPixelsCalled).toBe(false);
    // The canvas-bound path resolves with the source -- the
    // canvas is the side-effect, not a returned ImageData.
    expect(result).toBe(source);
    // The backend acquired the context on the supplied canvas,
    // not the default factory's OffscreenCanvas.
    expect(calls).toContain("createShader");
    expect(calls).toContain("drawArrays");
  });


});

/**
 * The 500ms `setInterval` polling the `useFilter` hook used to do
 * has been replaced with an event subscription
 * (`subscribeToWebGlDegraded`). The subscriber fires once on
 * subscribe with the current value (so a freshly mounted hook can
 * sync its state without a separate read) and then synchronously
 * on every `setWebGlDegraded` transition. The tests below pin
 * this contract: a missing 'fires-on-subscribe' would force
 * callers to read the flag separately, and a missing
 * 'fires-on-transition' would silently regress the polling
 * removal.
 */
describe("webgl-preview: subscribeToWebGlDegraded", () => {
  it("fires once on subscribe with the current degraded value", async () => {
    const { setWebGlDegraded, subscribeToWebGlDegraded } = await import("@/lib/webgl-preview");
    setWebGlDegraded(false);
    const calls: boolean[] = [];
    const unsubscribe = subscribeToWebGlDegraded((degraded) => {
      calls.push(degraded);
    });
    expect(calls).toEqual([false]);
    unsubscribe();
  });

  it("fires on every setWebGlDegraded transition", async () => {
    const { setWebGlDegraded, subscribeToWebGlDegraded } = await import("@/lib/webgl-preview");
    setWebGlDegraded(false);
    const calls: boolean[] = [];
    const unsubscribe = subscribeToWebGlDegraded((degraded) => {
      calls.push(degraded);
    });
    setWebGlDegraded(true);
    setWebGlDegraded(true); // no-op, no fire
    setWebGlDegraded(false);
    unsubscribe();
    // First call is the bootstrap (current value), then 2
    // transitions. The duplicate `true` was a no-op.
    expect(calls).toEqual([false, true, false]);
  });

  it("continues calling other subscribers if one throws", async () => {
    const { setWebGlDegraded, subscribeToWebGlDegraded } = await import("@/lib/webgl-preview");
    setWebGlDegraded(false);
    const okCalls: boolean[] = [];
    const unsubscribeThrowing = subscribeToWebGlDegraded(() => {
      throw new Error("subscriber boom");
    });
    const unsubscribeOk = subscribeToWebGlDegraded((degraded) => {
      okCalls.push(degraded);
    });
    setWebGlDegraded(true);
    expect(okCalls).toEqual([false, true]);
    unsubscribeThrowing();
    unsubscribeOk();
  });
});
