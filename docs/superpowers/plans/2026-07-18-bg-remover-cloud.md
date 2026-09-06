# Background Remover — Cloud-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the on-device-only bg remover with a cloud-first flow (HF Inference Providers → `briaai/RMBG-1.4`) that falls back to the existing on-device worker on any failure, eliminating the 44MB download for the common path.

**Architecture:** A Vercel Edge function (`api/remove-bg.ts`) proxies image bytes to the HF router with the server-side `HF_TOKEN`. A client lib (`src/lib/cloudBgRemoval.ts`) POSTs to it, decodes the returned transparent PNG, and extracts the alpha channel as a `Uint8Array` mask. The `useBackgroundRemoval` hook tries cloud first, falls back to the existing `bgRemoval.worker.ts` on any error/timeout. The `CutoutTool` UI stops eager-warming the worker and updates its labels.

**Tech Stack:** TypeScript, Vite, React 18, Vitest (jsdom), Vercel Edge Functions, Hugging Face Inference Providers (raw `fetch`, no SDK).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/cloudBgRemoval.ts` | **Create** | Client: POST image to `/api/remove-bg`, decode PNG, extract alpha mask. Typed errors. |
| `api/remove-bg.ts` | **Create** | Vercel Edge function: proxy to HF router, hide `HF_TOKEN`, stream PNG back. |
| `src/hooks/useBackgroundRemoval.ts` | **Modify** | Cloud-first `removeBackground()`, lazy worker, new `source` field. |
| `src/components/tools/CutoutTool.tsx` | **Modify** | Remove eager `warmup()`, drop "44MB" subhead, update status labels. |
| `src/test/cloud-bg-removal.test.ts` | **Create** | Unit tests for `cloudBgRemoval.ts` (fetch mocking, error classification). |
| `src/test/use-background-removal.test.ts` | **Create** | Integration test: cloud success → `source==='cloud'`; cloud fail → worker fallback → `source==='worker'`. |
| `src/workers/bgRemoval.worker.ts` | **Unchanged** | Fallback path, kept verbatim. |
| `src/lib/cutout.ts` | **Unchanged** | Compositing. |

**Why no SDK:** `@huggingface/inference` risks exceeding Vercel Edge's 1MB compressed bundle limit. The HF router accepts plain HTTP (`Authorization: Bearer $HF_TOKEN`, raw image bytes in body, PNG blob in response), so raw `fetch` is simpler and dependency-free.

---

## Task 1: Client lib — typed errors + fetch wrapper

**Files:**
- Create: `src/lib/cloudBgRemoval.ts`
- Test: `src/test/cloud-bg-removal.test.ts`

- [ ] **Step 1: Write the failing test for error classification**

Create `src/test/cloud-bg-removal.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyResponse } from "@/lib/cloudBgRemoval";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/test/cloud-bg-removal.test.ts`
Expected: FAIL with "Failed to resolve import '@/lib/cloudBgRemoval'"

- [ ] **Step 3: Create the file with the error type + classifyResponse**

Create `src/lib/cloudBgRemoval.ts`:

```typescript
// Client-side caller for the cloud bg-removal endpoint.
// POSTs an image to /api/remove-bg, decodes the returned transparent PNG,
// and extracts the alpha channel as a Uint8Array mask — the same shape the
// on-device worker produces, so downstream code is unchanged.

import type { BgRemovalResult } from "@/hooks/useBackgroundRemoval";

export type CloudBgRemovalError =
  | { kind: "timeout" }
  | { kind: "rate-limited" }
  | { kind: "network" }
  | { kind: "http"; status: number };

/** Client-side timeout — leaves headroom under Vercel Edge's 30s wall clock. */
const CLOUD_TIMEOUT_MS = 25_000;

/**
 * Map an HTTP status to a typed error, or null on success (2xx).
 * Exposed for unit testing without constructing a full Response.
 */
export function classifyResponse(status: number): CloudBgRemovalError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return { kind: "rate-limited" };
  return { kind: "http", status };
}

type CutoutSource = HTMLImageElement | ImageBitmap;

