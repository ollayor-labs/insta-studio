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
import type { Adjustments, ResolvedFilterSettings } from "@/lib/filterEngine";

export type BackendFactory = () => PreviewBackend;

/**
 * Optional context the broker hands to a backend factory when
 * constructing it. The only field that varies per-consumer today
 * is `targetCanvas` (a caller-supplied canvas the WebGL backend
 * can render into to skip the readback). Future per-consumer
 * hints (e.g. a "this consumer is the visible preview" flag) can
 * land here without breaking the existing call sites.
 */
export interface BackendFactoryInit {
  /**
   * The canvas to render the WebGL preview directly into. When
   * provided, the WebGL backend uses it as its framebuffer and
   * skips `readPixels` -- the browser composites the canvas
   * without any CPU readback. This is the fast path for the
   * visible `ImageCanvas` element. The JS backend ignores this
   * field (it always returns `ImageData`).
   */
  targetCanvas?: HTMLCanvasElement | OffscreenCanvas | null;
}

export interface PreviewBackendPolicy {
  /**
   * Pick a backend for a (consumer, settings) pair. Returning a kind
   * that isn't supported by the host (e.g. `webgl` on a browser
   * without WebGL2) falls back to `"js"`.
   */
  select(consumer: string, settings: ResolvedFilterSettings, userAdjustments?: Adjustments): PreviewBackendKind;
  /**
   * Build a JS backend for a consumer. Used for the fallback path
   * when the WebGL context is lost, and as the default for studio /
   * export consumers.
   */
  createJsBackend(consumer: string, init?: BackendFactoryInit): PreviewBackend;
  /**
   * Build a WebGL backend for a consumer. May return `null` if the
   * host can't provide a WebGL2 context (mobile Safari private mode,
   * headless test environments). The selector then returns "js".
   * The `init.targetCanvas` field, when provided, switches the
   * backend into the canvas-bound fast path (no readback).
   */
  createWebGlBackend(consumer: string, init?: BackendFactoryInit): PreviewBackend | null;
}

/**
 * Check if a settings object has a non-zero value for one of the
 * passes the WebGL fragment shader doesn't currently implement.
 * When any of these are non-zero, the WebGL backend falls back to
 * the JS engine for that render so the user still sees the effect.
 */
/**
 * @param userAdjustments When provided, the *user-input* adjustments are
 *   consulted. This is the right thing for the broker selector, because
 *   the resolved `settings` may have had scene adaptation applied
 *   (`applySceneAdaptation` injects small non-zero clarity/bloom values
 *   for low-light, bright, or flat scenes) -- those are not user
 *   requests for a blur pass, and we don't want them to force every
 *   photo onto the JS engine. When omitted, falls back to the resolved
 *   settings (used by callers that don't have user input at hand, and
 *   by tests).
 */
export function settingsRequireBlurPasses(
  settings: ResolvedFilterSettings,
  userAdjustments?: Adjustments,
): boolean {
  const a = userAdjustments ?? settings.adjustments;
  return a.clarity !== 0 || a.sharpness !== 0 || a.bloom !== 0;
}

/**
 * Maximum number of HSL bands the WebGL fragment shader applies. The
 * JS engine has no such cap, so a preset that ships more bands than
 * this must fall back to the JS engine for the WebGL preview to
 * match. Keep in sync with `MAX_HSL_BANDS` in
 * `src/lib/webgl-preview/glsl/fragment.glsl`.
 */
export const WEBGL_MAX_HSL_BANDS = 8;

/**
 * Check whether a settings object has more HSL bands than the WebGL
 * shader supports. The selector returns `"js"` when this is true
 * so the user gets the full effect on the JS engine instead of a
 * silently truncated one.
 */
export function settingsExceedHslBandCap(settings: ResolvedFilterSettings): boolean {
  return settings.hsl.length > WEBGL_MAX_HSL_BANDS;
}

/**
 * The default policy. WebGL for preview, JS for everything else.
 * Can be overridden via `setPreviewBackendPolicy` for tests and
 * feature flags.
 */
class DefaultPolicy implements PreviewBackendPolicy {
  select(consumer: string, settings: ResolvedFilterSettings, userAdjustments?: Adjustments): PreviewBackendKind {
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
      // bloom on the preview. We pass the *user-input* adjustments
      // (when available) so scene adaptation's small non-zero
      // injections of clarity/bloom don't force every photo onto
      // the JS engine -- those aren't user requests for blur.
      if (settingsRequireBlurPasses(settings, userAdjustments)) return "js";
      // Defer to JS when the preset has more HSL bands than the WebGL
      // shader supports. The shader would silently drop the extras
      // and the user would see a partial effect; the JS engine
      // applies every band.
      if (settingsExceedHslBandCap(settings)) return "js";
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
 * `isWebGlDegraded()` to assert fallback behavior, or subscribe
 * to transitions via `subscribeToWebGlDegraded` instead of
 * polling the flag on a timer. The latter is the recommended
 * approach: it pushes the event to the consumer immediately
 * instead of waiting for the next 500ms tick.
 */
let webglDegraded = false;
const degradedSubscribers = new Set<(degraded: boolean) => void>();

export function setWebGlDegraded(degraded: boolean): void {
  if (webglDegraded === degraded) return;
  webglDegraded = degraded;
  for (const subscriber of degradedSubscribers) {
    try {
      subscriber(degraded);
    } catch (err) {
      // A subscriber throwing must not prevent the other
      // subscribers from running. Log and continue; the next
      // transition will fire the rest.
      console.error("[webgl-preview] degraded subscriber threw", err);
    }
  }
}

export function isWebGlDegraded(): boolean {
  return webglDegraded;
}

/**
 * Subscribe to WebGL-degraded transitions. The callback fires
 * synchronously whenever `setWebGlDegraded` flips the flag, and
 * also once on subscribe with the current value (so a freshly
 * mounted hook can sync its state without a separate read).
 *
 * Returns an unsubscribe function. Callers should call it on
 * unmount; otherwise the subscriber leaks for the lifetime of
 * the page. The set is small in practice (one entry from the
 * dev chip hook, maybe one from tests).
 */
export function subscribeToWebGlDegraded(callback: (degraded: boolean) => void): () => void {
  degradedSubscribers.add(callback);
  // Fire once with the current value so the caller doesn't have
  // to read the flag separately to bootstrap its state. Wrap in
  // try/catch so a buggy bootstrap callback (e.g. a React
  // subscription that calls a hook unconditionally) doesn't
  // leak the throw out of `subscribe` -- the rest of the
  // subscriber pipeline should still operate normally.
  try {
    callback(webglDegraded);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[webgl-preview] subscribeToWebGlDegraded bootstrap threw", err);
  }
  return () => {
    degradedSubscribers.delete(callback);
  };
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
