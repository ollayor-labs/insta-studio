import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyResponse, removeBgCloud } from "@/lib/cloudBgRemoval";

describe("classifyResponse", () => {
  it("returns 'rate-limited' for 429", () => {
    expect(classifyResponse(429)).toEqual({ kind: "rate-limited" });
  });

  it("returns 'http' with status for 5xx", () => {
    expect(classifyResponse(500)).toEqual({ kind: "http", status: 500 });
    expect(classifyResponse(502)).toEqual({ kind: "http", status: 502 });
  });

  it("returns 'http' with status for unexpected 4xx", () => {
    expect(classifyResponse(401)).toEqual({ kind: "http", status: 401 });
  });

  it("returns null for 200", () => {
    expect(classifyResponse(200)).toBeNull();
  });
});

// Minimal 1x1 transparent PNG (alpha = 0 → mask is all zeros).
// Verbose literal so tests don't depend on a fixture file.
const TRANSPARENT_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (c) => c.charCodeAt(0),
);

function mockFetchPng(status = 200) {
  const blob = new Blob([TRANSPARENT_PNG], { type: "image/png" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(blob, { status })),
  );
}

// jsdom lacks createImageBitmap + OffscreenCanvas + ImageBitmap — stub them
// so removeBgCloud can encode/decode PNGs without a real browser canvas.
// `ImageBitmap` must exist as a global because cloudBgRemoval uses
// `source instanceof ImageBitmap` (same pattern as useBackgroundRemoval).
function stubCanvasEnv() {
  class FakeImageBitmap {
    width: number;
    height: number;
    close = vi.fn();
    constructor(w = 1, h = 1) {
      this.width = w;
      this.height = h;
    }
  }
  vi.stubGlobal("ImageBitmap", FakeImageBitmap);
  const fakeBitmap = new FakeImageBitmap();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(fakeBitmap));
  const fakeCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({
      data: new Uint8ClampedArray([0, 0, 0, 0]),
      width: 1,
      height: 1,
    }),
  };
  vi.stubGlobal(
    "OffscreenCanvas",
    vi.fn().mockImplementation((w: number, h: number) => ({
      width: w,
      height: h,
      getContext: () => fakeCtx,
      convertToBlob: vi
        .fn()
        .mockResolvedValue(new Blob([new Uint8Array(0)], { type: "image/png" })),
    })),
  );
}

function makeFakeImage(): HTMLImageElement {
  const img = new Image();
  Object.defineProperty(img, "naturalWidth", { value: 1, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 1, configurable: true });
  return img;
}

describe("removeBgCloud", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a mask on 200", async () => {
    stubCanvasEnv();
    mockFetchPng(200);
    const result = await removeBgCloud(makeFakeImage());
    expect(result.mask).toBeInstanceOf(Uint8Array);
    expect(result.width).toBe(1);
  });

  it("throws rate-limited on 429", async () => {
    stubCanvasEnv();
    mockFetchPng(429);
    await expect(removeBgCloud(makeFakeImage())).rejects.toEqual({
      kind: "rate-limited",
    });
  });

  it("throws http on 500", async () => {
    stubCanvasEnv();
    mockFetchPng(500);
    await expect(removeBgCloud(makeFakeImage())).rejects.toEqual({
      kind: "http",
      status: 500,
    });
  });

  it("throws network on fetch rejection", async () => {
    stubCanvasEnv();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(removeBgCloud(makeFakeImage())).rejects.toEqual({
      kind: "network",
    });
  });

  it("throws timeout on abort", async () => {
    stubCanvasEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            (e as Error & { name: string }).name = "AbortError";
            reject(e);
          });
        });
      }),
    );
    vi.useFakeTimers();
    const promise = removeBgCloud(makeFakeImage());
    // Pre-attach a noop rejection handler so vitest doesn't flag an
    // unhandled rejection in the window between the timer firing the
    // abort and expect().rejects attaching its own handler.
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(promise).rejects.toEqual({ kind: "timeout" });
    vi.useRealTimers();
  });
});
