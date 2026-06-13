import type { ImageAnalysis } from "@/lib/filterEngine";

export interface AnalysisRequest {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export interface AnalysisResponse {
  id: number;
  analysis: ImageAnalysis;
}

function createAnalysisWorker(): Worker {
  return new Worker(new URL("../workers/analysisWorker.ts", import.meta.url), { type: "module" });
}

interface AnalysisJob {
  source: ImageData;
  resolve: (result: ImageAnalysis) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

interface AnalysisBroker {
  worker: Worker | null;
  queue: AnalysisJob[];
  inFlight: AnalysisJob | null;
  nextId: number;
}

const broker: AnalysisBroker = {
  worker: null,
  queue: [],
  inFlight: null,
  nextId: 1,
};

function createBrokerWorker(): Worker {
  const worker = createAnalysisWorker();
  worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
    const job = broker.inFlight;
    broker.inFlight = null;
    flushQueue();
    if (!job || job.cancelled) return;
    job.resolve(event.data.analysis);
  };
  worker.onerror = (event) => {
    const job = broker.inFlight;
    broker.inFlight = null;
    if (job && !job.cancelled) {
      job.reject(event.error ?? new Error("Analysis worker failed"));
    }
    flushQueue();
  };
  return worker;
}

function postJob(worker: Worker, next: AnalysisJob): void {
  if (next.cancelled) {
    broker.inFlight = null;
    flushQueue();
    return;
  }
  const id = broker.nextId;
  broker.nextId += 1;
  const buffer = next.source.data.slice().buffer;
  const request: AnalysisRequest = {
    id,
    width: next.source.width,
    height: next.source.height,
    buffer,
  };
  worker.postMessage(request, [buffer]);
}

function flushQueue(): void {
  if (broker.inFlight) return;
  const next = broker.queue.shift();
  if (!next) return;
  broker.inFlight = next;
  // Same synchronous-dispatch contract as the filter broker: callers
  // enqueue + inspect the worker's posted messages in the same tick,
  // so the first post must not wait on a microtask.
  if (broker.worker) {
    postJob(broker.worker, next);
    return;
  }
  broker.worker = createBrokerWorker();
  postJob(broker.worker, next);
}

export function analyzeImageDataOnWorker(sourceData: ImageData): Promise<ImageAnalysis> {
  return new Promise<ImageAnalysis>((resolve, reject) => {
    const job: AnalysisJob = {
      source: sourceData,
      resolve,
      reject,
      cancelled: false,
    };
    broker.queue.push(job);
    flushQueue();
  });
}

export function cancelPendingAnalysis(): void {
  for (const job of broker.queue) {
    job.cancelled = true;
  }
  broker.queue.length = 0;
  if (broker.inFlight) {
    broker.inFlight.cancelled = true;
    broker.inFlight = null;
  }
}
