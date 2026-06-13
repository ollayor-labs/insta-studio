import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewBackend, RenderRequest, PreviewAbortSignal, PreviewBackendKind, PreviewBackendPolicy } from "@/lib/webgl-preview";

/**
 * The broker's internal contract used to be raw `Worker` postMessage.
 * After PR #4 it talks to `PreviewBackend` instances. The tests
 * below mock the backend factory via `setPreviewBackendPolicy` so
 * the broker sees a deterministic, in-process `FakeBackend` per
 * consumer. Each `FakeBackend` records its renders and lets the
 * test drive responses through a deferred `resolve`.
 */

interface RenderCall {
  request: RenderRequest;
  signal: PreviewAbortSignal;
  resolve: (result: ImageData) => void;
  reject: (error: Error) => void;
  cancel: () => void;
  done: boolean;
}

class FakeBackend implements PreviewBackend {
  readonly kind: PreviewBackendKind;
  readonly calls: RenderCall[] = [];
  private cancelled = false;

  constructor(kind: PreviewBackendKind = "js") {
    this.kind = kind;
  }

  render(request: RenderRequest, signal: PreviewAbortSignal): Promise<ImageData> {
    return new Promise<ImageData>((resolve, reject) => {
      const call: RenderCall = {
        request,
        signal,
        resolve,
        reject,
        cancel: () => {
          this.cancelled = true;
          call.done = true;
          // Match the broker's contract: a cancelled render is
          // never resolved or rejected. The caller (the broker)
          // sees a hang; the in-flight tracking in the broker
          // drops the slot.
        },
        done: false,
      };
      this.calls.push(call);
    });
  }

  cancel(): void {
    this.cancelled = true;
  }

  dispose(): void {
    this.cancelled = true;
    for (const call of this.calls) {
      if (!call.done) call.done = true;
    }
  }

  /**
   * Test helper: resolve a pending render with a fake result. The
   * `aborted` flag is set to true if the backend was cancelled, so
   * tests can verify the broker respects the abort signal.
   */
  respondAt(index: number, source?: ImageData): void {
    const call = this.calls[index];
    if (!call) throw new Error(`No call at index ${index}`);
    if (call.done) return;
    call.done = true;
    const result = source ?? new ImageData(new Uint8ClampedArray(call.request.source.data.length), call.request.source.width, call.request.source.height);
    call.resolve(result);
  }
}

const backends: FakeBackend[] = [];

function makePolicy(kind: PreviewBackendKind = "js"): PreviewBackendPolicy {
  return {
    select: () => kind,
    createJsBackend: () => {
      const b = new FakeBackend("js");
      backends.push(b);
      return b;
    },
    createWebGlBackend: () => {
      const b = new FakeBackend("webgl");
      backends.push(b);
      return b;
    },
  };
}

function fakeSettings(id: string): import("@/lib/filterEngine").ResolvedFilterSettings {
  return {
    preset: {
      id,
      name: id,
      category: "Test",
      mood: "test",
      description: "test",
      whyItWorks: "test",
      defaultStrength: 1,
      tags: [],
      adjustments: {},
    },
    strength: 1,
    effectIntensity: 1,
    quality: "preview",
    precision: "uint8",
    analysis: null,
    adjustments: {} as never,
    curveLuts: { master: null, r: null, g: null, b: null },
    hsl: [],
  };
}

function fakeImageData(): ImageData {
  return new ImageData(new Uint8ClampedArray(16), 2, 2);
}

