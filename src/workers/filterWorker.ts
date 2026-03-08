/// <reference lib="webworker" />

import { applyFilter } from "@/lib/filters";
import type { FilterWorkerRequest, FilterWorkerResponse } from "@/lib/filter-worker";

self.onmessage = (event: MessageEvent<FilterWorkerRequest>) => {
  const { id, width, height, buffer, settings } = event.data;
  const pixels = new Uint8ClampedArray(buffer);

  applyFilter(pixels, width, height, settings);

  const response: FilterWorkerResponse = {
    id,
    width,
    height,
    buffer: pixels.buffer,
  };

  self.postMessage(response, [pixels.buffer]);
};