async function sourceToPngBlob(source: CutoutSource): Promise<Blob> {
  const bitmap =
    source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context for PNG encode.");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/**
 * Extract a single-channel 0..255 mask from the returned PNG. RMBG-1.4
 * returns an RGBA PNG where the alpha channel IS the mask. If a future
 * model returns a grayscale mask instead, swap to reading the red channel
 * (index `i * 4 + 0`).
 */
async function maskFromPngBlob(
  pngBlob: Blob,
  width: number,
  height: number,
): Promise<BgRemovalResult> {
  const bitmap = await createImageBitmap(pngBlob);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context for mask decode.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3]; // alpha channel
  }
  bitmap.close?.();
  return { mask, width, height };
}

/**
 * Remove the background via the cloud endpoint. Throws a typed
 * CloudBgRemovalError on any failure — the caller falls back to the worker.
 */
export async function removeBgCloud(
  source: CutoutSource,
): Promise<BgRemovalResult> {
  const width = source instanceof ImageBitmap ? source.width : source.naturalWidth || source.width;
  const height = source instanceof ImageBitmap ? source.height : source.naturalHeight || source.height;

  const pngBlob = await sourceToPngBlob(source);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("/api/remove-bg", {
      method: "POST",
      body: pngBlob,
      headers: { "Content-Type": "image/png" },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw { kind: "timeout" } satisfies CloudBgRemovalError;
    throw { kind: "network" } satisfies CloudBgRemovalError;
  } finally {
    clearTimeout(timeout);
  }

  const err = classifyResponse(res.status);
  if (err) throw err;

  return maskFromPngBlob(await res.blob(), width, height);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/test/cloud-bg-removal.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/cloudBgRemoval.ts src/test/cloud-bg-removal.test.ts
git commit -m "feat(cutout): add cloudBgRemoval client with typed errors"
```

---

## Task 2: Client lib — fetch wrapper tests (happy path + errors)

**Files:**
- Test: `src/test/cloud-bg-removal.test.ts` (extend)

- [ ] **Step 1: Add fetch-mock tests for removeBgCloud**

Append to `src/test/cloud-bg-removal.test.ts` (after the existing imports, add `vi` and `beforeEach`):

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyResponse, removeBgCloud } from "@/lib/cloudBgRemoval";

// ... keep existing classifyResponse tests ...

describe("removeBgCloud", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Minimal 1×1 transparent PNG — alpha = 0 → mask is all zeros.
  const TRANSPARENT_PNG = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
  ), (c) => c.charCodeAt(0));

  function mockFetchPng(status = 200) {
    const blob = new Blob([TRANSPARENT_PNG], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(blob, { status }),
    ));
    return vi.mocked(fetch);
  }

  // jsdom lacks createImageBitmap + OffscreenCanvas — stub them.
  function stubCanvasEnv() {
    const fakeBitmap = { width: 1, height: 1, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(fakeBitmap));
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray([0, 0, 0, 0]),
        width: 1,
        height: 1,
      }),
    };
    vi.stubGlobal("OffscreenCanvas", vi.fn().mockImplementation((w, h) => ({
      width: w,
      height: h,
      getContext: () => fakeCtx,
      convertToBlob: vi.fn().mockResolvedValue(new Blob([new Uint8Array(0)], { type: "image/png" })),
    })));
  }

  it("returns a mask on 200", async () => {
    stubCanvasEnv();
    mockFetchPng(200);
    const result = await removeBgCloud(new Image());
    expect(result.mask).toBeInstanceOf(Uint8Array);
    expect(result.width).toBe(1);
  });

  it("throws rate-limited on 429", async () => {
    stubCanvasEnv();
    mockFetchPng(429);
    await expect(removeBgCloud(new Image())).rejects.toEqual({ kind: "rate-limited" });
  });

  it("throws http on 500", async () => {
    stubCanvasEnv();
    mockFetchPng(500);
    await expect(removeBgCloud(new Image())).rejects.toEqual({ kind: "http", status: 500 });
  });

  it("throws network on fetch rejection", async () => {
    stubCanvasEnv();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(removeBgCloud(new Image())).rejects.toEqual({ kind: "network" });
  });

  it("throws timeout on abort", async () => {
    stubCanvasEnv();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const e = new Error("aborted"); (e as Error & { name: string }).name = "AbortError";
          reject(e);
        });
      });
    }));
    vi.useFakeTimers();
    const promise = removeBgCloud(new Image());
    vi.advanceTimersByTime(25_000);
    await expect(promise).rejects.toEqual({ kind: "timeout" });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/test/cloud-bg-removal.test.ts`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 3: Commit**

```bash
git add src/test/cloud-bg-removal.test.ts
git commit -m "test(cutout): cover removeBgCloud happy path + error cases"
```

---

## Task 3: Vercel Edge serverless function

**Files:**
- Create: `api/remove-bg.ts`

- [ ] **Step 1: Create the Edge function**

Create `api/remove-bg.ts`:

```typescript
// Vercel Edge Function — proxies background-removal requests to the
// Hugging Face Inference Providers router. Keeps HF_TOKEN server-side.
//
// Request:  POST with raw PNG body (Content-Type: image/png)
// Response: 200 + transparent PNG body (alpha = mask), or 503 on any
//           upstream failure so the client falls back to on-device.

export const config = { runtime: "edge" };

const HF_MODEL = "briaai/RMBG-1.4";
const HF_ENDPOINT = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`;
const UPSTREAM_TIMEOUT_MS = 25_000;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const token = process.env.HF_TOKEN;
  if (!token) {
    return new Response("Server misconfigured: missing HF_TOKEN", { status: 500 });
  }

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) {
    return new Response("Empty body", { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": req.headers.get("Content-Type") ?? "image/png",
      },
      body,
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // Pass the upstream status through as a 503 so the client treats it as
      // a fallback-worthy failure (rate-limited, model error, etc.).
      return new Response(`Upstream ${upstream.status}`, { status: 503 });
    }

    const png = await upstream.blob();
    return new Response(png, {
      status: 200,
      headers: {
        "Content-Type": png.type || "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return new Response(
      aborted ? "Upstream timeout" : "Upstream error",
      { status: 503 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm tsc --noEmit -p tsconfig.app.json 2>&1 | head -30` (the `api/` dir may not be in the app tsconfig — if it's not referenced, this is expected to still pass for `src/`).

If `tsc` complains about `Request`/`Response` types in `api/`, add a `tsconfig.json` include for `api/**/*.ts` or create `api/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "types": ["@cloudflare/workers-types"],
    "strict": true
  },
  "include": ["./**/*.ts"]
}
```

(Only if the type-check fails — Vercel provides ambient types for Edge functions in most setups.)

- [ ] **Step 3: Commit**

```bash
git add api/remove-bg.ts
git commit -m "feat(cutout): add Edge function proxying bg removal to HF Inference"
```

- [ ] **Step 4: Add `HF_TOKEN` to local env**

Create `.env.local` (gitignored — confirm `.gitignore` has `.env.local` or `.env*`):

```bash
grep -q "^.env" .gitignore || echo ".env.local" >> .gitignore
echo "HF_TOKEN=hf_your_token_here" > .env.local
```

Get the token from https://huggingface.co/settings/tokens (fine-grained, "Make calls to Inference Providers" permission). Replace `hf_your_token_here` with the real token. **Do not commit `.env.local`.**

---

## Task 4: Wire cloud-first into the hook

**Files:**
- Modify: `src/hooks/useBackgroundRemoval.ts`
- Test: `src/test/use-background-removal.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `src/test/use-background-removal.test.ts`:

```typescript
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundRemoval } from "@/hooks/useBackgroundRemoval";

// Stub the worker so we never actually spin one up in jsdom.
vi.mock("@/workers/bgRemoval.worker.ts", () => ({
  default: class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    postMessage() {}
    terminate() {}
  },
}));

describe("useBackgroundRemoval — cloud-first", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses cloud path on success and reports source='cloud'", async () => {
    // 1×1 transparent PNG from the mock HF endpoint.
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"),
      (c) => c.charCodeAt(0),
    );
    const blob = new Blob([png], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(blob, { status: 200 })));

    const fakeBitmap = { width: 1, height: 1, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(fakeBitmap));
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray([0, 0, 0, 0]),
        width: 1,
        height: 1,
      }),
    };
    vi.stubGlobal("OffscreenCanvas", vi.fn().mockImplementation((w, h) => ({
      width: w, height: h, getContext: () => fakeCtx,
      convertToBlob: vi.fn().mockResolvedValue(new Blob([new Uint8Array(0)], { type: "image/png" })),
    })));

    const { result } = renderHook(() => useBackgroundRemoval());

    const img = new Image();
    Object.defineProperty(img, "naturalWidth", { value: 1, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1, configurable: true });

    let mask: Uint8Array | null = null;
    await act(async () => {
      const r = await result.current.removeBackground(img);
      mask = r.mask;
    });

    expect(mask).toBeInstanceOf(Uint8Array);
    await waitFor(() => expect(result.current.source).toBe("cloud"));
  });

  it("falls back to worker when cloud throws, reports source='worker'", async () => {
    // Cloud fails (network) → worker is created and used.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const fakeBitmap = { width: 1, height: 1, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(fakeBitmap));

    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray([255, 255, 255, 255]),
        width: 1, height: 1,
      }),
    };
    vi.stubGlobal("OffscreenCanvas", vi.fn().mockImplementation((w, h) => ({
      width: w, height: h, getContext: () => fakeCtx,
      convertToBlob: vi.fn().mockResolvedValue(new Blob([new Uint8Array(0)], { type: "image/png" })),
    })));

    const { result } = renderHook(() => useBackgroundRemoval());

    const img = new Image();
    Object.defineProperty(img, "naturalWidth", { value: 1, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1, configurable: true });

    await act(async () => {
      try {
        await result.current.removeBackground(img);
      } catch {
        // worker stub will reject; that's fine for this test
      }
    });

    await waitFor(() => expect(result.current.source).toBe("worker"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/test/use-background-removal.test.ts`
Expected: FAIL — `result.current.source` is undefined (field doesn't exist yet)

- [ ] **Step 3: Modify the hook — add `source` field + cloud-first logic**

Edit `src/hooks/useBackgroundRemoval.ts`. Changes:

**(a)** Add `source` to the interface and state. After the `error` field in `UseBackgroundRemoval`:

```typescript
  error: string | null;
  /** Which backend produced the last result — 'cloud' (default path) or 'worker' (fallback). */
  source: "cloud" | "worker" | null;
}
```

**(b)** Add the state. After `const [error, setError] = useState<string | null>(null);`:

```typescript
  const [source, setSource] = useState<"cloud" | "worker" | null>(null);
```

**(c)** Import `removeBgCloud` + the error type at the top:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import {
  removeBgCloud,
  type CloudBgRemovalError,
} from "@/lib/cloudBgRemoval";
```

**(d)** Replace the `removeBackground` callback body with cloud-first logic. Replace the entire existing `removeBackground` useCallback block with:

```typescript
  const removeBackground = useCallback(
    async (source: HTMLImageElement | ImageBitmap): Promise<BgRemovalResult> => {
      if (pendingRef.current) {
        throw new Error("A background removal is already in progress.");
      }

      setError(null);

      // --- Cloud path (default) ---
      try {
        const result = await removeBgCloud(source);
        setSource("cloud");
        setStatus("ready");
        setPhase(null);
        return result;
      } catch (err) {
        // Typed cloud errors → fall through to worker.
        // Unexpected errors → also fall through (safer than surfacing a hard error).
        const isCloudErr =
          err !== null &&
          typeof err === "object" &&
          "kind" in (err as Record<string, unknown>);
        if (!isCloudErr) {
          throw err; // programming error, don't swallow
        }
        const cloudErr = err as CloudBgRemovalError;
        // Continue to worker fallback below.
        void cloudErr;
      }

      // --- Worker fallback ---
      const worker = getWorker();
      setSource("worker");
      setStatus((s) => (s === "ready" ? "running" : "loading"));

      const bitmap =
        source instanceof ImageBitmap ? source : await createImageBitmap(source);

      return new Promise<BgRemovalResult>((resolve, reject) => {
        pendingRef.current = { resolve, reject };
        setStatus((s) => (s === "loading" ? "loading" : "running"));
        try {
          worker.postMessage({ type: "run", bitmap }, [bitmap]);
        } catch (err) {
          pendingRef.current = null;
          const message = err instanceof Error ? err.message : String(err);
          setStatus("error");
          setError(message);
          reject(new Error(message));
        }
      });
    },
    [getWorker],
  );
```

**(e)** Add `source` to the returned object. In the `return { ... }` statement, add `source,` after `error,`:

```typescript
  return {
    removeBackground,
    warmup,
    progress,
    phase,
    device,
    loaded,
    total,
    status,
    error,
    source,
  };
```

- [ ] **Step 4: Run the integration test**

Run: `pnpm vitest run src/test/use-background-removal.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Run the full test suite to catch regressions**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useBackgroundRemoval.ts src/test/use-background-removal.test.ts
git commit -m "feat(cutout): cloud-first removeBackground with worker fallback"
```

---

## Task 5: Update CutoutTool UI

**Files:**
- Modify: `src/components/tools/CutoutTool.tsx`

- [ ] **Step 1: Remove eager warmup and the "44MB" subhead**

In `src/components/tools/CutoutTool.tsx`:

**(a)** Delete the `useEffect` that calls `warmup()` on mount (lines ~60-62). Replace:

```typescript
  // Pre-fetch the model as soon as the user opens the Cutout tab — this
  // hides the silent worker-script + WASM fetches behind their exploration
  // of the panel, so the first "Remove background" click responds faster.
  useEffect(() => {
    warmup();
  }, [warmup]);
```

with:

```typescript
  // Cloud-first: no eager worker warmup. The worker is only created if the
  // cloud path fails, so most users never download the 44MB model.
```

**(b)** Remove `useEffect` from the React import if it's now unused. Change:

```typescript
import React, { useEffect, useMemo, useState } from "react";
```

to:

```typescript
import React, { useMemo, useState } from "react";
```

**(c)** Remove the "Downloads a ~44MB AI model" subhead. Delete:

```typescript
      <p className="-mt-2 px-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-primary">
        Downloads a ~44MB AI model on first use (then cached)
      </p>
```

- [ ] **Step 2: Add `source` from the hook + update labels**

**(a)** Destructure `source` from the hook. Change:

```typescript
  const {
    removeBackground,
    warmup,
    progress,
    phase,
    device,
    loaded,
    total,
    status,
    error,
  } = useBackgroundRemoval();
```

to:

```typescript
  const {
    removeBackground,
    warmup,
    progress,
    phase,
    device,
    loaded,
    total,
    status,
    error,
    source,
  } = useBackgroundRemoval();
```

**(b)** Update `statusLabel` to reflect the backend. Change the `statusLabel` const to:

```typescript
  const statusLabel = isInferring
    ? source === "worker"
      ? "Processing on device…"
      : "Removing via cloud…"
    : isDownloading
      ? "Downloading model…"
      : isPreparing
        ? "Preparing AI engine…"
        : null;
```

**(c)** Update the button label's busy text. In the `Button` children, change:

```typescript
        {isBusy
          ? isDownloading
            ? "Downloading model…"
            : isInferring
              ? "Processing…"
              : "Preparing…"
          : maskState
            ? "Re-run removal"
            : "Remove background"}
```

to:

```typescript
        {isBusy
          ? isDownloading
            ? "Downloading model…"
            : isInferring
              ? source === "worker"
                ? "Processing on device…"
                : "Removing via cloud…"
              : "Preparing…"
          : maskState
            ? "Re-run removal"
            : "Remove background"}
```

- [ ] **Step 3: Verify the build passes**

Run: `pnpm build`
Expected: build succeeds with no type errors

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/components/tools/CutoutTool.tsx
git commit -m "feat(cutout): drop eager warmup, update labels for cloud-first path"
```

---

## Task 6: Manual integration smoke test

This task validates the real HF endpoint shape. No code changes unless the PNG shape differs from assumptions.

- [ ] **Step 1: Set a real `HF_TOKEN` in `.env.local`**

Get a token from https://huggingface.co/settings/tokens (fine-grained, "Make calls to Inference Providers" permission). Replace `hf_your_token_here` in `.env.local`.

- [ ] **Step 2: Start the dev server**

Run: `pnpm dev`
Open: http://localhost:8080

- [ ] **Step 3: Load an image and click "Remove background"**

- Open the Cutout tab
- Confirm the "Downloads a ~44MB" subhead is gone
- Click "Remove background"
- Expected: button shows "Removing via cloud…", result appears in 1–5s
- Confirm `source` is `cloud` (open React DevTools or temporarily `console.log` the hook state)

- [ ] **Step 4: Verify the fallback path**

- In `.env.local`, set `HF_TOKEN=invalid_token` and restart `pnpm dev`
- Click "Remove background"
- Expected: cloud fails → worker fallback kicks in → "Processing on device…" → 44MB download begins → mask appears

- [ ] **Step 5: If the PNG shape is wrong, fix `maskFromPngBlob`**

If the cloud result comes back as a grayscale mask PNG (not RGBA), change `mask[i] = data[i * 4 + 3]` to `mask[i] = data[i * 4]` (red channel) in `src/lib/cloudBgRemoval.ts`. Re-run the smoke test.

- [ ] **Step 6: Commit any smoke-test fixes**

```bash
git add src/lib/cloudBgRemoval.ts
git commit -m "fix(cutout): adapt mask channel to actual RMBG-1.4 PNG shape"
```

---

## Task 7: Update ARCHITECTURE.md

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add a "Background Removal" section**

After the "Image Import" section, add:

```markdown
## Background Removal

The Cutout tool is cloud-first with an on-device fallback.

- **Cloud path (default):** `src/lib/cloudBgRemoval.ts` POSTs the image PNG
  to `api/remove-bg.ts`, a Vercel Edge function that proxies to Hugging Face
  Inference Providers (`briaai/RMBG-1.4`, Apache-2.0). The function hides the
  `HF_TOKEN` server-side and streams a transparent PNG back. The client
  extracts the alpha channel into a `Uint8Array` mask.
- **Worker fallback:** `src/workers/bgRemoval.worker.ts` (transformers.js +
  `onnx-community/BiRefNet_lite`, ~44MB) runs only when the cloud path fails
  (timeout, rate-limit, 5xx, network). The worker is created lazily — it is
  never pre-warmed on Cutout-tab open.
- **Shared contract:** both paths return `{ mask: Uint8Array, width, height }`,
  consumed by `compositeCutout` in `src/lib/cutout.ts`. The hook exposes
  `source: 'cloud' | 'worker' | null` so the UI can label which backend ran.
```

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: document cloud-first bg removal architecture"
```

---

## Task 8: Deploy prerequisites

- [ ] **Step 1: Add `HF_TOKEN` to Vercel env vars**

Run (or set via Vercel dashboard → Settings → Environment Variables):

```bash
vercel env add HF_TOKEN
# paste the token when prompted, select Production + Preview + Development
```

- [ ] **Step 2: Deploy to preview**

```bash
vercel
```

- [ ] **Step 3: Smoke-test the preview deployment**

Open the preview URL, load an image, click "Remove background". Confirm cloud path works in production.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `api/remove-bg.ts` Edge function hiding HF_TOKEN | Task 3 |
| `src/lib/cloudBgRemoval.ts` client caller with typed errors | Task 1 + 2 |
| Same mask contract (`Uint8Array`, w, h) | Task 1 (returns `BgRemovalResult`) |
| `useBackgroundRemoval` cloud-first + worker fallback | Task 4 |
| `warmup()` no longer fires on tab open | Task 5 |
| Remove "44MB" subhead | Task 5 |
| `source: 'cloud' \| 'worker' \| null` field | Task 4 |
| Updated status labels | Task 5 |
| Worker, cutout.ts, onApply unchanged | (no task — explicitly untouched) |
| Error handling table (timeout/429/5xx/network) | Task 1 (classifyResponse) + Task 2 (tests) |
| Unit tests for cloudBgRemoval | Task 1 + 2 |
| Integration test for hook fallback | Task 4 |
| Manual smoke test | Task 6 |
| PNG shape verification (open question #1) | Task 6 Step 5 |

All spec requirements covered.

**Type consistency check:**
- `CloudBgRemovalError` — used in Task 1 (defined), Task 4 (imported as type). ✓
- `removeBgCloud(source)` — signature consistent across Task 1 (def) and Task 4 (call). ✓
- `BgRemovalResult` — imported in Task 1 from `@/hooks/useBackgroundRemoval`. ✓
- `source` field — added to interface in Task 4, read in Task 5. ✓

No issues found.
