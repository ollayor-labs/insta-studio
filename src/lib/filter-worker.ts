import type { Adjustments, ResolvedFilterSettings } from '@/lib/filterEngine';
import type { PreviewAbortSignal, PreviewBackend, PreviewBackendKind, RenderRequest } from '@/lib/webgl-preview';
import {
  JsBackend,
  WebGlBackend,
  isWebGlPreviewSupported,
  isWebGlDegraded,
  setPreviewBackendPolicy as setPreviewBackendPolicyImpl,
  getPreviewBackendPolicy,
  type BackendFactoryInit,
} from '@/lib/webgl-preview';

// Message types --------------------------------------------------------------
//
// The broker's external contract is unchanged from PR #1/#2: callers
// get back an `ImageData` Promise. Internally, the broker now talks
// to `PreviewBackend` instances (a JS worker backend or a WebGL
// fragment-shader backend) instead of raw `Worker`s. This isolates
// the broker from the renderer's transport (worker postMessage vs
// WebGL draw call) and is what makes the WebGL preview path
// possible without changing any caller.

export interface FilterWorkerRequest {
  kind: 'render';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  settings: ResolvedFilterSettings;
}

export interface FilterWorkerAbort {
  kind: 'abort';
  id: number;
}

export type BrokerToWorker = FilterWorkerRequest | FilterWorkerAbort;

export interface FilterWorkerResult {
  kind: 'result';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export interface FilterWorkerAborted {
  kind: 'aborted';
  id: number;
}

export type WorkerToBroker = FilterWorkerResult | FilterWorkerAborted;

// Worker factory -------------------------------------------------------------

export function createFilterWorker(): Worker {
  return new Worker(new URL('../workers/filterWorker.ts', import.meta.url), { type: 'module' });
}

// Re-export the RenderJob type for backends that need it.
export interface RenderJob {
  id: number;
  source: ImageData;
  settings: ResolvedFilterSettings;
  /**
   * The user's slider adjustments, before scene adaptation was
   * applied. Callers should pass the raw user input (or the
   * debounced slider state, which is the user's last settled
   * input -- not a scene-adapted value). The selector uses
   * this to decide between WebGL and JS for the "preview"
   * consumer, so scene-adaptation's small non-zero clarity/bloom
   * injections don't force every photo onto the JS engine.
   * Optional; when absent, the selector falls back to the
   * resolved settings' adjustments.
   */
  userAdjustments?: Adjustments;
  resolve: (result: ImageData) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

// Broker ---------------------------------------------------------------------

interface PoolEntry {
  /**
   * The backend that handles this consumer's renders. The broker
   * doesn't know or care whether this is a JS worker or a WebGL
   * context -- it just calls `render` and `cancel` on it. The
   * per-consumer isolation gives us latest-wins within a consumer
   * and parallelism across consumers for free.
   */
  backend: PreviewBackend;
  inFlight: RenderJob | null;
  /**
   * Tracks whether this entry's backend was created with WebGL.
   * On `webglcontextlost` the backend reports itself degraded; the
   * broker re-runs the selector for future jobs so they land on
   * a fresh JS backend instead of the dead WebGL one.
   */
  preferWebGl: boolean;
  /**
   * The canvas ref this entry's backend was constructed with, or
   * `null` for the legacy `defaultAcquireContext()` path. Tracked
   * so the broker can detect "same consumer, new canvas ref"
   * (e.g. `ImageCanvas` remounted, or the user switched to a
   * different preview element) and evict the stale backend --
   * its WebGL resources are tied to the old canvas. The broker
   * already evicts on context loss via `shouldEvictEntry`; this
   * is the canvas-ref-change equivalent for the fast path.
   */
  targetCanvas: HTMLCanvasElement | OffscreenCanvas | null;
}

interface Broker {
  byConsumer: Map<string, PoolEntry>;
  nextId: number;
  maxWorkers: number;
}

function defaultMaxWorkers(): number {
  if (typeof navigator === 'undefined') return 2;
  const cores = navigator.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores - 1));
}

const broker: Broker = {
  byConsumer: new Map(),
  nextId: 1,
  maxWorkers: 0,
};

function createJsBackendForConsumer(_consumer: string, _init?: BackendFactoryInit): PreviewBackend {
  return new JsBackend({
    createFilterWorker,
    brokerWorkerType: undefined as never, // unused in the current backend impl
  });
}

function createWebGlBackendForConsumer(_consumer: string, init?: BackendFactoryInit): PreviewBackend | null {
  if (!isWebGlPreviewSupported()) return null;
  return new WebGlBackend({ targetCanvas: init?.targetCanvas ?? null });
}

