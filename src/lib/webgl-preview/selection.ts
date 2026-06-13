/**
 * Backend selection. The broker asks this module which backend a
 * given consumer should use. The default policy is:
 *
 *   - `consumer: "preview"`  -> WebGL2 backend, falling back to JS
 *     on `webglcontextlost` or if the settings need a pass the
 *     WebGL shader doesn't yet implement (e.g. clarity/sharpness/bloom).
 *   - `consumer: "studio"`   -> JS engine (full-res float32 path,
 *     maximum quality).
 *   - `consumer: "export"`   -> JS engine (BottomBar's export pipeline).
 *   - anything else          -> JS engine.
 *
 * The selector is overridable for tests and for future feature flags
 * (e.g. "force WebGL on retina, force JS on low memory"). The
 * selected backend factory is called lazily by the broker on first
 * render, not at module load — this avoids paying the cost of
 * `OffscreenCanvas` allocation and WebGL context creation until
 * the user actually opens an image.
 */
import type { PreviewBackend, PreviewBackendKind } from "./types";
import type { ResolvedFilterSettings } from "@/lib/filterEngine";

export type BackendFactory = () => PreviewBackend;

export interface PreviewBackendPolicy {
  /**
   * Pick a backend for a (consumer, settings) pair. Returning a kind
   * that isn't supported by the host (e.g. `webgl` on a browser
   * without WebGL2) falls back to `"js"`.
   */
  select(consumer: string, settings: ResolvedFilterSettings): PreviewBackendKind;
  /**
   * Build a JS backend for a consumer. Used for the fallback path
   * when the WebGL context is lost, and as the default for studio /
   * export consumers.
   */
  createJsBackend(consumer: string): PreviewBackend;
  /**
   * Build a WebGL backend for a consumer. May return `null` if the
   * host can't provide a WebGL2 context (mobile Safari private mode,
   * headless test environments). The selector then returns "js".
   */
  createWebGlBackend(consumer: string): PreviewBackend | null;
}

/**
 * Check if a settings object has a non-zero value for one of the
 * passes the WebGL fragment shader doesn't currently implement.
 * When any of these are non-zero, the WebGL backend falls back to
 * the JS engine for that render so the user still sees the effect.
 */
export function settingsRequireBlurPasses(settings: ResolvedFilterSettings): boolean {
  const a = settings.adjustments;
  return a.clarity !== 0 || a.sharpness !== 0 || a.bloom !== 0;
}

/**
 * The default policy. WebGL for preview, JS for everything else.
 * Can be overridden via `setPreviewBackendPolicy` for tests and
 * feature flags.
 */
class DefaultPolicy implements PreviewBackendPolicy {
  select(consumer: string, settings: ResolvedFilterSettings): PreviewBackendKind {
    if (consumer === "preview") {
      // If the WebGL backend reported a context-lost event, fall
      // back to JS for the rest of the session. The broker
      // re-runs the selector on every render, so once the
      // context is restored (and `webglDegraded` is reset to
      // false) the next preview render will go back to WebGL.
      if (webglDegraded) return "js";
      // Defer to JS if the preview would need a blur-based pass
      // that the WebGL shader doesn't implement yet. The runtime
      // cost of falling back to JS for that one frame is much less
      // than the cost of silently dropping clarity / sharpness /
      // bloom on the preview.
      if (settingsRequireBlurPasses(settings)) return "js";
      return "webgl";
    }
    return "js";
  }
  // createJsBackend / createWebGlBackend are injected by
  // `setPreviewBackendPolicy` (see selection.ts entry point below).
  // The default policy uses the module-level factories, which the
  // broker wires up at startup.
  createJsBackend!: BackendFactory;
  createWebGlBackend!: BackendFactory;
}

let currentPolicy: PreviewBackendPolicy = new DefaultPolicy();

/**
 * A process-wide flag the `WebGlBackend` flips when it observes
 * `webglcontextlost`. The default policy checks this flag and
 * returns `"js"` for the preview consumer when it's set, so the
 * next render after a context-lost event automatically falls back
 * to the JS engine. The flag is reset when the context is
 * restored.
 *
 * Tests and feature flags can read this directly via
 * `isWebGlDegraded()` to assert fallback behavior.
 */
let webglDegraded = false;

export function setWebGlDegraded(degraded: boolean): void {
  webglDegraded = degraded;
}

export function isWebGlDegraded(): boolean {
  return webglDegraded;
}

/**
 * Replace the backend policy. Intended for tests and feature flags.
 * The next render for any consumer will use the new policy. In-flight
 * renders are not affected (they keep the backend that was selected
 * when they started).
 */
export function setPreviewBackendPolicy(policy: PreviewBackendPolicy): void {
  currentPolicy = policy;
}

export function getPreviewBackendPolicy(): PreviewBackendPolicy {
  return currentPolicy;
}
