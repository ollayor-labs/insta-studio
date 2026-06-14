/**
 * WebGL2 preview backend. Owns a WebGL2 context on either a caller-
 * supplied canvas (the visible `ImageCanvas` element) or, when no
 * canvas is supplied, an internal `OffscreenCanvas`. Renders the
 * per-pixel filter pipeline as a fragment shader. The broker routes
 * `consumer: "preview"` renders to this backend.
 *
 * **Canvas-bound path (the fast path).** When the caller passes a
 * `targetCanvas` option, the backend acquires the WebGL2 context on
 * that canvas and renders the preview directly into its default
 * framebuffer. The browser composites the canvas without any CPU
 * readback. `render()` resolves with the caller's `source` (the
 * canvas is the side-effect). This eliminates the GPU -> CPU -> GPU
 * round-trip that the legacy `readPixels` + `putImageData` path pays
 * on every frame.
 *
 * **Legacy path (the fallback).** When no `targetCanvas` is
 * supplied, the backend creates its own `OffscreenCanvas` and reads
 * pixels back to an `ImageData`. This is used by consumers that
 * need a CPU-side result (the BottomBar's export pipeline, the
 * studio view's float32 path, and any consumer that doesn't have a
 * visible canvas to render into).
 *
 * **Escape hatch: webglcontextlost.** When the GPU context is lost
 * (mobile Safari backgrounding, low-memory kill, driver crash, tab
 * suspended), the WebGL backend reports itself as "degraded" via
 * `isDegraded()`. The selector then routes future renders to the
 * JS engine for the rest of the session. When the context is
 * restored (`webglcontextrestored`), the backend reinitializes and
 * becomes usable again. The user sees correct (JS-engine) results
 * the entire time — no blank canvas, no error.
 *
 * **Capability check.** The backend requires WebGL2 with `OES_texture_float`
 * (or WebGL2's built-in float texture support). If the host doesn't
 * provide it, `createWebGlBackend()` returns `null` and the selector
 * falls back to JS. This means the WebGL path is *opt-in* and the
 * JS path is *always* available.
 */
import type { PreviewAbortSignal, PreviewBackend, RenderRequest } from './types';
import { PER_PIXEL_FRAGMENT_SHADER, PER_PIXEL_VERTEX_SHADER } from './shaders';
import type { ResolvedFilterSettings } from '@/lib/filterEngine';
import { setWebGlDegraded, WEBGL_MAX_HSL_BANDS } from './selection';

/**
 * Convert a split-tone `{ hue, saturation }` pair into the RGB tint
 * the shader expects in `u_splitShadow` / `u_splitHighlight`. Mirrors
 * the JS engine's `hslToRgb` call in `getSplitToneTargets` -- shadows
 * are produced at lightness 0.48, highlights at 0.58. Returns 0..255
 * integers so the `- 0.5` centering below lands on a sensible range.
 */
export function splitToneTint(hue: number, saturation: number, lightness: number): [number, number, number] {
  // Match `hslToRgb` from `src/lib/filter-engine/utils.ts`: hue in
  // 0..360 deg, saturation/lightness in 0..1, output 0..255 ints.
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, saturation / 100));
  const l = Math.max(0, Math.min(1, lightness));
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toChannel = (offset: number) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(toChannel(1 / 3) * 255),
    Math.round(toChannel(0) * 255),
    Math.round(toChannel(-1 / 3) * 255),
  ];
}

/**
 * Pack a `SplitToneSettings` (or its absence) into the four scalar
 * values the WebGL shader expects in `u_splitShadow` / `u_splitHighlight`
 * / `u_splitBalance`. Extracted from `applyUniforms` so the math is
 * unit-testable under jsdom without a real WebGL2 context.
 *
 * The shader treats the RGB of `u_splitShadow` / `u_splitHighlight`
 * as already-centered (so it adds them directly to the source color),
 * and uses `u_splitBalance.x` for the balance pivot (0..1 maps to
 * -1..+1) and `u_splitBalance.y` for intensity (0..1 scalar).
 *
 * Returns `null` if no `splitTone` is present.
 */
