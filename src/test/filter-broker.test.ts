import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PostedMessage =
  | {
      kind: "render";
      id: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
      settings: { preset: { id: string } };
    }
  | { kind: "abort"; id: number };

type IncomingMessage =
  | { kind: "result"; id: number; width: number; height: number; buffer: ArrayBuffer }
  | { kind: "aborted"; id: number };

interface FakeWorker {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
  onerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  posted: PostedMessage[];
}

const workers: FakeWorker[] = [];

class MockWorker {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null = null;
  onerror: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage = vi.fn((message: PostedMessage, _transfer: Transferable[]) => {
    this.posted.push(message);
  });
  terminate = vi.fn();
  posted: PostedMessage[] = [];

  constructor() {
    workers.push(this);
  }
}

function respond(worker: FakeWorker, id: number, width = 2, height = 2) {
  const buffer = new ArrayBuffer(16);
  worker.onmessage?.({
    data: { kind: "result", id, width, height, buffer },
  } as MessageEvent<IncomingMessage>);
}

function respondAborted(worker: FakeWorker, id: number) {
  worker.onmessage?.({
    data: { kind: "aborted", id },
  } as MessageEvent<IncomingMessage>);
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

describe("filter worker broker", () => {
  beforeEach(async () => {
    workers.length = 0;
    Object.defineProperty(globalThis, "Worker", {
      writable: true,
      value: MockWorker,
    });
    vi.resetModules();
  });

  // Pin the pool to a single worker for the single-render cases below
  // so PR #2's latest-wins behavior stays deterministic. A separate
  // describe block tests the per-consumer pool behavior.
  beforeEach(async () => {
    const { configureFilterWorkerPool } = await import("@/lib/filter-worker");
    configureFilterWorkerPool(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a single worker across multiple renders", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    let p1Resolved = false;
    renderFilterOnWorker(fakeImageData(), fakeSettings("a")).then(() => {
      p1Resolved = true;
    });
    const promise2 = renderFilterOnWorker(fakeImageData(), fakeSettings("b"));
    expect(workers).toHaveLength(1);
    // First job posts a render; second job arrives while first is
    // in flight and supersedes it, so the broker posts abort + render.
    expect(workers[0].posted.map((m) => m.kind)).toEqual(["render", "abort", "render"]);

    // The first job's result is dropped (it was superseded).
    respond(workers[0], 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(p1Resolved).toBe(false);

    expect(workers[0].posted.filter((m) => m.kind === "render")).toHaveLength(2);
    respond(workers[0], 2);
    await promise2;
    expect(workers).toHaveLength(1);
    cancelPendingFilterRenders();
  });

  it("latest-wins: a newer job supersedes the in-flight one", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    let firstResolved = false;
    let latestResolved = false;
    renderFilterOnWorker(fakeImageData(), fakeSettings("first")).then(() => {
      firstResolved = true;
    });
    const latest = renderFilterOnWorker(fakeImageData(), fakeSettings("latest")).then(() => {
      latestResolved = true;
    });

    // First render is in flight. Second job supersedes; broker posts
    // abort for first and render for second.
    expect(workers[0].posted.map((m) => m.kind)).toEqual(["render", "abort", "render"]);

    // First job is dropped when its (eventual) result arrives.
    respond(workers[0], 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstResolved).toBe(false);

    // Second job resolves.
    respond(workers[0], 2);
    await latest;
    expect(latestResolved).toBe(true);
    cancelPendingFilterRenders();
  });

  it("worker 'aborted' sentinel clears the in-flight slot", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    let firstResolved = false;
    renderFilterOnWorker(fakeImageData(), fakeSettings("first")).then(() => {
      firstResolved = true;
    });
    // Supersede with a second job; broker posts abort for first.
    renderFilterOnWorker(fakeImageData(), fakeSettings("latest"));
    expect(workers[0].posted[1]).toEqual({ kind: "abort", id: 1 });
    // Simulate the worker responding with the aborted sentinel.
    respondAborted(workers[0], 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstResolved).toBe(false);
    cancelPendingFilterRenders();
  });

  it("drops cancelled jobs when they finally respond", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    let resolved = false;
    void renderFilterOnWorker(fakeImageData(), fakeSettings("a")).then(() => {
      resolved = true;
    });
    cancelPendingFilterRenders();
    respond(workers[0], 1);
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("drains the queue after a worker error and still rejects the failing job", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    const succeeded = vi.fn();
    const p1 = renderFilterOnWorker(fakeImageData(), fakeSettings("bad"));
    expect(workers[0].posted.filter((m) => m.kind === "render")).toHaveLength(1);
    workers[0].onerror?.({ error: new Error("boom") } as unknown as MessageEvent<unknown>);
    await expect(p1).rejects.toThrow("boom");

    // After the error, the broker is idle. A new job can be submitted.
    const p2 = renderFilterOnWorker(fakeImageData(), fakeSettings("good")).then(succeeded);
    expect(workers[0].posted.filter((m) => m.kind === "render")).toHaveLength(2);
    respond(workers[0], 2);
    await p2;
    expect(succeeded).toHaveBeenCalled();
    cancelPendingFilterRenders();
  });

  it("the latest job resolves when intermediate jobs were dropped", async () => {
    const { renderFilterOnWorker, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    const results: string[] = [];
    renderFilterOnWorker(fakeImageData(), fakeSettings("a")).then(() => results.push("a"));
    renderFilterOnWorker(fakeImageData(), fakeSettings("b")).then(() => results.push("b"));
    const p3 = renderFilterOnWorker(fakeImageData(), fakeSettings("c")).then(() => results.push("c"));

    // All three jobs arrived while the previous was in flight. With
    // latest-wins, each new job aborts the previous, so 3 renders are
    // posted (a, then b, then c). c is the one in flight.
    expect(workers[0].posted.filter((m) => m.kind === "render")).toHaveLength(3);

    // a's result arrives; it was superseded, so its promise is dropped.
    respond(workers[0], 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([]);

    // c's result arrives; c resolves. (b was already cancelled.)
    respond(workers[0], 3);
    await p3;
    expect(results).toEqual(["c"]);
    cancelPendingFilterRenders();
  });
});

describe("filter worker broker (per-consumer worker pools)", () => {
  beforeEach(async () => {
    workers.length = 0;
    Object.defineProperty(globalThis, "Worker", {
      writable: true,
      value: MockWorker,
    });
    vi.resetModules();
  });

  it("allocates a dedicated worker per consumer and runs them in parallel", async () => {
    const { renderFilterOnWorker, configureFilterWorkerPool, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    configureFilterWorkerPool(2);

    const aPromise = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    const bPromise = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "studio" });

    // Two distinct consumers get two distinct workers.
    expect(workers).toHaveLength(2);
    expect(workers[0].posted.filter((m) => m.kind === "render")).toHaveLength(1);
    expect(workers[1].posted.filter((m) => m.kind === "render")).toHaveLength(1);

    respond(workers[0], 1);
    respond(workers[1], 2);
    await Promise.all([aPromise, bPromise]);
    cancelPendingFilterRenders();
  });

  it("reuses the same worker for repeated calls with the same consumer", async () => {
    const { renderFilterOnWorker, configureFilterWorkerPool, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    configureFilterWorkerPool(2);

    const p1 = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    respond(workers[0], 1);
    await p1;

    const p2 = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "preview" });
    expect(workers).toHaveLength(1);
    expect(workers[0].posted.filter((m) => m.kind === "render")).toHaveLength(2);
    respond(workers[0], 2);
    await p2;
    cancelPendingFilterRenders();
  });

  it("latest-wins within a single consumer still aborts and replaces", async () => {
    const { renderFilterOnWorker, configureFilterWorkerPool, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    configureFilterWorkerPool(2);

    let firstResolved = false;
    let latestResolved = false;
    renderFilterOnWorker(fakeImageData(), fakeSettings("first"), { consumer: "preview" }).then(() => {
      firstResolved = true;
    });
    const latest = renderFilterOnWorker(fakeImageData(), fakeSettings("latest"), { consumer: "preview" }).then(() => {
      latestResolved = true;
    });

    expect(workers).toHaveLength(1);
    expect(workers[0].posted.map((m) => m.kind)).toEqual(["render", "abort", "render"]);

    respond(workers[0], 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstResolved).toBe(false);

    respond(workers[0], 2);
    await latest;
    expect(latestResolved).toBe(true);
    cancelPendingFilterRenders();
  });

  it("cancelPendingFilterRenders with a consumer name cancels only that consumer", async () => {
    const { renderFilterOnWorker, configureFilterWorkerPool, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    configureFilterWorkerPool(2);

    const previewP = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "preview" });
    const studioP = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "studio" });

    expect(workers).toHaveLength(2);
    cancelPendingFilterRenders("preview");

    // Studio still resolves; preview is dropped (no rejection, just no resolve).
    respond(workers[1], 2);
    const result = await studioP;
    expect(result.width).toBe(2);

    // Resolving preview's id afterwards is a no-op; its promise stays pending.
    respond(workers[0], 1);
    let previewResolved = false;
    void previewP.then(() => {
      previewResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(previewResolved).toBe(false);
  });

  it("evicts the oldest consumer when the pool cap is exceeded", async () => {
    const { renderFilterOnWorker, configureFilterWorkerPool, cancelPendingFilterRenders } = await import("@/lib/filter-worker");
    configureFilterWorkerPool(2);

    const liveWorkers = () => workers.filter((w) => !w.terminate.mock.calls.length);
    const terminatedWorkers = () => workers.filter((w) => w.terminate.mock.calls.length);

    // Fill the pool with two consumers.
    const aP = renderFilterOnWorker(fakeImageData(), fakeSettings("a"), { consumer: "alpha" });
    const bP = renderFilterOnWorker(fakeImageData(), fakeSettings("b"), { consumer: "beta" });
    const alphaWorker = liveWorkers()[0];
    const betaWorker = liveWorkers()[1];
    expect(workers).toHaveLength(2);

    // Adding a third consumer should evict the oldest ("alpha") and spin up a
    // fresh worker for gamma. The old alpha worker is terminated.
    const cP = renderFilterOnWorker(fakeImageData(), fakeSettings("c"), { consumer: "gamma" });

    expect(terminatedWorkers()).toContain(alphaWorker);
    // alpha's in-flight was aborted before terminate.
    expect(alphaWorker.posted.map((m) => m.kind)).toEqual(["render", "abort"]);
    // gamma got a fresh worker that posted a single render.
    const gammaWorker = liveWorkers().find((w) => w !== betaWorker);
    expect(gammaWorker).toBeDefined();
    expect(gammaWorker!.posted.map((m) => m.kind)).toEqual(["render"]);
    // beta is untouched.
    expect(betaWorker.posted.map((m) => m.kind)).toEqual(["render"]);

    // Drain.
    respond(betaWorker, 2);
    respond(gammaWorker!, 3);
    await bP;
    await cP;
    // alpha's promise is dropped (cancelled), no resolve, no reject.
    let aResolved = false;
    void aP.then(() => {
      aResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(aResolved).toBe(false);
    cancelPendingFilterRenders();
  });
});
