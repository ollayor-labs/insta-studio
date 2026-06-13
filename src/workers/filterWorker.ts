/// <reference lib="webworker" />

import { applyFilter } from "@/lib/filters";
import type {
  BrokerToWorker,
  FilterWorkerResult,
  FilterWorkerAborted,
} from "@/lib/filter-worker";

// One signal per active render, keyed by id. The broker sends an
// "abort" message to flip `aborted` on the corresponding signal; the
// engine reads it between top-level passes. We don't cancel
// in-progress passes — they're synchronous, so the abort takes effect
// on the next boundary check.
const activeSignals = new Map<number, { aborted: boolean }>();

self.onmessage = (event: MessageEvent<BrokerToWorker>) => {
  const msg = event.data;
  if (msg.kind === "abort") {
    const signal = activeSignals.get(msg.id);
    if (signal) signal.aborted = true;
    return;
  }

  // msg.kind === "render"
  const { id, width, height, buffer, settings } = msg;
  const signal = { aborted: false };
  activeSignals.set(id, signal);

  try {
    const pixels = new Uint8ClampedArray(buffer);
    applyFilter(pixels, width, height, settings, signal);

    if (signal.aborted) {
      // The engine short-circuited. The pixel buffer is in an
      // intermediate state; don't transfer it. Post the sentinel so
      // the broker knows the worker is free, then drop the buffer
      // (it goes out of scope and is GC'd).
      const response: FilterWorkerAborted = { kind: "aborted", id };
      self.postMessage(response);
      return;
    }

    const response: FilterWorkerResult = {
      kind: "result",
      id,
      width,
      height,
      buffer: pixels.buffer,
    };
    self.postMessage(response, [pixels.buffer]);
  } finally {
    activeSignals.delete(id);
  }
};