export function packSplitToneUniforms(splitTone: { balance: number; shadows: { hue: number; saturation: number }; highlights: { hue: number; saturation: number } } | undefined): {
  shadow: [number, number, number, number];
  highlight: [number, number, number, number];
  balance: [number, number];
} | null {
  if (!splitTone) return null;
  const [sR, sG, sB] = splitToneTint(splitTone.shadows.hue, splitTone.shadows.saturation, 0.48);
  const [hR, hG, hB] = splitToneTint(splitTone.highlights.hue, splitTone.highlights.saturation, 0.58);
  // The shader's split-tone amount scales the .rgb offset by the .a
  // slot (0.32 for shadow, 0.28 for highlight). Putting the raw
  // saturation (clamped 0..1) in .a lets the shader do
  //   color += u_splitShadow.rgb * shadowMask * u_splitShadow.a * 0.32
  // to mirror the JS engine's `shadowAmount = shadowMask *
  // (splitTone.shadows.saturation / 100) * 0.32`.
  const shadowSat = Math.max(0, Math.min(1, splitTone.shadows.saturation / 100));
  const highlightSat = Math.max(0, Math.min(1, splitTone.highlights.saturation / 100));
  // u_splitBalance.y is the average saturation (kept for back-compat
  // with dev tools that read it).
  const intensity = Math.max(0, Math.min(1, (splitTone.shadows.saturation + splitTone.highlights.saturation) / 200));
  return {
    shadow: [sR / 255 - 0.5, sG / 255 - 0.5, sB / 255 - 0.5, shadowSat],
    highlight: [hR / 255 - 0.5, hG / 255 - 0.5, hB / 255 - 0.5, highlightSat],
    balance: [(splitTone.balance + 100) / 200, intensity],
  };
}

export type WebGlBackendState = 'ready' | 'degraded' | 'disposed';

export interface WebGlBackendOptions {
  /**
   * A caller-supplied canvas to render into. When provided, the
   * backend acquires a WebGL2 context on this canvas and renders the
   * preview directly to its default framebuffer -- the browser then
   * composites the canvas without any CPU readback. The caller is
   * responsible for sizing the canvas's display width/height to the
   * preview dimensions and for setting the canvas's CSS box.
   *
   * When `null` (or omitted), the backend falls back to the legacy
   * `defaultAcquireContext()` path: an internal `OffscreenCanvas`
   * is allocated, the result is read back as an `ImageData`, and the
   * caller is responsible for displaying it (e.g. via
   * `putImageData`).
   */
  targetCanvas?: HTMLCanvasElement | OffscreenCanvas | null;
  /**
   * The factory the backend uses to acquire a WebGL2 context when
   * `targetCanvas` is null. Defaults to `OffscreenCanvas` if the
   * runtime supports it, otherwise falls back to a regular
   * `<canvas>` element. Tests inject a custom factory so they can
   * run under jsdom.
   */
  acquireContext?: () => WebGL2RenderingContext | null;
  /**
   * Maximum HSL bands the shader supports. Defaults to
   * `WEBGL_MAX_HSL_BANDS` in `selection.ts`. The JS engine's
   * preset list can be longer; in that case the WebGL backend falls
   * back to JS.
   */
  maxHslBands?: number;
}

interface ProgramHandles {
  program: WebGLProgram;
  attribPosition: number;
  attribTexCoord: number;
  uniformSource: WebGLUniformLocation | null;
  uniformSourceSize: WebGLUniformLocation | null;
  uniformTime: WebGLUniformLocation | null;
  uniformAdjust0: WebGLUniformLocation | null;
  uniformAdjust1: WebGLUniformLocation | null;
  uniformAdjust2: WebGLUniformLocation | null;
  uniformGrain: WebGLUniformLocation | null;
  uniformHslBandMinMaxSoft: WebGLUniformLocation | null;
  uniformHslBandShiftSatLight: WebGLUniformLocation | null;
  uniformHslBandCount: WebGLUniformLocation | null;
  uniformSkinProtection: WebGLUniformLocation | null;
  uniformCurveLutR: WebGLUniformLocation | null;
  uniformCurveLutG: WebGLUniformLocation | null;
  uniformCurveLutB: WebGLUniformLocation | null;
  uniformSplitShadow: WebGLUniformLocation | null;
  uniformSplitHighlight: WebGLUniformLocation | null;
  uniformSplitBalance: WebGLUniformLocation | null;
  uniformEffectIntensity: WebGLUniformLocation | null;
}

export class WebGlBackend implements PreviewBackend {
  readonly kind = 'webgl' as const;

  private gl: WebGL2RenderingContext | null = null;
  private program: ProgramHandles | null = null;
  private sourceTexture: WebGLTexture | null = null;
  private curveLutTextures: [WebGLTexture, WebGLTexture, WebGLTexture] | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private fbWidth = 0;
  private fbHeight = 0;
  private state: WebGlBackendState = 'ready';
  private acquireContext: () => WebGL2RenderingContext | null;
  private maxHslBands: number;
  /**
   * The caller-supplied canvas we render directly into. When non-null,
   * the backend's `render()` resolves with the source (the canvas is
   * the side-effect) and skips `readPixels` -- the browser composites
   * the canvas without any CPU readback. When null, the backend
   * uses the legacy `defaultAcquireContext()` path and reads pixels
   * back to an `ImageData`.
   */
  private targetCanvas: HTMLCanvasElement | OffscreenCanvas | null;
  /**
   * True when `targetCanvas` is set. Cached so the hot render path
   * doesn't have to re-check on every frame. Determines whether
   * `render()` skips the readback.
   */
  private canvasBound: boolean;

