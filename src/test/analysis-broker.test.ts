import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAnalysis } from "@/lib/filterEngine";

interface PostedMessage {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

interface FakeAnalysisWorker {
  onmessage: ((event: MessageEvent<{ id: number; analysis: ImageAnalysis }>) => void) | null;
  onerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  posted: PostedMessage[];
}

const workers: FakeAnalysisWorker[] = [];

class MockAnalysisWorker {
  onmessage: ((event: MessageEvent<{ id: number; analysis: ImageAnalysis }>) => void) | null = null;
  onerror: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage = vi.fn((message: PostedMessage) => {
    this.posted.push(message);
  });
  posted: PostedMessage[] = [];

  constructor() {
    workers.push(this);
  }
}

function minimalAnalysis(): ImageAnalysis {
  return {
    width: 0,
    height: 0,
    pixelCount: 0,
    averageLuminance: 0,
    luminanceStdDev: 0,
    dynamicRange: 0,
    averageSaturation: 0,
    warmth: 0,
    highlightClipping: 0,
    shadowClipping: 0,
    histogram: { luminance: new Uint16Array(256) },
    channelHistogram: { r: new Uint16Array(256), g: new Uint16Array(256), b: new Uint16Array(256) },
    clippingChannels: {
      highlight: { r: false, g: false, b: false },
      shadow: { r: false, g: false, b: false },
    },
    portraitLikelihood: 0,
    indoorLikelihood: 0,
    outdoorLikelihood: 0,
    brightLikelihood: 0,
    lowLightLikelihood: 0,
    colorfulLikelihood: 0,
    flatLikelihood: 0,
    overexposedLikelihood: 0,
    underexposedLikelihood: 0,
    sceneTags: [],
  };
}

describe("analysis worker broker", () => {
  beforeEach(() => {
    workers.length = 0;
    Object.defineProperty(globalThis, "Worker", {
      writable: true,
      value: MockAnalysisWorker,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a single analysis worker across multiple calls", async () => {
    const { analyzeImageDataOnWorker, cancelPendingAnalysis } = await import("@/lib/analysis-worker");
    const p1 = analyzeImageDataOnWorker(new ImageData(2, 2));
    const p2 = analyzeImageDataOnWorker(new ImageData(4, 4));
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    expect(workers[0].posted[0].width).toBe(2);
    expect(workers[0].posted[0].height).toBe(2);

    workers[0].onmessage?.({ data: { id: 1, analysis: minimalAnalysis() } } as MessageEvent<{ id: number; analysis: ImageAnalysis }>);
    await p1;
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
    expect(workers[0].posted[1].width).toBe(4);

    workers[0].onmessage?.({ data: { id: 2, analysis: minimalAnalysis() } } as MessageEvent<{ id: number; analysis: ImageAnalysis }>);
    await p2;
    expect(workers).toHaveLength(1);
    cancelPendingAnalysis();
  });

  it("cancels pending analysis jobs without resolving them", async () => {
    const { analyzeImageDataOnWorker, cancelPendingAnalysis } = await import("@/lib/analysis-worker");
    let resolved = false;
    void analyzeImageDataOnWorker(new ImageData(2, 2)).then(() => {
      resolved = true;
    });
    cancelPendingAnalysis();
    workers[0].onmessage?.({ data: { id: 1, analysis: minimalAnalysis() } } as MessageEvent<{ id: number; analysis: ImageAnalysis }>);
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("rejects the failing job on worker error and continues draining the queue", async () => {
    const { analyzeImageDataOnWorker, cancelPendingAnalysis } = await import("@/lib/analysis-worker");
    const failed = vi.fn();
    const succeeded = vi.fn();
    const p1 = analyzeImageDataOnWorker(new ImageData(2, 2)).catch(failed);
    const p2 = analyzeImageDataOnWorker(new ImageData(4, 4)).then(succeeded);

    workers[0].onerror?.({ error: new Error("boom") } as unknown as MessageEvent<unknown>);
    await p1;
    expect(failed).toHaveBeenCalled();
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
    workers[0].onmessage?.({ data: { id: 2, analysis: minimalAnalysis() } } as MessageEvent<{ id: number; analysis: ImageAnalysis }>);
    await p2;
    expect(succeeded).toHaveBeenCalled();
    cancelPendingAnalysis();
  });
});
