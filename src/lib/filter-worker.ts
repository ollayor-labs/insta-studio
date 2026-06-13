import type { ResolvedFilterSettings } from '@/lib/filterEngine';
import type { PreviewAbortSignal, PreviewBackend, PreviewBackendKind, RenderRequest } from '@/lib/webgl-preview';
import {
  JsBackend,
  WebGlBackend,
  isWebGlPreviewSupported,
  isWebGlDegraded,
  setPreviewBackendPolicy as setPreviewBackendPolicyImpl,
  getPreviewBackendPolicy,
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

function createJsBackendForConsumer(_consumer: string): PreviewBackend {
  return new JsBackend({
    createFilterWorker,
    brokerWorkerType: undefined as never, // unused in the current backend impl
  });
}

function createWebGlBackendForConsumer(_consumer: string): PreviewBackend | null {
  if (!isWebGlPreviewSupported()) return null;
  return new WebGlBackend();
}

function getOrCreateConsumerEntry(consumer: string, settings: ResolvedFilterSettings): PoolEntry {
  let entry = broker.byConsumer.get(consumer);
  if (entry && !shouldEvictEntry(entry, settings)) {
    // Re-run the selector on every render so a context-lost ->
    // context-restored cycle (or a settings change that flips the
    // backend kind) re-selects the right backend. The cost is a
    // single function call per render; the benefit is correct
    // backend transitions without an explicit "promote/demote"
    // API on the broker.
    const wantedKind = getPreviewBackendPolicy().select(consumer, settings);
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
  // blur pass that the JS engine should handle). Build (or rebuild)
  // the entry.
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
  const wantedKind = policy.select(consumer, settings);
  let backend: PreviewBackend | null = null;
  let preferWebGl = false;
  if (wantedKind === 'webgl') {
    backend = policy.createWebGlBackend ? policy.createWebGlBackend(consumer) : createWebGlBackendForConsumer(consumer);
    preferWebGl = true;
  }
  if (!backend) {
    backend = policy.createJsBackend ? policy.createJsBackend(consumer) : createJsBackendForConsumer(consumer);
    preferWebGl = false;
  }

  entry = { backend, inFlight: null, preferWebGl };
  broker.byConsumer.set(consumer, entry);
  return entry;
}

/**
 * Decide whether the existing entry should be evicted and replaced.
 * The current policy is conservative: if the entry's backend is
 * WebGL and is reporting itself degraded (context lost), evict it
 * so the next render lands on a fresh JS backend.
 */
function shouldEvictEntry(entry: PoolEntry, _settings: ResolvedFilterSettings): boolean {
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
}

export function renderFilterOnWorker(
  sourceData: ImageData,
  settings: ResolvedFilterSettings,
  options: RenderFilterOptions = {},
): Promise<ImageData> {
  const consumer = options.consumer ?? 'default';
  return new Promise<ImageData>((resolve, reject) => {
    const job: RenderJob = {
      id: broker.nextId,
      source: sourceData,
      settings,
      resolve,
      reject,
      cancelled: false,
    };
    broker.nextId += 1;

    const entry = getOrCreateConsumerEntry(consumer, settings);

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