  constructor(options: WebGlBackendOptions = {}) {
    this.acquireContext = options.acquireContext ?? defaultAcquireContext;
    this.maxHslBands = options.maxHslBands ?? WEBGL_MAX_HSL_BANDS;
    this.targetCanvas = options.targetCanvas ?? null;
    this.canvasBound = this.targetCanvas !== null;
  }

  /**
   * Lazily initialize the WebGL resources. Called on the first
   * `render`. Returns `true` if the backend is ready to render;
   * `false` if the host doesn't support WebGL2 or shader
   * compilation failed.
   */
  private ensureInitialized(width: number, height: number): boolean {
    if (this.state === 'degraded') return false;
    if (this.state === 'disposed') return false;
    // Fast path: same context, same size, same program — nothing to do.
    if (this.program && this.fbWidth === width && this.fbHeight === height) return true;

    // Acquire the WebGL context at most once per backend instance. The
    // default factory allocates a fresh `OffscreenCanvas` (and therefore
    // a fresh `WebGL2RenderingContext`) on every call, so calling it on
    // every dimension change would leak the previous context, program,
    // two textures, VAO, and two buffers — and browsers cap the total
    // number of live WebGL contexts (typically 16), so opening enough
    // images in one session would silently degrade every subsequent
    // image to JS with no diagnostic. The new `gl` also can't
    // `delete*` the resources owned by the old one, so they'd stay
    // pinned to GPU memory until tab close.
    //
    // When the caller supplied a `targetCanvas` (the visible
    // `ImageCanvas` element), we acquire the context on that canvas
    // itself -- the canvas IS the framebuffer, and the browser
    // composites the result without any CPU readback. The
    // `webglcontextlost` listener is attached to the same canvas,
    // so the existing event handling works unchanged.
    if (this.gl === null) {
      const gl = this.targetCanvas
        // `preserveDrawingBuffer: true` is required for the
        // canvas-bound path to be readable via `getImageData` /
        // `toDataURL` after the draw call returns. The browser
        // normally clears the WebGL backbuffer after
        // compositing, so a subsequent read would return
        // black. The cost is a single GPU-side copy of the
        // framebuffer per frame, which is far cheaper than the
        // CPU readback we're saving. The legacy `readPixels`
        // path doesn't need this (it reads inside the same
        // task, before the browser composites).
        ? (this.targetCanvas.getContext('webgl2', { preserveDrawingBuffer: true }) as WebGL2RenderingContext | null)
        : this.acquireContext();
      if (!gl) {
        // Host doesn't provide WebGL2. Mark degraded so the selector
        // routes to JS; do NOT throw — the caller (broker) will
        // surface a Promise rejection and the user will see a
        // broken slider, which is exactly the failure mode we
        // wanted to avoid.
        this.state = 'degraded';
        return false;
      }
      this.gl = gl;

      // Wire context-lost handlers. Note: `preventDefault()` is
      // required on the lost event to signal the browser that we
      // want a `webglcontextrestored` event later. Without it, the
      // context is gone for good.
      gl.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.onContextLost();
      });
      gl.canvas.addEventListener('webglcontextrestored', () => {
        this.onContextRestored();
      });
    }

    const gl = this.gl;

    // Resize the backing canvas. Writing to `canvas.width` /
    // `canvas.height` on a live WebGL2 context resets transient GL
    // state — the default framebuffer, viewport, scissor, clear color,
    // blend, and currently bound buffers/VAOs — and clears the
    // framebuffer contents. It does NOT invalidate programs, shaders,
    // textures, vertex buffers, or VAO objects; those survive a
    // resize. So when we already have a program and textures, a
    // dimension change is just a canvas resize + a fresh `texImage2D`
    // in `uploadSource` on the next frame — we do NOT recompile or
    // re-allocate the program, textures, VAO, or buffers. The next
    // `draw()` writes fresh pixels into the resized framebuffer.
    // `defaultAcquireContext` creates a 1x1 canvas, so this resize is
    // also what gives us a real framebuffer on first init.
    if (gl && gl.canvas && (gl.canvas.width !== width || gl.canvas.height !== height)) {
      gl.canvas.width = width;
      gl.canvas.height = height;
    }

    // Compile the program and allocate the GL objects the first time
    // (no cached `this.program`) and again after a context-lost +
    // restored cycle, when `onContextLost` nulled them out but the
    // canvas +`gl` were preserved. Skip on a plain dimension change
    // — the program, textures, VAO, and buffers are still valid.
    if (this.program === null) {
      this.program = this.compileProgram();
      if (!this.program) {
        this.state = 'degraded';
        return false;
      }
      this.allocateTextures(width, height);
    }
    this.fbWidth = width;
    this.fbHeight = height;
    if (import.meta.env.DEV && !(this as { _diagLogged?: boolean })._diagLogged) {
      (this as { _diagLogged?: boolean })._diagLogged = true;
      console.info(
        "[webgl-preview] WebGlBackend initialised:",
        "canvas=", gl?.canvas?.width, "x", gl?.canvas?.height,
        "fb=", this.fbWidth, "x", this.fbHeight,
        "viewport=", gl?.getParameter(gl?.VIEWPORT),
      );
    }
    return true;
  }

  isDegraded(): boolean {
    return this.state === 'degraded';
  }

  getState(): WebGlBackendState {
    return this.state;
  }

  /**
   * Renders the request. The WebGL backend does its own
   * per-consumer latest-wins: a new render aborts the in-flight
   * one by setting a flag the shader can read (or, since the
   * per-pixel work is so fast, by issuing a new `drawArrays` and
   * ignoring the previous promise's resolution). The Promise
   * contract is the same as `JsBackend.render`.
   */
  render(request: RenderRequest, signal: PreviewAbortSignal): Promise<ImageData> {
    return new Promise<ImageData>((resolve, reject) => {
      if (signal.aborted) {
        resolve(request.source);
        return;
      }
      if (this.state === 'degraded') {
        reject(new Error('WebGL context lost; caller should fall back to JS backend'));
        return;
      }
      if (this.state === 'disposed') {
        reject(new Error('WebGL backend disposed'));
        return;
      }

      const { source, settings } = request;
      const ok = this.ensureInitialized(source.width, source.height);
      if (!ok) {
        reject(new Error('WebGL initialization failed'));
        return;
      }

      // Apply the shader and read back the result. The shader is
      // synchronous from the caller's perspective; we yield once
      // so the abort flag is observed between setup and resolve.
      try {
        this.uploadSource(source);
        this.applyUniforms(settings, source);
        this.draw();
        const gl2 = this.gl;
        if (import.meta.env.DEV && !(this as { _drawDiagLogged?: boolean })._drawDiagLogged) {
          (this as { _drawDiagLogged?: boolean })._drawDiagLogged = true;
          console.info(
            "[webgl-preview] DRAW-DIAG\n" +
            "  canvas.size = " + (gl2?.canvas?.width ?? "?") + "x" + (gl2?.canvas?.height ?? "?") + "\n" +
            "  program active       = " + (gl2?.getParameter(gl2?.CURRENT_PROGRAM) !== null) + "\n" +
            "  VAO bound (raw)      = " + gl2?.getParameter(gl2?.VERTEX_ARRAY_BINDING) + "\n" +
            "  viewport after draw  = " + JSON.stringify(gl2?.getParameter(gl2?.VIEWPORT)) + "\n" +
            "  TEXTURE0 binding     = " + gl2?.getParameter(gl2?.TEXTURE_BINDING_2D) + "\n" +
            "  GL_ACTIVE_TEXTURE    = " + gl2?.getParameter(gl2?.ACTIVE_TEXTURE) + "\n" +
            "  glError after draw   = " + gl2?.getError() + "\n" +
            "  canvasBound          = " + this.canvasBound,
          );
        }
        // Canvas-bound path: the shader output is already in the
        // target canvas's default framebuffer. The browser composites
        // it without any CPU readback. The Promise contract still
        // resolves with an `ImageData` so the existing broker /
        // call-site code is unchanged; we resolve with the source
        // (the canvas is the side-effect). This is the fast path
        // that eliminates the GPU -> CPU -> GPU round-trip on every
        // preview frame.
        //
        // Legacy path: read pixels back and flip them so the
        // returned buffer matches the source's top-down layout.
        const result: ImageData = this.canvasBound
          ? request.source
          : new ImageData(this.readPixels(), source.width, source.height);
        if (!this.canvasBound && import.meta.env.DEV && !(this as { _readDiagLogged?: boolean })._readDiagLogged) {
          (this as { _readDiagLogged?: boolean })._readDiagLogged = true;
          const gl = this.gl;
          const pixels = result.data;
          const first16 = Array.from(pixels.subarray(0, 16));
          const last16 = Array.from(pixels.subarray(pixels.length - 16));
          const srcFirst16 = Array.from(source.data.subarray(0, 16));
          let nonZero = 0;
          for (let i = 0; i < pixels.length; i++) if (pixels[i] !== 0) nonZero++;
          const glErr = gl?.getError();
          console.info(
            "[webgl-preview] DIAG\n" +
            "  canvas.size = " + (gl?.canvas?.width ?? "?") + "x" + (gl?.canvas?.height ?? "?") + "\n" +
            "  fb.size     = " + this.fbWidth + "x" + this.fbHeight + "\n" +
            "  source.size = " + source.width + "x" + source.height + "\n" +
            "  viewport    = " + JSON.stringify(gl?.getParameter(gl.VIEWPORT)) + "\n" +
            "  glError     = " + glErr + " (0=NO_ERROR)\n" +
            "  readPixels first16 = " + JSON.stringify(first16) + "\n" +
            "  readPixels last16  = " + JSON.stringify(last16) + "\n" +
            "  source     first16 = " + JSON.stringify(srcFirst16) + "\n" +
            "  readPixels nonZero = " + nonZero + " / " + pixels.length,
          );
        }
        // Yield once so callers polling the abort signal between
        // microtasks have a chance to bail.
        queueMicrotask(() => {
          // If the job was cancelled between scheduling and now, settle
          // the promise with the source so the .then closure is
          // collected. The broker in filter-worker.ts already drops
          // cancelled results; resolving here just releases the
          // closure over setFilteredImageData and the React fiber.
          if (signal.aborted) {
            resolve(request.source);
            return;
          }
          resolve(result);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  cancel(): void {
    // No-op: the next render overwrites the framebuffer. We
    // intentionally don't tear down the WebGL context on cancel
    // because reinitializing it is more expensive than just
    // overwriting the frame.
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    const gl = this.gl;
    if (gl) {
      // The WebGL2 spec marks gl.delete* as undefined behavior on a
      // lost context (in practice every driver no-ops). Skip the
      // teardown calls when the context is lost -- the GPU resources
      // are already gone for good, and we don't want to depend on the
      // driver no-op. The JS references still need to be dropped so
      // the broker can rebuild on the next render.
      const isLost = gl.isContextLost();
      if (!isLost) {
        if (this.program) gl.deleteProgram(this.program.program);
        if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
        if (this.curveLutTextures) {
          for (const tex of this.curveLutTextures) gl.deleteTexture(tex);
        }
        if (this.vao) gl.deleteVertexArray(this.vao);
      }
    }
    this.program = null;
    this.sourceTexture = null;
    this.curveLutTextures = null;
    this.vao = null;
    this.gl = null;
    // Drop the caller's canvas reference. The canvas itself remains
    // mounted in the DOM (the React component owns it) -- we only
    // drop our handle. The next backend that binds to the same
    // canvas will get its own WebGL2 context via `getContext('webgl2')`
    // (the browser returns the existing context, so no GPU resources
    // are duplicated).
    this.targetCanvas = null;
    this.canvasBound = false;
  }

  // -- private ---------------------------------------------------------------

  private onContextLost(): void {
    setWebGlDegraded(true);
    // Mark degraded so the selector routes future renders to JS.
    // The context is already lost at this point; calling gl.delete*
    // on a lost context is undefined behavior per the WebGL2 spec
    // (in practice every driver no-ops, but we should not depend
    // on that). Just drop the JS references -- the GPU resources
    // are gone for good; the next render on webglcontextrestored
    // will rebuild them.
    this.state = 'degraded';
    this.program = null;
    this.sourceTexture = null;
    this.curveLutTextures = null;
    this.vao = null;
  }

  private onContextRestored(): void {
    // Don't clear the global degraded flag if this backend is
    // already disposed -- another live WebGlBackend instance may
    // still be in a degraded state, and clearing the flag would
    // route its future renders back to the (still-broken) WebGL
    // path. Re-arm only when the backend itself is still alive.
    if (this.state === 'disposed') return;
    setWebGlDegraded(false);
    // Re-arm the backend. The next render call will reinitialize
    // the GL resources; we don't force it here so the broker
    // doesn't see a half-restored backend.
    this.state = 'ready';
    this.fbWidth = 0;
    this.fbHeight = 0;
  }

  private compileProgram(): ProgramHandles | null {
    const gl = this.gl;
    if (!gl) return null;

    const vs = compileShader(gl, gl.VERTEX_SHADER, PER_PIXEL_VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, PER_PIXEL_FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      console.error('[webgl-preview] program link failed:', log);
      return null;
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return {
      program,
      attribPosition: gl.getAttribLocation(program, 'a_position'),
      attribTexCoord: gl.getAttribLocation(program, 'a_texCoord'),
      uniformSource: gl.getUniformLocation(program, 'u_source'),
      uniformSourceSize: gl.getUniformLocation(program, 'u_sourceSize'),
      uniformTime: gl.getUniformLocation(program, 'u_time'),
      uniformAdjust0: gl.getUniformLocation(program, 'u_adjust0'),
      uniformAdjust1: gl.getUniformLocation(program, 'u_adjust1'),
      uniformAdjust2: gl.getUniformLocation(program, 'u_adjust2'),
      uniformGrain: gl.getUniformLocation(program, 'u_grain'),
      uniformHslBandMinMaxSoft: gl.getUniformLocation(program, 'u_hslBandMinMaxSoft[0]'),
      uniformHslBandShiftSatLight: gl.getUniformLocation(program, 'u_hslBandShiftSatLight[0]'),
      uniformHslBandCount: gl.getUniformLocation(program, 'u_hslBandCount'),
      uniformSkinProtection: gl.getUniformLocation(program, 'u_skinProtection'),
      uniformCurveLutR: gl.getUniformLocation(program, 'u_curveLutR'),
      uniformCurveLutG: gl.getUniformLocation(program, 'u_curveLutG'),
      uniformCurveLutB: gl.getUniformLocation(program, 'u_curveLutB'),
      uniformSplitShadow: gl.getUniformLocation(program, 'u_splitShadow'),
      uniformSplitHighlight: gl.getUniformLocation(program, 'u_splitHighlight'),
      uniformSplitBalance: gl.getUniformLocation(program, 'u_splitBalance'),
      uniformEffectIntensity: gl.getUniformLocation(program, 'u_effectIntensity'),
    };
  }

  private allocateTextures(_width: number, _height: number): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    // Fullscreen quad: 2 triangles covering [-1, 1] in clip space.
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.program.attribPosition);
    gl.vertexAttribPointer(this.program.attribPosition, 2, gl.FLOAT, false, 0, 0);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.program.attribTexCoord);
    gl.vertexAttribPointer(this.program.attribTexCoord, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // Source texture (RGBA8)
    this.sourceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Per-channel curve LUTs (256x1 R8). All three start as the
    // identity LUT; the first applyUniforms() upload composes the
    // master + per-channel LUTs into a single lookup per channel
    // and uploads via texSubImage2D.
    const identity = identityLut();
    this.curveLutTextures = [
      gl.createTexture() as WebGLTexture,
      gl.createTexture() as WebGLTexture,
      gl.createTexture() as WebGLTexture,
    ];
    for (const tex of this.curveLutTextures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, identity);
    }
  }

  private uploadSource(source: ImageData): void {
    const gl = this.gl;
    if (!gl || !this.sourceTexture) return;
    // The previous render's applyUniforms() leaves the active texture unit on
    // TEXTURE1 (curve LUT). Force TEXTURE0 so the source texture binds to the
    // sampler-0 unit; otherwise render #2+ reads an empty unit and outputs black.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
  }

  private applyUniforms(settings: ResolvedFilterSettings, source: ImageData): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    gl.useProgram(this.program.program);

    const a = settings.adjustments;
    // Slider range is 0..100 (or -100..100). Normalize to 0..1 / -1..+1.
    gl.uniform4f(
      this.program.uniformAdjust0,
      a.brightness / 100,
      a.contrast / 100,
      a.highlights / 100,
      a.shadows / 100,
    );
    gl.uniform4f(this.program.uniformAdjust1, a.whites / 100, a.blacks / 100, a.temperature / 100, a.tint / 100);
    gl.uniform4f(this.program.uniformAdjust2, a.saturation / 100, a.vibrance / 100, a.fade / 100, a.vignette / 100);
    gl.uniform1f(this.program.uniformGrain, a.grain / 100);
    gl.uniform1f(this.program.uniformTime, performance.now() / 1000);

    // HSL bands -- pack up to maxHslBands, then zero-pad.
    const bands = settings.hsl.slice(0, this.maxHslBands);
    const minMaxSoft = new Float32Array(4 * this.maxHslBands);
    const shiftSatLight = new Float32Array(4 * this.maxHslBands);
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]!;
      minMaxSoft[i * 4 + 0] = b.minHue;
      minMaxSoft[i * 4 + 1] = b.maxHue;
      minMaxSoft[i * 4 + 2] = 0;
      minMaxSoft[i * 4 + 3] = b.softness ?? 18;
      shiftSatLight[i * 4 + 0] = b.hueShift;
      shiftSatLight[i * 4 + 1] = b.saturation / 100;
      shiftSatLight[i * 4 + 2] = b.lightness / 100;
      shiftSatLight[i * 4 + 3] = 0;
    }
    gl.uniform4fv(this.program.uniformHslBandMinMaxSoft, minMaxSoft);
    gl.uniform4fv(this.program.uniformHslBandShiftSatLight, shiftSatLight);
    gl.uniform1i(this.program.uniformHslBandCount, bands.length);

    const skinProtection =
      (settings.analysis?.portraitLikelihood ?? 0) * (settings.preset.adaptive?.portraitProtection ?? 0.72);
    gl.uniform1f(this.program.uniformSkinProtection, skinProtection);

    // Per-channel curve LUTs. The JS engine composes
    //   sample(masterLut, sample(channelLut, value))
    // for each channel. We bake the composition into a single
    // 256-entry lookup per channel in `composeChannelLut` and
    // upload via texSubImage2D, so the shader does a single
    // texture sample per channel.
    //
    // The three LUTs must be bound to *different* texture units --
    // each sampler in the shader reads from a unit specified by its
    // own uniform1i call. The previous code bound all three to
    // TEXTURE1 (the same unit) and pointed all three samplers at
    // unit 1, which meant the GPU read the B LUT for all three
    // channels. With only a master curve (the common case) the
    // bug was invisible because all three LUTs are the same; with
    // per-channel curves it silently applied the B curve to R and
    // G, which is exactly the "WebGL isn't applying my filters"
    // symptom. Bind each LUT to its own unit (TEXTURE1, TEXTURE2,
    // TEXTURE3).
    if (this.curveLutTextures) {
      const rLut = composeChannelLut(settings.curveLuts.master, settings.curveLuts.r);
      const gLut = composeChannelLut(settings.curveLuts.master, settings.curveLuts.g);
      const bLut = composeChannelLut(settings.curveLuts.master, settings.curveLuts.b);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curveLutTextures[0]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, rLut);
      gl.uniform1i(this.program.uniformCurveLutR, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.curveLutTextures[1]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, gLut);
      gl.uniform1i(this.program.uniformCurveLutG, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.curveLutTextures[2]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, bLut);
      gl.uniform1i(this.program.uniformCurveLutB, 3);
    }

    // Split tone. `SplitToneSettings` carries `shadows: { hue, saturation }`
    // and `highlights: { hue, saturation }` (see
    // `src/lib/filter-engine/types.ts`). Mirror the JS engine's
    // `getSplitToneTargets` and convert those to RGB tints, then
    // feed them into the same `u_splitShadow` / `u_splitHighlight`
    // uniforms. `SplitToneSettings` has no `intensity` field, so the
    // shader's `intensity` slot is driven by the average of the two
    // saturations (clamped to 0..1) -- the previous code read
    // `st.intensity / 100` and got `NaN`. The math lives in
    // `packSplitToneUniforms` so it's unit-testable under jsdom.
    const st = settings.splitTone;
    const packed = packSplitToneUniforms(st);
    if (packed) {
      gl.uniform4f(this.program.uniformSplitShadow, packed.shadow[0], packed.shadow[1], packed.shadow[2], packed.shadow[3]);
      gl.uniform4f(this.program.uniformSplitHighlight, packed.highlight[0], packed.highlight[1], packed.highlight[2], packed.highlight[3]);
      gl.uniform2f(this.program.uniformSplitBalance, packed.balance[0], packed.balance[1]);
    } else {
      gl.uniform4f(this.program.uniformSplitShadow, 0, 0, 0, 0);
      gl.uniform4f(this.program.uniformSplitHighlight, 0, 0, 0, 0);
      gl.uniform2f(this.program.uniformSplitBalance, 0.5, 0);
    }

    // `settings.effectIntensity` is already normalized to 0..1 by
    // `prepareFilterSettings` (see `src/lib/filters/index.ts`:
    // `effectIntensity = clamp01((options.effectIntensity ?? 100) / 100)`).
    // Dividing by 100 again would make the shader receive 0..0.01, and
    // its `mix(originalColor, color, u_effectIntensity)` would land at
    // ~1% filter strength even with the slider at 100% -- the preview
    // would look unfiltered. Pass through the normalized value.
    gl.uniform1f(this.program.uniformEffectIntensity, settings.effectIntensity);

    gl.uniform1i(this.program.uniformSource, 0);
    gl.uniform2f(this.program.uniformSourceSize, source.width, source.height);

    // Reset active texture unit so subsequent calls (e.g. uploadSource) bind to TEXTURE0 by default.
    gl.activeTexture(gl.TEXTURE0);
  }

  private draw(): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    gl.viewport(0, 0, this.fbWidth, this.fbHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private readPixels(): Uint8ClampedArray {
    const gl = this.gl;
    if (!gl) throw new Error('WebGL context unavailable');
    const pixels = new Uint8ClampedArray(this.fbWidth * this.fbHeight * 4);
    gl.readPixels(0, 0, this.fbWidth, this.fbHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // WebGL's readPixels is bottom-up; flip vertically so the
    // returned buffer matches the source's top-down layout.
    flipVerticallyInPlace(pixels, this.fbWidth, this.fbHeight);
    return pixels;
  }
}

function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    console.error('[webgl-preview] shader compile failed:', log, source);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function identityLut(): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
}

