import type { ResolvedFilterSettings } from "@/lib/filterEngine";

// Message types --------------------------------------------------------------

/**
 * A "render" job: pixel data + resolved filter settings. The worker is
 * expected to mutate `buffer` in place (Uint8 path) or allocate a new
 * buffer (Float32 path) and post the result back.
 */
export interface FilterWorkerRequest {
  kind: "render";
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  settings: ResolvedFilterSettings;
}

export interface FilterWorkerAbort {
  kind: "abort";
  id: number;
}

export type BrokerToWorker = FilterWorkerRequest | FilterWorkerAbort;

/**
 * Successful render. `buffer` is a transferable ArrayBuffer; ownership
 * moves back to the main thread.
 */
export interface FilterWorkerResult {
  kind: "result";
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

/**
 * Sentinel posted by the worker when an in-flight render is aborted
 * between passes. The broker uses this to know it's safe to dispatch
 * the next job.
 */
export interface FilterWorkerAborted {
  kind: "aborted";
  id: number;
}

export type WorkerToBroker = FilterWorkerResult | FilterWorkerAborted;

// Worker factory -------------------------------------------------------------

export function createFilterWorker(): Worker {
  return new Worker(new URL("../workers/filterWorker.ts", import.meta.url), { type: "module" });
}

// Broker ---------------------------------------------------------------------

export interface RenderJob {
  id: number;
  source: ImageData;
  settings: ResolvedFilterSettings;
  resolve: (result: ImageData) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

interface PoolEntry {
  worker: Worker;
  inFlight: RenderJob | null;
}

interface Broker {
  /**
   * Per-consumer worker pools. Each consumer gets its own dedicated
   * worker and its own cancel-in-flight (latest-wins) semantics
   * within that worker. Different consumers run in parallel.
   *
   * The default consumer is `"default"`, used when callers don't
   * pass a `consumer` argument. The first call to renderFilterOnWorker
   * allocates a worker for `"default"` and reuses it for the rest
   * of the session.
   */
  byConsumer: Map<string, PoolEntry>;
  nextId: number;
  maxWorkers: number;
}

function defaultMaxWorkers(): number {
  if (typeof navigator === "undefined") return 2;
  const cores = navigator.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores - 1));
}

const broker: Broker = {
  byConsumer: new Map(),
  nextId: 1,
  maxWorkers: 0,
};

function attachWorkerHandlers(entry: PoolEntry): void {
  entry.worker.onmessage = (event: MessageEvent<WorkerToBroker>) => {
    const msg = event.data;
    const job = entry.inFlight;
    if (!job) return;
    if (msg.kind === "aborted") {
      // Only clear the slot if the abort is for the currently in-flight
      // job. A stale abort for an already-superseded job should be ignored.
      if (job.id === msg.id) entry.inFlight = null;
      return;
    }
    // Stale result for a job that no longer matches in-flight. Drop
    // the pixel data on the floor and leave in-flight alone — clearing
    // it here would clobber the live job that supersedes the stale one.
    if (job.id !== msg.id) return;
    entry.inFlight = null;
    if (job.cancelled) return;
    const result = new ImageData(
      new Uint8ClampedArray(msg.buffer),
      msg.width,
      msg.height,
    );
    job.resolve(result);
  };
  entry.worker.onerror = (event) => {
    const job = entry.inFlight;
    entry.inFlight = null;
    if (job && !job.cancelled) {
      job.reject(event.error ?? new Error("Worker render failed"));
    }
  };
}