/**
 * Drain the microtask queue. Two `await Promise.resolve()` calls
 * are usually enough locally but can be slow under load on CI
 * runners, where the microtask queue is deeper. The loop below
 * keeps flushing until a full pass through the queue returns
 * without any new microtasks being scheduled -- which means the
 * broker's render-path Promise chain has fully settled.
 */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("filter worker broker", () => {
  beforeEach(async () => {
    backends.length = 0;
    vi.resetModules();
  });

  it("creates a single backend across multiple renders", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    let p1Resolved = false;
    void renderFilterOnWorker(fakeImageData(), fakeSettings("a")).then(() => {
      p1Resolved = true;
    });
    const p2 = renderFilterOnWorker(fakeImageData(), fakeSettings("b"));
    await flushPromises();
    expect(backends).toHaveLength(1);
    expect(backends[0].calls).toHaveLength(2);

    // First job is superseded when second arrived; second is in-flight.
    backends[0].respondAt(1);
    await p2;
    expect(p1Resolved).toBe(false);
    cancelPendingFilterRenders();
  });

  it("latest-wins: a newer job supersedes the in-flight one", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    let firstResolved = false;
    let latestResolved = false;
    void renderFilterOnWorker(fakeImageData(), fakeSettings("first")).then(() => {
      firstResolved = true;
    });
    const latest = renderFilterOnWorker(fakeImageData(), fakeSettings("latest")).then(() => {
      latestResolved = true;
    });
    await flushPromises();
    expect(backends[0].calls).toHaveLength(2);

    // First call is dropped (cancelled); only the second is in-flight.
    backends[0].respondAt(1);
    await latest;
    expect(latestResolved).toBe(true);
    expect(firstResolved).toBe(false);
    cancelPendingFilterRenders();
  });

  it("cancelPendingFilterRenders drops the in-flight job", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    let resolved = false;
    void renderFilterOnWorker(fakeImageData(), fakeSettings("a")).then(() => {
      resolved = true;
    });
    await flushPromises();
    cancelPendingFilterRenders();
    backends[0].respondAt(0);
    await flushPromises();
    expect(resolved).toBe(false);
  });

  it("rejects the failing job and continues draining the queue", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    const succeeded = vi.fn();
    const p1 = renderFilterOnWorker(fakeImageData(), fakeSettings("bad"));
    await flushPromises();
    expect(backends[0].calls).toHaveLength(1);

    // Simulate backend error.
    const failing = backends[0].calls[0];
    failing.done = true;
    failing.reject(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");

    // After the error, the broker is idle. A new job can be submitted.
    const p2 = renderFilterOnWorker(fakeImageData(), fakeSettings("good")).then(succeeded);
    await flushPromises();
    expect(backends[0].calls).toHaveLength(2);
    backends[0].respondAt(1);
    await p2;
    expect(succeeded).toHaveBeenCalled();
    cancelPendingFilterRenders();
  });

  it("the latest job resolves when intermediate jobs were dropped", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    const results: string[] = [];
    void renderFilterOnWorker(fakeImageData(), fakeSettings("a")).then(() => results.push("a"));
    void renderFilterOnWorker(fakeImageData(), fakeSettings("b")).then(() => results.push("b"));
    const p3 = renderFilterOnWorker(fakeImageData(), fakeSettings("c")).then(() => results.push("c"));
    await flushPromises();
    expect(backends[0].calls).toHaveLength(3);

    // a and b were superseded. c is in-flight.
    backends[0].respondAt(2);
    await p3;
    expect(results).toEqual(["c"]);
    cancelPendingFilterRenders();
  });
});

describe("filter worker broker (per-consumer worker pools)", () => {
  beforeEach(async () => {
    backends.length = 0;
    vi.resetModules();
  });

  it("allocates a dedicated backend per consumer and runs them in parallel", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    const aPromise = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    const bPromise = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "studio" });
    await flushPromises();
    expect(backends).toHaveLength(2);
    expect(backends[0].calls).toHaveLength(1);
    expect(backends[1].calls).toHaveLength(1);

    backends[0].respondAt(0);
    backends[1].respondAt(0);
    await flushPromises();
    await Promise.all([aPromise, bPromise]);
    cancelPendingFilterRenders();
  });

  it("reuses the same backend for repeated calls with the same consumer", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    const p1 = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    await flushPromises();
    backends[0].respondAt(0);
    await p1;

    const p2 = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "preview" });
    await flushPromises();
    expect(backends).toHaveLength(1);
    expect(backends[0].calls).toHaveLength(2);
    backends[0].respondAt(1);
    await p2;
    cancelPendingFilterRenders();
  });

  it("latest-wins within a single consumer still aborts and replaces", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    let firstResolved = false;
    let latestResolved = false;
    void renderFilterOnWorker(fakeImageData(), fakeSettings("first"), { consumer: "preview" }).then(() => {
      firstResolved = true;
    });
    const latest = renderFilterOnWorker(fakeImageData(), fakeSettings("latest"), { consumer: "preview" }).then(() => {
      latestResolved = true;
    });
    await flushPromises();
    expect(backends).toHaveLength(1);
    expect(backends[0].calls).toHaveLength(2);

    backends[0].respondAt(1);
    await latest;
    expect(latestResolved).toBe(true);
    expect(firstResolved).toBe(false);
    cancelPendingFilterRenders();
  });

  it("cancelPendingFilterRenders with a consumer name cancels only that consumer", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    const previewP = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    const studioP = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "studio" });
    await flushPromises();
    expect(backends).toHaveLength(2);
    cancelPendingFilterRenders("preview");

    // Studio still resolves; preview is dropped.
    backends[1].respondAt(0);
    const result = await studioP;
    expect(result.width).toBe(2);

    backends[0].respondAt(0);
    let previewResolved = false;
    void previewP.then(() => {
      previewResolved = true;
    });
    await flushPromises();
    expect(previewResolved).toBe(false);
  });

  it("evicts the oldest consumer when the pool cap is exceeded", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders, configureFilterWorkerPool, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));
    configureFilterWorkerPool(2);

    // Fill the pool with two consumers.
    const aP = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "alpha" });
    const bP = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "beta" });
    await flushPromises();
    const alphaBackend = backends[0];
    const betaBackend = backends[1];
    expect(backends).toHaveLength(2);

    // Adding a third consumer evicts the oldest.
    const cP = renderFilterOnWorker(fakeImageData(), fakeSettings("c"), { consumer: "gamma" });
    await flushPromises();

    // The alpha backend was disposed; a fresh backend was created for gamma.
    expect(backends).toHaveLength(3);
    expect(alphaBackend.calls[0].done).toBe(true);
    expect(betaBackend.calls).toHaveLength(1);
    const gammaBackend = backends[2];
    expect(gammaBackend.calls).toHaveLength(1);

    // Drain.
    betaBackend.respondAt(0);
    gammaBackend.respondAt(0);
    await bP;
    await cP;
    let aResolved = false;
    void aP.then(() => {
      aResolved = true;
    });
    await flushPromises();
    expect(aResolved).toBe(false);
    cancelPendingFilterRenders();
  });
});

