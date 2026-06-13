/**
 * JS backend: delegates to the existing filter worker. This is the
 * path that BottomBar's export and the studio full-res render use
 * today, and it's the fallback path the WebGL backend routes to
 * when the context is lost or the settings need a blur-based pass.
 *
 * The backend is a thin adapter that owns a `Worker` and the
 * per-consumer latest-wins machinery that used to live in the
 * broker. Once the broker's per-consumer pool is the only place
 * that talks to `Worker` directly, the broker itself can be
 * simplified — but that's a follow-up refactor, not part of this
 * PR. This file isolates the worker chatter so the rest of the
 * preview stack doesn't need to know it exists.
 */
import type { PreviewAbortSignal, PreviewBackend } from "./types";
import type { RenderJob } from "@/lib/filter-worker";

export interface JsBackendInit {
  createFilterWorker: () => Worker;
  brokerWorkerType: typeof import("@/workers/filterWorker");
}

export class JsBackend implements PreviewBackend {
  readonly kind = "js" as const;
  private worker: Worker;
  private nextId = 1;
  private inFlight: RenderJob | null = null;

  constructor(init: JsBackendInit) {
    this.worker = init.createFilterWorker();
    this.worker.onmessage = (event) => this.onMessage(event);
  }

  render(request: import("./types").RenderRequest, signal: PreviewAbortSignal): Promise<ImageData> {
    return new Promise<ImageData>((resolve, reject) => {
      const job: RenderJob = {
        id: this.nextId++,
        source: request.source,
        settings: request.settings,
        resolve: (result) => {
          if (signal.aborted) {
            // Caller moved on. Drop the result on the floor.
            return;
          }
          resolve(result);
        },
        reject: (error) => reject(error),
        cancelled: false,
      };

      // Latest-wins within this backend: cancel any in-flight job and
      // start the new one. Mirrors the broker's behavior so the
      // preview slider's responsiveness doesn't regress when the
      // WebGL backend falls back to JS.
      if (this.inFlight) {
        this.inFlight.cancelled = true;
        this.worker.postMessage({ kind: "abort", id: this.inFlight.id });
      }
      this.inFlight = job;

      const buffer = job.source.data.slice().buffer;
      this.worker.postMessage(
        {
          kind: "render",
          id: job.id,
          width: job.source.width,
          height: job.source.height,
          buffer,
          settings: job.settings,
        },
        [buffer],
      );
    });
  }

  cancel(): void {
    if (this.inFlight) {
      this.inFlight.cancelled = true;
      this.worker.postMessage({ kind: "abort", id: this.inFlight.id });
      this.inFlight = null;
    }
  }

  dispose(): void {
    this.cancel();
    this.worker.terminate();
  }

  private onMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!this.inFlight) return;
    if (msg.kind === "aborted") {
      if (this.inFlight.id === msg.id) this.inFlight = null;
      return;
    }
    if (this.inFlight.id !== msg.id) return;
    const job = this.inFlight;
    this.inFlight = null;
    if (job.cancelled) return;
    const result = new ImageData(
      new Uint8ClampedArray(msg.buffer),
      msg.width,
      msg.height,
    );
    job.resolve(result);
  }
}
