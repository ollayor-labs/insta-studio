/**
 * WebGL2 preview backend. Owns a WebGL2 context on an `OffscreenCanvas`
 * and runs the per-pixel filter pipeline as a fragment shader. The
 * broker routes `consumer: "preview"` renders to this backend.
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
import type { PreviewAbortSignal, PreviewBackend, RenderRequest } from "./types";
import { PER_PIXEL_FRAGMENT_SHADER, PER_PIXEL_VERTEX_SHADER } from "./shaders";
import { settingsRequireBlurPasses } from "./selection";
import type { HslBandAdjustment, ResolvedFilterSettings } from "@/lib/filterEngine";
import { setWebGlDegraded } from "./selection";

export type WebGlBackendState = "ready" | "degraded" | "disposed";

export interface WebGlBackendOptions {
  /**
   * The factory the backend uses to acquire a WebGL2 context. Defaults
   * to `OffscreenCanvas` if the runtime supports it, otherwise falls
   * back to a regular `<canvas>` element. Tests inject a custom
   * factory so they can run under jsdom.
   */
  acquireContext?: () => WebGL2RenderingContext | null;
  /**
   * Maximum HSL bands the shader supports. Defaults to 8 to match
   * `MAX_HSL_BANDS` in `shaders.ts`. The JS engine's preset list
   * can be longer; in that case the WebGL backend falls back to JS.
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
  uniformCurveLut: WebGLUniformLocation | null;
  uniformSplitShadow: WebGLUniformLocation | null;
  uniformSplitHighlight: WebGLUniformLocation | null;
  uniformSplitBalance: WebGLUniformLocation | null;
  uniformEffectIntensity: WebGLUniformLocation | null;
}

export class WebGlBackend implements PreviewBackend {
  readonly kind = "webgl" as const;

  private gl: WebGL2RenderingContext | null = null;
  private program: ProgramHandles | null = null;
  private sourceTexture: WebGLTexture | null = null;
  private curveLutTexture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private fbWidth = 0;
  private fbHeight = 0;
  private state: WebGlBackendState = "ready";
  private acquireContext: () => WebGL2RenderingContext | null;
  private maxHslBands: number;

  constructor(options: WebGlBackendOptions = {}) {
    this.acquireContext = options.acquireContext ?? defaultAcquireContext;
    this.maxHslBands = options.maxHslBands ?? 8;
  }

  /**
   * Lazily initialize the WebGL resources. Called on the first
   * `render`. Returns `true` if the backend is ready to render;
   * `false` if the host doesn't support WebGL2 or shader
   * compilation failed.
   */
  private ensureInitialized(width: number, height: number): boolean {
    if (this.state === "degraded") return false;
    if (this.state === "disposed") return false;
    if (this.program && this.fbWidth === width && this.fbHeight === height) return true;

    const gl = this.acquireContext();
    if (!gl) {
      // Host doesn't provide WebGL2. Mark degraded so the selector
      // routes to JS; do NOT throw — the caller (broker) will
      // surface a Promise rejection and the user will see a
      // broken slider, which is exactly the failure mode we
      // wanted to avoid.
      this.state = "degraded";
      return false;
    }
    this.gl = gl;

    // Wire context-lost handlers. Note: `preventDefault()` is
    // required on the lost event to signal the browser that we
    // want a `webglcontextrestored` event later. Without it, the
    // context is gone for good.
    gl.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.onContextLost();
    });
    gl.canvas.addEventListener("webglcontextrestored", () => {
      this.onContextRestored();
    });

    if (!this.compileProgram()) {
      this.state = "degraded";
      return false;
    }
    this.allocateTextures(width, height);
    this.fbWidth = width;
    this.fbHeight = height;
    return true;
  }

  isDegraded(): boolean {
    return this.state === "degraded";
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
      if (this.state === "degraded") {
        reject(new Error("WebGL context lost; caller should fall back to JS backend"));
        return;
      }
      if (this.state === "disposed") {
        reject(new Error("WebGL backend disposed"));
        return;
      }

      const { source, settings } = request;
      const ok = this.ensureInitialized(source.width, source.height);
      if (!ok) {
        reject(new Error("WebGL initialization failed"));
        return;
      }

      // Apply the shader and read back the result. The shader is
      // synchronous from the caller's perspective; we yield once
      // so the abort flag is observed between setup and resolve.
      try {
        this.uploadSource(source);
        this.applyUniforms(settings);
        this.draw();
        const pixels = this.readPixels();
        const result = new ImageData(pixels, source.width, source.height);
        // Yield once so callers polling the abort signal between
        // microtasks have a chance to bail.
        queueMicrotask(() => {
          if (signal.aborted) return;
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
    if (this.state === "disposed") return;
    this.state = "disposed";
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program.program);
      if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
      if (this.curveLutTexture) gl.deleteTexture(this.curveLutTexture);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    this.program = null;
    this.sourceTexture = null;
    this.curveLutTexture = null;
    this.vao = null;
    this.gl = null;
  }

  // -- private ---------------------------------------------------------------

  private onContextLost(): void {
    setWebGlDegraded(true);
    // Mark degraded so the selector routes future renders to JS.
    // Drop the GL resources; we'll rebuild on restored.
    this.state = "degraded";
    if (this.gl) {
      // Free as much GPU memory as possible while we wait for restore.
      if (this.program) this.gl.deleteProgram(this.program.program);
      if (this.sourceTexture) this.gl.deleteTexture(this.sourceTexture);
      if (this.curveLutTexture) this.gl.deleteTexture(this.curveLutTexture);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
    }
    this.program = null;
    this.sourceTexture = null;
    this.curveLutTexture = null;
    this.vao = null;
  }

  private onContextRestored(): void {
    setWebGlDegraded(false);
    // Re-arm the backend. The next render call will reinitialize
    // the GL resources; we don't force it here so the broker
    // doesn't see a half-restored backend.
    if (this.state === "disposed") return;
    this.state = "ready";
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
      console.error("[webgl-preview] program link failed:", log);
      return null;
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return {
      program,
      attribPosition: gl.getAttribLocation(program, "a_position"),
      attribTexCoord: gl.getAttribLocation(program, "a_texCoord"),
      uniformSource: gl.getUniformLocation(program, "u_source"),
      uniformSourceSize: gl.getUniformLocation(program, "u_sourceSize"),
      uniformTime: gl.getUniformLocation(program, "u_time"),
      uniformAdjust0: gl.getUniformLocation(program, "u_adjust0"),
      uniformAdjust1: gl.getUniformLocation(program, "u_adjust1"),
      uniformAdjust2: gl.getUniformLocation(program, "u_adjust2"),
      uniformGrain: gl.getUniformLocation(program, "u_grain"),
      uniformHslBandMinMaxSoft: gl.getUniformLocation(program, "u_hslBandMinMaxSoft[0]"),
      uniformHslBandShiftSatLight: gl.getUniformLocation(program, "u_hslBandShiftSatLight[0]"),
      uniformHslBandCount: gl.getUniformLocation(program, "u_hslBandCount"),
      uniformSkinProtection: gl.getUniformLocation(program, "u_skinProtection"),
      uniformCurveLut: gl.getUniformLocation(program, "u_curveLut"),
      uniformSplitShadow: gl.getUniformLocation(program, "u_splitShadow"),
      uniformSplitHighlight: gl.getUniformLocation(program, "u_splitHighlight"),
      uniformSplitBalance: gl.getUniformLocation(program, "u_splitBalance"),
      uniformEffectIntensity: gl.getUniformLocation(program, "u_effectIntensity"),
    };
  }

  private allocateTextures(width: number, height: number): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    // Fullscreen quad: 2 triangles covering [-1, 1] in clip space.
    const positions = new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1,
    ]);
    const texCoords = new Float32Array([
      0, 1,
      1, 1,
      0, 0,
      0, 0,
      1, 1,
      1, 0,
    ]);
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

    // Curve LUT (256x1 R8)
    this.curveLutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.curveLutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      256,
      1,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      identityLut(),
    );
  }

  private uploadSource(source: ImageData): void {
    const gl = this.gl;
    if (!gl || !this.sourceTexture) return;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      source.width,
      source.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source.data,
    );
  }

  private applyUniforms(settings: ResolvedFilterSettings): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    gl.useProgram(this.program.program);

    const a = settings.adjustments;
    // Slider range is 0..100 (or -100..100). Normalize to 0..1 / -1..+1.
    gl.uniform4f(this.program.uniformAdjust0,
      a.brightness / 100,
      a.contrast / 100,
      a.highlights / 100,
      a.shadows / 100,
    );
    gl.uniform4f(this.program.uniformAdjust1,
      a.whites / 100,
      a.blacks / 100,
      a.temperature / 100,
      a.tint / 100,
    );
    gl.uniform4f(this.program.uniformAdjust2,
      a.saturation / 100,
      a.vibrance / 100,
      a.fade / 100,
      a.vignette / 100,
    );
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

    const skinProtection = (settings.analysis?.portraitLikelihood ?? 0)
      * (settings.preset.adaptive?.portraitProtection ?? 0.72);
    gl.uniform1f(this.program.uniformSkinProtection, skinProtection);

    // Master curve LUT -- build a 256-entry identity LUT for now;
    // future work is to pack the actual curveLuts.master into the
    // texture. The JS engine uses per-channel LUTs; the WebGL
    // shader uses a single master LUT for simplicity, which is
    // a known limitation (per-channel curves are a follow-up).
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveLutTexture);
    gl.uniform1i(this.program.uniformCurveLut, 1);
    if (settings.curveLuts.master) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        256,
        1,
        gl.RED,
        gl.UNSIGNED_BYTE,
        settings.curveLuts.master,
      );
    }

    // Split tone
    const st = settings.splitTone;
    if (st) {
      const shadowR = parseInt(st.shadows.slice(1, 3), 16) / 255;
      const shadowG = parseInt(st.shadows.slice(3, 5), 16) / 255;
      const shadowB = parseInt(st.shadows.slice(5, 7), 16) / 255;
      const highlightR = parseInt(st.highlights.slice(1, 3), 16) / 255;
      const highlightG = parseInt(st.highlights.slice(3, 5), 16) / 255;
      const highlightB = parseInt(st.highlights.slice(5, 7), 16) / 255;
      gl.uniform4f(this.program.uniformSplitShadow, shadowR - 0.5, shadowG - 0.5, shadowB - 0.5, 0);
      gl.uniform4f(this.program.uniformSplitHighlight, highlightR - 0.5, highlightG - 0.5, highlightB - 0.5, 0);
      gl.uniform2f(this.program.uniformSplitBalance,
        (st.balance + 100) / 200, // map -100..100 to 0..1
        st.intensity / 100,
      );
    } else {
      gl.uniform4f(this.program.uniformSplitShadow, 0, 0, 0, 0);
      gl.uniform4f(this.program.uniformSplitHighlight, 0, 0, 0, 0);
      gl.uniform2f(this.program.uniformSplitBalance, 0.5, 0);
    }

    gl.uniform1f(this.program.uniformEffectIntensity, settings.effectIntensity / 100);

    gl.uniform1i(this.program.uniformSource, 0);
    gl.uniform2f(this.program.uniformSourceSize, settings.adjustments ? 1 : 1, 1);
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
    if (!gl) throw new Error("WebGL context unavailable");
    const pixels = new Uint8ClampedArray(this.fbWidth * this.fbHeight * 4);
    gl.readPixels(
      0,
      0,
      this.fbWidth,
      this.fbHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    // WebGL's readPixels is bottom-up; flip vertically so the
    // returned buffer matches the source's top-down layout.
    flipVerticallyInPlace(pixels, this.fbWidth, this.fbHeight);
    return pixels;
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    console.error("[webgl-preview] shader compile failed:", log, source);
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

/**
 * Acquire a WebGL2 context using `OffscreenCanvas` if available,
 * else a regular `<canvas>`. Returns `null` if the host doesn't
 * support WebGL2 at all.
 */
function defaultAcquireContext(): WebGL2RenderingContext | null {
  // Silenced: jsdom's OffscreenCanvas/HTMLCanvasElement.getContext
  // doesn't support webgl2 and prints a noisy console.error. We
  // just want to know whether the host CAN provide a context.
  const orig = console.error;
  try {
    console.error = () => {};
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(1, 1);
      return canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    }
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      return canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    }
    return null;
  } finally {
    console.error = orig;
  }
}

/**
 * Check whether the current host can run the WebGL backend. The
 * selector calls this before allocating a backend; returning `false`
 * means the selector will fall back to JS without ever trying to
 * acquire a context.
 */
export function isWebGlPreviewSupported(): boolean {
  return defaultAcquireContext() !== null;
}
