/// <reference lib="webworker" />

import { analyzeImageData } from "@/lib/filter-engine/analysis";
import type { AnalysisRequest, AnalysisResponse } from "@/lib/analysis-worker";

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { id, width, height, buffer } = event.data;
  const pixels = new Uint8ClampedArray(buffer);
  const imageData = new ImageData(pixels, width, height);
  const analysis = analyzeImageData(imageData);

  const response: AnalysisResponse = {
    id,
    analysis,
  };

  // The analysis allocates several typed arrays (histograms). We can't
  // structured-clone them through `transfer` because they don't implement
  // the Transferable interface, but cloning is cheap relative to the
  // analysis cost.
  self.postMessage(response);
};
