/**
 * Public types for the preview backend abstraction. A backend is a sink
 * for a render request (a typed `RenderRequest`) that produces an
 * `ImageData`. The two real backends are the JS engine worker
 * (existing path) and the WebGL2 fragment-shader pipeline (new path).
 *
 * The abstraction is intentionally narrow: it speaks in `ImageData`
 * rather than `Worker` / `WebGL2RenderingContext` so the broker and
 * the call sites don't need to know which backend they're on. A
 * future WebGPU backend would slot in the same way.
 */
import type { ResolvedFilterSettings } from "@/lib/filterEngine";

export interface RenderRequest {
  /** Source raster; width and height must match `data.length / 4`. */
  source: ImageData;
  /** Resolved filter settings (curves, HSL bands, adjustments, etc.). */
  settings: ResolvedFilterSettings;
}

export interface RenderResult {
  output: ImageData;
  /** Backend that produced the result; useful for telemetry. */
  backend: PreviewBackendKind;
  /** True if the render was handled by a fallback path (e.g. context lost). */
  fellBack: boolean;
}

export type PreviewBackendKind = "js" | "webgl";

/**
 * Discriminated reason a render was rejected. The broker turns these
 * into `Promise.reject` so the call site can surface a user-visible
 * error if needed. Most renders should never reject — rejection means
 * the backend is broken (worker crashed, context lost without a JS
 * fallback, etc.) and we couldn't recover.
 */
export type RenderRejection =
  | { kind: "aborted" }
  | { kind: "context-lost" }
  | { kind: "unsupported-settings"; detail: string }
  | { kind: "worker-error"; message: string };

export type RenderOutcome =
  | { kind: "ok"; result: RenderResult }
  | { kind: "rejected"; reason: RenderRejection };

/**
 * A backend is a per-consumer render pipeline. It owns whatever
 * resources it needs (a worker, a WebGL context, an OffscreenCanvas)
 * and exposes a single `render` method. The broker calls `render`
 * with the latest in-flight job; if a newer job supersedes it, the
 * broker calls `cancel` and the backend should short-circuit.
 */
export interface PreviewBackend {
  readonly kind: PreviewBackendKind;
  /**
   * Render the request. The backend must check the abort signal
   * between top-level passes and return `aborted` rather than
   * completing the work. The returned Promise resolves to an
   * `ImageData` whose width/height match the source.
   */
  render(request: RenderRequest, signal: PreviewAbortSignal): Promise<ImageData>;
  /**
   * Tell the backend to drop whatever it's doing. After `cancel` the
   * backend is still usable; the next `render` should run cleanly.
   */
  cancel(): void;
  /**
   * Release all resources (terminate the worker, lose the WebGL
   * context). After `dispose` the backend cannot be used again.
   */
  dispose(): void;
}

export interface PreviewAbortSignal {
  readonly aborted: boolean;
}