function getOrCreateConsumerEntry(
  consumer: string,
  settings: ResolvedFilterSettings,
  userAdjustments: Adjustments | undefined,
  init: BackendFactoryInit,
): PoolEntry {
  let entry = broker.byConsumer.get(consumer);
  if (entry && !shouldEvictEntry(entry, settings, init.targetCanvas ?? null)) {
    // Re-run the selector on every render so a context-lost ->
    // context-restored cycle (or a settings change that flips the
    // backend kind) re-selects the right backend. The cost is a
    // single function call per render; the benefit is correct
    // backend transitions without an explicit "promote/demote"
    // API on the broker.
    const wantedKind = getPreviewBackendPolicy().select(consumer, settings, userAdjustments);
    if (wantedKind !== entry.backend.kind) {
      // Selector wants a different backend than what's cached.
      // Tear down the old entry and fall through to build a new
      // one.
      entry.backend.dispose();
      broker.byConsumer.delete(consumer);
    } else {
      return entry;
    }
  }

  // No entry yet, or the existing entry's backend can no longer
  // serve the request (e.g. WebGL context lost, settings need a
  // blur pass that the JS engine should handle, or the caller
  // handed us a new canvas ref). Build (or rebuild) the entry.
  if (entry) {
    entry.backend.dispose();
    broker.byConsumer.delete(consumer);
  }

  if (broker.maxWorkers === 0) {
    broker.maxWorkers = defaultMaxWorkers();
  }
  if (broker.byConsumer.size >= broker.maxWorkers) {
    // Pool cap reached. Evict the oldest entry to make room.
    const [oldestConsumer, oldestEntry] = broker.byConsumer.entries().next().value as [string, PoolEntry];
    oldestEntry.backend.cancel();
    oldestEntry.backend.dispose();
    broker.byConsumer.delete(oldestConsumer);
  }

  const policy = getPreviewBackendPolicy();
  const wantedKind = policy.select(consumer, settings, userAdjustments);
  let backend: PreviewBackend | null = null;
  let preferWebGl = false;
  if (wantedKind === 'webgl') {
    backend = policy.createWebGlBackend
      ? policy.createWebGlBackend(consumer, init)
      : createWebGlBackendForConsumer(consumer, init);
    preferWebGl = true;
  }
  if (!backend) {
    backend = policy.createJsBackend
      ? policy.createJsBackend(consumer, init)
      : createJsBackendForConsumer(consumer, init);
    preferWebGl = false;
  }

  entry = { backend, inFlight: null, preferWebGl, targetCanvas: init.targetCanvas ?? null };
  broker.byConsumer.set(consumer, entry);
  return entry;
}

/**
 * Decide whether the existing entry should be evicted and replaced.
 * The current policy is conservative: if the entry's backend is
 * WebGL and is reporting itself degraded (context lost), evict it
 * so the next render lands on a fresh JS backend. Also evict
 * when the caller hands us a canvas ref different from the one
 * the entry was constructed with -- the WebGL resources are tied
 * to the old canvas, and keeping them alive would leak contexts.
 */
function shouldEvictEntry(
  entry: PoolEntry,
  _settings: ResolvedFilterSettings,
  requestedCanvas: HTMLCanvasElement | OffscreenCanvas | null,
): boolean {
  // Canvas-ref change detection for the fast path. A `null` on the
  // entry but a non-null `requestedCanvas` (or vice versa) also
  // counts as a change, because the entry's `targetCanvas` is
  // locked in at construction time. Strict reference equality is
  // the right check: the broker only ever hands the SAME canvas
  // back across renders when the caller is reusing it (the common
  // case in `ImageCanvas` where the canvas ref is stable across
  // slider changes).
  if (entry.targetCanvas !== requestedCanvas) return true;
  if (entry.preferWebGl && entry.backend.kind === 'webgl') {
    // The WebGlBackend exposes isDegraded() to report a context
    // loss (per-instance flag flipped in onContextLost). The
    // module-level webglDegraded flag is the process-wide signal
    // that the default policy's select consults; we honor both
    // here so test backends (which may not implement isDegraded)
    // still trigger the JS fallback after a simulated
    // webglcontextlost.
    if (isWebGlDegraded()) return true;
    const backend = entry.backend as WebGlBackend & { isDegraded?: () => boolean };
    if (typeof backend.isDegraded === 'function' && backend.isDegraded()) {
      return true;
    }
  }
  return false;
}

export function configureFilterWorkerPool(maxWorkers: number): void {
  const clamped = Math.max(1, Math.min(8, Math.floor(maxWorkers)));
  broker.maxWorkers = clamped;
}

export function getFilterWorkerPoolSize(): number {
  return broker.maxWorkers === 0 ? defaultMaxWorkers() : broker.maxWorkers;
}