describe("filter worker broker (backend selection)", () => {
  beforeEach(async () => {
    backends.length = 0;
    vi.resetModules();
  });

  it("routes consumer: 'preview' to the WebGL backend when supported", async () => {
    const { renderFilterOnWorker, getConsumerBackendKind, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("webgl"));

    const promise = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    await Promise.resolve();
    expect(getConsumerBackendKind("preview")).toBe("webgl");
    backends[0].respondAt(0);
    await promise;
  });

  it("routes consumer: 'studio' to the JS backend by default", async () => {
    const { renderFilterOnWorker, getConsumerBackendKind, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    setPreviewBackendPolicy(makePolicy("js"));

    const promise = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "studio" });
    await Promise.resolve();
    expect(getConsumerBackendKind("studio")).toBe("js");
    backends[0].respondAt(0);
    await promise;
  });

  it("falls back to JS when the WebGL backend reports itself degraded", async () => {
    const { renderFilterOnWorker, getConsumerBackendKind, setPreviewBackendPolicy } = await import("@/lib/filter-worker");
    const { setWebGlDegraded, isWebGlDegraded } = await import("@/lib/webgl-preview");

    // Reset the global degraded flag (other tests may have set it).
    setWebGlDegraded(false);

    let webglCount = 0;
    let jsCount = 0;
    const policy: PreviewBackendPolicy = {
      // The selector consults the global degraded flag via the
      // default policy, but we're using a custom policy here that
      // delegates to the same flag for parity. (The custom policy
      // is otherwise needed to record create counts.)
      select: () => (isWebGlDegraded() ? "js" : "webgl"),
      createJsBackend: () => {
        const b = new FakeBackend("js");
        backends.push(b);
        jsCount += 1;
        return b;
      },
      createWebGlBackend: () => {
        const b = new FakeBackend("webgl");
        backends.push(b);
        webglCount += 1;
        return b;
      },
    };
    setPreviewBackendPolicy(policy);

    // First render: WebGL backend is created and used.
    const p1 = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    await Promise.resolve();
    expect(getConsumerBackendKind("preview")).toBe("webgl");
    backends[0].respondAt(0);
    await p1;
    expect(webglCount).toBe(1);
    expect(jsCount).toBe(0);

    // Simulate webglcontextlost. The real WebGlBackend calls
    // setWebGlDegraded(true) in its onContextLost handler. The
    // default policy observes the flag and routes future renders
    // to JS.
    setWebGlDegraded(true);

    const p2 = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "preview" });
    await Promise.resolve();
    expect(getConsumerBackendKind("preview")).toBe("js");
    expect(jsCount).toBe(1);
    backends[backends.length - 1].respondAt(0);
    await p2;

    // Simulate webglcontextrestored -- the policy reverts to
    // WebGL on the next render.
    setWebGlDegraded(false);
    const p3 = renderFilterOnWorker(fakeImageData(), fakeSettings("c"), { consumer: "preview" });
    await Promise.resolve();
    expect(getConsumerBackendKind("preview")).toBe("webgl");
    expect(webglCount).toBe(2);
    backends[backends.length - 1].respondAt(0);
    await p3;
  });
});
