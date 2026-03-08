import type { ResolvedFilterSettings } from "@/lib/filterEngine";

export interface FilterWorkerRequest {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  settings: ResolvedFilterSettings;
}

export interface FilterWorkerResponse {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export function createFilterWorker(): Worker {
  return new Worker(new URL("../workers/filterWorker.ts", import.meta.url), { type: "module" });
}

export function renderFilterOnWorker(
  sourceData: ImageData,
  settings: ResolvedFilterSettings,
): Promise<ImageData> {
  const worker = createFilterWorker();

  return new Promise((resolve, reject) => {
    const cleanup = () => worker.terminate();

    worker.onmessage = (event: MessageEvent<FilterWorkerResponse>) => {
      cleanup();
      resolve(new ImageData(new Uint8ClampedArray(event.data.buffer), event.data.width, event.data.height));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(event.error ?? new Error("Worker render failed"));
    };

    const buffer = sourceData.data.slice().buffer;
    const request: FilterWorkerRequest = {
      id: 1,
      width: sourceData.width,
      height: sourceData.height,
      buffer,
      settings,
    };

    worker.postMessage(request, [buffer]);
  });
}