/**
 * Compose a 256-entry curve LUT for one channel. The JS engine's
 * `applyToneCurve` is `sample(masterLut, sample(channelLut, value))`
 * where a missing LUT is the identity. We bake that into a single
 * 256-entry lookup here so the shader does one texture sample per
 * channel. Exported for jsdom-side unit testing.
 */
export function composeChannelLut(
  masterLut: Uint8Array | null,
  channelLut: Uint8Array | null,
): Uint8Array {
  const out = new Uint8Array(256);
  const master = masterLut ?? null;
  const channel = channelLut ?? null;
  for (let i = 0; i < 256; i++) {
    const channelVal = channel ? channel[i]! : i;
    const masterVal = master ? master[channelVal]! : channelVal;
    // R8 storage wraps modulo 256 if we don't clamp, so an overshoot
    // (e.g. master returns 400 for an in-range input) silently
    // produces 144 on the GPU. Clamp explicitly here so the texture
    // sees 255, not 144. The previous code relied on Uint8Array
    // assignment, which wraps.
    out[i] = masterVal > 255 ? 255 : masterVal < 0 ? 0 : masterVal;
  }
  return out;
}

function flipVerticallyInPlace(pixels: Uint8ClampedArray, width: number, height: number): void {
  const rowBytes = width * 4;
  const temp = new Uint8ClampedArray(rowBytes);
  for (let y = 0; y < height / 2; y++) {
    const top = y * rowBytes;
    const bottom = (height - 1 - y) * rowBytes;
    temp.set(pixels.subarray(top, top + rowBytes));
    pixels.copyWithin(top, bottom, bottom + rowBytes);
    pixels.set(temp, bottom);
  }
}