export interface RenderFilterOptions {
  /**
   * Identifier for the consumer requesting this render. Different
   * consumers get dedicated backends and run in parallel; the same
   * consumer's renders use cancel-in-flight (latest-wins) on its
   * dedicated backend. The default consumer is `"default"`.
   *
   * The preview hook uses `"preview"`, the studio view uses
   * `"studio"`, and the bottom bar's export pipeline uses
   * `"export"`. With three consumers the pool is at its default
   * cap; `configureFilterWorkerPool` can raise the cap for higher
   * concurrency.
   */
  consumer?: string;
  /**
   * The user's *input* adjustments, before scene adaptation was
   * applied. When the broker selects a backend for the "preview"
   * consumer, it consults this to decide whether the user
   * actually asked for a blur-based pass. Without it, the
   * selector falls back to the resolved settings' adjustments,
   * which include scene adaptation's small injections of
   * clarity/bloom and would force every photo onto the JS
   * engine. Pass this from any caller that goes through
   * `prepareFilterSettings` with `adaptToScene: true`.
   */
  userAdjustments?: Adjustments;
  /**
   * Optional canvas the WebGL backend should render directly
   * into. When provided, the backend uses this canvas as its
   * framebuffer and skips `readPixels` -- the browser composites
   * the canvas without any CPU readback. This is the fast path
   * for the visible `ImageCanvas` element.
   *
   * The broker tracks which canvas ref each consumer's backend
   * was constructed with, and evicts the cached backend if the
   * caller hands in a different canvas (e.g. `ImageCanvas`
   * remounted). The JS backend ignores this field.
   */
  targetCanvas?: HTMLCanvasElement | OffscreenCanvas | null;
}

export function renderFilterOnWorker(
  sourceData: ImageData,
  settings: ResolvedFilterSettings,
  options: RenderFilterOptions = {},
): Promise<ImageData> {
  const consumer = options.consumer ?? 'default';
  const init: BackendFactoryInit = { targetCanvas: options.targetCanvas ?? null };
  return new Promise<ImageData>((resolve, reject) => {
    const job: RenderJob = {
      id: broker.nextId,
      source: sourceData,
      settings,
      userAdjustments: options.userAdjustments,
      resolve,
      reject,
      cancelled: false,
    };
    broker.nextId += 1;

    const entry = getOrCreateConsumerEntry(consumer, settings, options.userAdjustments, init);

    // Latest-wins within a consumer: if there's an in-flight job
    // on this entry, cancel it (the backend short-circuits) and
    // replace with the new one.
    if (entry.inFlight) {
      entry.inFlight.cancelled = true;
      entry.backend.cancel();
    }
    entry.inFlight = job;

    const signal: PreviewAbortSignal = {
      get aborted() {
        return job.cancelled;
      },
    };
    const request: RenderRequest = { source: sourceData, settings };

    entry.backend.render(request, signal).then(
      (result) => {
        if (entry.inFlight !== job) return; // superseded
        entry.inFlight = null;
        if (job.cancelled) return;
        resolve(result);
      },
      (error: Error) => {
        if (entry.inFlight !== job) return; // superseded
        entry.inFlight = null;
        if (job.cancelled) return;
        reject(error);
      },
    );
  });
}

/**
 * Drop all in-flight jobs for a consumer (or all consumers if none
 * is given) without resolving their promises. Used when a React
 * hook unmounts or the source raster resets.
 */
export function cancelPendingFilterRenders(consumer?: string): void {
  if (consumer) {
    const entry = broker.byConsumer.get(consumer);
    if (entry?.inFlight) {
      entry.inFlight.cancelled = true;
      entry.backend.cancel();
      entry.inFlight = null;
    }
    return;
  }
  for (const entry of broker.byConsumer.values()) {
    if (entry.inFlight) {
      entry.inFlight.cancelled = true;
      entry.backend.cancel();
      entry.inFlight = null;
    }
  }
}

/**
 * Replace the preview backend policy. Tests and feature flags can
 * use this to force "js" for a particular consumer, or to inject
 * custom backend factories (e.g. a stub backend that records every
 * render call). The next render for any consumer will use the new
 * policy; in-flight renders keep the backend that was selected
 * when they started.
 */
export function setPreviewBackendPolicy(policy: import('@/lib/webgl-preview').PreviewBackendPolicy): void {
  setPreviewBackendPolicyImpl(policy);
}

/**
 * Inspect which backend a given consumer is currently using. Tests
 * and dev tools can call this to verify backend selection (e.g.
 * that `consumer: "preview"` resolves to `"webgl"` on a supported
 * host, or `"js"` on a host without WebGL2).
 */
export function getConsumerBackendKind(consumer: string): PreviewBackendKind | null {
  const entry = broker.byConsumer.get(consumer);
  return entry ? entry.backend.kind : null;
}