// WebGL preview path (future) -------------------------------------------------
//
// Today every consumer runs on a dedicated JS filter worker. The broker is
// designed so that a single consumer can later be backed by a WebGL
// pipeline instead, with no API changes for the other consumers.
//
// Integration points in this file:
//
//   1. `getOrCreateConsumerEntry` is where a per-consumer backend is chosen.
//      When the WebGL preview path lands, this is the place to dispatch on
//      `consumer`: a "preview" consumer would resolve to a WebGL-backed
//      entry (offscreen canvas + fragment shader, or a WebGL2 worker),
//      while studio/export keep their JS workers for parity and
//      reproducibility.
//
//   2. The `PoolEntry` shape stays the same — the WebGL backend just needs
//      to honor the same `postMessage`/`onmessage` contract that the JS
//      worker exposes today, or be wrapped in a thin adapter.
//
//   3. The `entry.worker.onerror` handler in `attachWorkerHandlers` is the
//      single place that surfaces backend failure. A WebGL backend must
//      dispatch a synthetic `error` event here when it observes
//      `webglcontextlost` (the GPU process reset, the tab was backgrounded
//      too long, the driver crashed, etc.). The current handler rejects
//      the in-flight promise; a richer version can additionally evict the
//      entry, mark the consumer as "degraded," and pin it to the JS worker
//      for the rest of the session so the user sees something instead of a
//      hard failure. The eviction path in `getOrCreateConsumerEntry` will
//      then re-create a healthy worker the next time the consumer is
//      reused.
//
//   4. The `inFlight` slot already serves as the per-consumer latest-wins
//      gate for a WebGL backend too: a new render aborts the previous by
//      setting `cancelled = true`, and the backend can check that flag
//      between draw calls (or in the rAF callback) the same way the JS
//      engine checks it between engine passes.
//
//   5. The pool cap and eviction policy are backend-agnostic, so a WebGL
//      consumer is bounded the same way and competes for slots fairly.

function getOrCreateConsumerEntry(consumer: string): PoolEntry {
  let entry = broker.byConsumer.get(consumer);
  if (entry) return entry;
  if (broker.maxWorkers === 0) {
    broker.maxWorkers = defaultMaxWorkers();
  }
  if (broker.byConsumer.size >= broker.maxWorkers) {
    // Reuse the oldest consumer's entry as a fallback. This is a
    // last-resort path; the typical case is one consumer per worker
    // and the broker's callers stick to a small set of consumer
    // names. If we hit the cap, the oldest consumer's in-flight
    // gets aborted (it'll be picked up again on the next call).
    const [oldestConsumer, oldestEntry] = broker.byConsumer.entries().next().value as [string, PoolEntry];
    if (oldestEntry.inFlight) {
      oldestEntry.inFlight.cancelled = true;
      oldestEntry.worker.postMessage({ kind: "abort", id: oldestEntry.inFlight.id } satisfies FilterWorkerAbort);
    }
    oldestEntry.worker.terminate();
    broker.byConsumer.delete(oldestConsumer);
  }
  const worker = createFilterWorker();
  entry = { worker, inFlight: null };
  attachWorkerHandlers(entry);
  broker.byConsumer.set(consumer, entry);
  return entry;
}

function postRender(entry: PoolEntry, job: RenderJob): void {
  const id = job.id;
  const buffer = job.source.data.slice().buffer;
  const request: FilterWorkerRequest = {
    kind: "render",
    id,
    width: job.source.width,
    height: job.source.height,
    buffer,
    settings: job.settings,
  };
  entry.worker.postMessage(request, [buffer]);
}

function postAbort(entry: PoolEntry, id: number): void {
  const abort: FilterWorkerAbort = { kind: "abort", id };
  entry.worker.postMessage(abort);
}

/**
 * Configure the worker pool size (maximum number of consumers that
 * can have an in-flight render at once). Tests can pin this to a
 * known value. Production callers should leave the default alone.
 */
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
   * consumers get dedicated workers and run in parallel; the same
   * consumer's renders use cancel-in-flight (latest-wins) on its
   * dedicated worker.
   *
   * The default consumer is `"default"`; preview, studio, and export
   * pipelines pass distinct names so they can render concurrently.
   * With a small number of consumers, the broker stays at or under
   * its default cap; configureFilterWorkerPool can raise the cap
   * for higher concurrency.
   */
  consumer?: string;
}

export function renderFilterOnWorker(
  sourceData: ImageData,
  settings: ResolvedFilterSettings,
  options: RenderFilterOptions = {},
): Promise<ImageData> {
  const consumer = options.consumer ?? "default";
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

    const entry = getOrCreateConsumerEntry(consumer);

    // Latest-wins within a consumer: if there's an in-flight job
    // on this entry, abort it and replace with the new one.
    if (entry.inFlight) {
      entry.inFlight.cancelled = true;
      postAbort(entry, entry.inFlight.id);
    }
    entry.inFlight = job;
    postRender(entry, job);
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
      entry.inFlight = null;
    }
    return;
  }
  for (const entry of broker.byConsumer.values()) {
    if (entry.inFlight) {
      entry.inFlight.cancelled = true;
      entry.inFlight = null;
    }
  }
}