// Module-level WebGL2 support flag. Probed once at first call
// (`isWebGlPreviewSupported()` and the first `defaultAcquireContext()`
// are both memoized through this). Replaces the per-call
// `console.error` swap: the swap runs at most once per page lifetime,
// not on every backend instantiation. Module-level state is fine
// because the broker's selector is a process-wide concept.
let webgl2Support: boolean | null = null;

/**
 * Detect whether the current host can provide a WebGL2 context.
 * Uses a one-shot `console.error` swap to silence the noisy
 * "jsdom does not implement WebGL2" error that
 * `HTMLCanvasElement.prototype.getContext('webgl2')` prints in
 * jsdom. The swap is scoped to the synchronous `getContext` call
 * and is restored via `finally`, so legitimate errors from any
 * concurrent code path are never swallowed. The probe runs at
 * most once per page lifetime (memoized in `webgl2Support`).
 */
function detectWebGl2Support(): boolean {
  if (typeof window === 'undefined' && typeof document === 'undefined') {
    return false;
  }
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(1, 1);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
  } else {
    return false;
  }
  const orig = console.error;
  console.error = () => {};
  try {
    return canvas.getContext('webgl2') !== null;
  } finally {
    console.error = orig;
  }
}

/**
 * Acquire a WebGL2 context using `OffscreenCanvas` if available,
 * else a regular `<canvas>`. Returns `null` if the host doesn't
 * support WebGL2 at all.
 */
function defaultAcquireContext(): WebGL2RenderingContext | null {
  if (typeof window === 'undefined' && typeof document === 'undefined') {
    return null;
  }
  if (webgl2Support === false) return null;
  if (webgl2Support === null) {
    webgl2Support = detectWebGl2Support();
  }
  if (!webgl2Support) return null;
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(1, 1);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
  }
  // After the one-shot probe in `detectWebGl2Support`, the host is
  // known to support WebGL2. No `console.error` swap is needed here.
  return canvas.getContext('webgl2') as WebGL2RenderingContext | null;
}

/**
 * Check whether the current host can run the WebGL backend. The
 * selector calls this before allocating a backend; returning `false`
 * means the selector will fall back to JS without ever trying to
 * acquire a context.
 */
export function isWebGlPreviewSupported(): boolean {
  if (webgl2Support === null) {
    webgl2Support = detectWebGl2Support();
  }
  return webgl2Support;
}
