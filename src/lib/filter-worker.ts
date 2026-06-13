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

/**
 * Tells the worker to abort the in-flight render for `id`. The worker
 * checks an internal abort flag between engine passes; if the flag is set,
 * the engine returns early and the worker posts an "aborted" response
 * (with no pixel data) so the broker can clear the in-flight slot.
 *
 * `id` must match the id of an outstanding render. If the worker has
 * already finished that render by the time this message is processed, the
 * abort is a no-op.
 */
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

interface Broker {
  worker: Worker | null;
  inFlight: RenderJob | null;
  pending: RenderJob | null; // latest superseded job, dispatched when the worker frees up
  nextId: number;
}

const broker: Broker = {
  worker: null,
  inFlight: null,
  pending: null,
  nextId: 1,
};

function createBrokerWorker(): Worker {
  const worker = createFilterWorker();
  worker.onmessage = (event: MessageEvent<WorkerToBroker>) => {
    const msg = event.data;
    if (msg.kind === "aborted") {
      // The worker finished an aborted render. Clear the in-flight slot
      // and dispatch whatever's pending. The cancelled job's promise is
      // never resolved (the user's newer render will be).
      if (broker.inFlight && broker.inFlight.id === msg.id) {
        broker.inFlight = null;
      }
      dispatchNext();
      return;
    }
    // msg.kind === "result"
    const job = broker.inFlight;
    if (!job || job.id !== msg.id) {
      // The result is for a job that was superseded or cancelled. The
      // worker's buffer has been transferred into this event but the
      // main thread doesn't need it; let it be GC'd by detaching via
      // a no-op Uint8ClampedArray view.
      // (We don't call .slice() — that would copy. The buffer is
      // already detached from the worker once postMessage returned.)
      return;
    }
    broker.inFlight = null;
    if (job.cancelled) {
      // The job was cancelled (e.g. image changed, component unmounted).
      // We drop the result and never resolve the promise.
      dispatchNext();
      return;
    }
    const result = new ImageData(
      new Uint8ClampedArray(msg.buffer),
      msg.width,
      msg.height,
    );
    job.resolve(result);
    dispatchNext();
  };
  worker.onerror = (event) => {
    const job = broker.inFlight;
    broker.inFlight = null;
    if (job && !job.cancelled) {
      job.reject(event.error ?? new Error("Worker render failed"));
    }
    // Continue draining; the next job may succeed.
    dispatchNext();
  };
  return worker;
}

function ensureWorker(): Worker {
  if (broker.worker) return broker.worker;
  broker.worker = createBrokerWorker();
  return broker.worker;
}

function postRender(worker: Worker, job: RenderJob): void {
  if (job.cancelled) {
    // Race: the job was cancelled before we could dispatch it.
    broker.inFlight = null;
    dispatchNext();
    return;
  }
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
  worker.postMessage(request, [buffer]);
}

function postAbort(worker: Worker, id: number): void {
  const abort: FilterWorkerAbort = { kind: "abort", id };
  worker.postMessage(abort);
}

/**
 * Pulls the next job to run. Called whenever the worker becomes free
 * (start of session, response received, error). Latest-wins semantics:
 * the most recent non-cancelled job is the one that runs.
 */
function dispatchNext(): void {
  if (broker.inFlight) return;
  const next = broker.pending;
  if (!next) return;
  broker.pending = null;
  if (next.cancelled) {
    dispatchNext();
    return;
  }
  broker.inFlight = next;
  const worker = ensureWorker();
  postRender(worker, next);
}

export function renderFilterOnWorker(
  sourceData: ImageData,
  settings: ResolvedFilterSettings,
): Promise<ImageData> {
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

    if (broker.inFlight) {
      // Latest-wins: the new job supersedes both the in-flight and
      // any already-pending job. Mark the in-flight as cancelled (its
      // result will be dropped when it arrives), tell the worker to
      // abort it, and queue the new job as pending.
      const superseded = broker.inFlight;
      superseded.cancelled = true;
      broker.inFlight = null;
      const worker = broker.worker ?? ensureWorker();
      postAbort(worker, superseded.id);
      if (broker.pending) {
        broker.pending.cancelled = true;
      }
      broker.pending = job;
    } else if (broker.pending) {
      // No in-flight (worker is between jobs) but a pending job is
      // already queued. Latest-wins: drop the older pending and queue
      // the new one. The pending job's promise is never resolved.
      broker.pending.cancelled = true;
      broker.pending = job;
    } else {
      broker.pending = job;
    }

    dispatchNext();
  });
}

/**
 * Drop all queued and in-flight jobs without resolving their promises.
 * Used when the caller (typically a React hook) is unmounting or about
 * to reset its source raster. Cancelled jobs are simply dropped when
 * the worker eventually responds.
 */
export function cancelPendingFilterRenders(): void {
  if (broker.pending) {
    broker.pending.cancelled = true;
    broker.pending = null;
  }
  if (broker.inFlight) {
    broker.inFlight.cancelled = true;
    // The worker is still processing. We don't send an abort here
    // because the next render request (if any) will replace this
    // in-flight and trigger the abort. The result, when it arrives,
    // is dropped by the cancelled check in onmessage.
  }
}
