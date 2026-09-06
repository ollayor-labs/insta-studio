# Background Remover — Cloud-First with On-Device Fallback

**Date:** 2026-07-18
**Status:** Approved (verbal) — pending spec review
**Model:** `briaai/RMBG-1.4` (Apache-2.0, commercial-safe)

## Problem

The current background-removal flow (`CutoutTool` → `useBackgroundRemoval` →
`bgRemoval.worker.ts`) runs `onnx-community/BiRefNet_lite` entirely on-device via
transformers.js (WebGPU or WASM fallback). User feedback indicates three pain
points, all of which drive users to abandon the tool and download a dedicated
bg-remover app instead:

1. **Download friction** — A ~44MB model is fetched on first Cutout-tab open.
2. **Quality ceiling** — The lite export is visibly worse than commercial-grade
   options (jagged hair, halos, missing edges).
3. **WASM slowness** — On non-WebGPU devices (the majority of users), inference
   takes 10–30s.

The expected UX for a "remove background" button is instant, commercial-grade
results. The on-device approach delivers the opposite.

## Solution

**Cloud-first, on-device fallback.** Route bg-removal requests to
`briaai/RMBG-1.4` via Hugging Face Inference Providers (served by Replicate or
fal-ai through the HF router). Keep the existing on-device worker as an
automatic fallback for when the cloud path fails or rate-limits.

### Why Path A (HF Inference Providers, freemium)

- **$0 infra work** — no Dockerfile, no containers, no keep-alive strategy.
- **Instant** — 1–4s warm inference, no 44MB client download.
- **Commercial-grade quality** — full RMBG-1.4 model, not the lite export.
- **Apache-2.0 license** — commercial-safe.
- **Cost reality:** $0.10/mo free credit ≈ 50–100 images, then ~$0.001–0.002/image
  via Replicate/fal-ai. On-device fallback absorbs rate-limit / credit-exhaustion
  spikes so the feature keeps working even when billing kicks in.

Rejected alternatives:

- **Path B (self-host on Fly.io)** — truly free at scale but ~1 day of infra work
  (Dockerfile, model load, keep-alive). Premature until traffic justifies it.
- **Path C (fix on-device UX)** — free but doesn't fix the quality ceiling or
  WASM slowness. Doesn't move the needle on the stated pains.

## Architecture

```
User clicks "Remove background"
        │
        ▼
useBackgroundRemoval.removeBackground(source)
        │
        ├─ try cloud ─────────────────────────────────┐
        │   POST /api/remove-bg  (image blob)          │
        │       │                                      │
        │       ▼                                      │
        │   Vercel Edge serverless fn                  │
        │   ├─ reads HF_TOKEN from env                 │
        │   ├─ InferenceClient.imageToImage({          │
        │   │     model: 'briaai/RMBG-1.4' })          │
        │   └─ streams transparent PNG back            │
        │                                              │
        │   client decodes PNG, extracts alpha channel │
        │   into Uint8Array mask (same shape as worker) │
        │                                              │
        ├─ on timeout / 429 / 5xx / network err ───────┤
        │   fall back to existing worker                │
        │   (lazy warmup() on this path only)           │
        │                                              │
        ▼                                              ▼
   mask: Uint8Array, width, height   ←  same contract either way
        │
        ▼
   compositeCutout(source, mask, …) → onApply   (unchanged downstream)
```

### Key design choices

1. **Same mask contract.** Both paths return `{ mask: Uint8Array, width, height }`.
   The downstream `compositeCutout` / `onApply` / `CutoutTool` mask-state code is
   untouched — only the *producer* of the mask changes.

2. **Vercel Edge function hides the HF token.** `HF_TOKEN` lives in Vercel env
   vars, never in the client bundle. The client only ever calls `/api/remove-bg`.

3. **PNG alpha extraction.** RMBG-1.4 returns an RGBA PNG where the alpha channel
   is the mask. Client-side: `createImageBitmap(pngBlob)` → draw to OffscreenCanvas
   → `getImageData()` → take every 4th byte (alpha). If the actual response is a
   grayscale mask PNG instead, read the red channel — trivial adaptation. ⚠️
   Verify at first integration test.

4. **Fallback is automatic, not a user-visible switch.** If the cloud call fails
   within the timeout window, the hook silently routes to the worker. The only UI
   hint is the existing "Downloading model…" bar appears *only in the fallback
   case* — most users never see it.

5. **Warmup behavior changes.** Currently `warmup()` fires on Cutout-tab open
   and triggers the 44MB download eagerly. New behavior: do **not** warmup by
   default. The worker is only created when the cloud path fails. This removes
   the silent 44MB fetch for the ~95% of users who get a successful cloud result.

## Components

### NEW

#### `api/remove-bg.ts` — Vercel Edge serverless function

- Runtime: Edge (25–30s wall-clock limit, runs globally for lower latency).
- Reads `HF_TOKEN` from env.
- Uses `@huggingface/inference`'s `InferenceClient.imageToImage()`:
  ```ts
  const client = new InferenceClient(process.env.HF_TOKEN);
  const pngBlob = await client.imageToImage({
    model: 'briaai/RMBG-1.4',
    inputs: imageBlob,
  });
  ```
- Streams the PNG blob back with `Content-Type: image/png`.
- Returns 503 (with a typed error body) on: HF rate-limit (429), timeout, 5xx,
  network failure. The client uses 503 as the signal to fall back.
- Timeout: 25s client-side (leaves headroom under Edge's 30s limit).

#### `src/lib/cloudBgRemoval.ts` — Client-side caller

Exports:

```ts
type CloudBgRemovalError =
  | { kind: 'timeout' }
  | { kind: 'rate-limited' }
  | { kind: 'network' }
  | { kind: 'http'; status: number };

async function removeBgCloud(
  source: HTMLImageElement | ImageBitmap,
): Promise<BgRemovalResult>;
```

- Builds an ImageBitmap from the source (reuse the existing pattern from
  `useBackgroundRemoval.removeBackground`).
- POSTs the bitmap (as a raw PNG blob in the request body,
  `Content-Type: image/png`) to `/api/remove-bg`. Raw body avoids multipart
  parsing overhead in the Edge function.
- Aborts after 25s via `AbortController`.
- On success: `createImageBitmap(pngBlob)` → draw to `OffscreenCanvas` →
  `getImageData()` → extract alpha (or red if grayscale) → `Uint8Array` mask.
- Throws typed `CloudBgRemovalError` on failure.

### MODIFIED

#### `src/hooks/useBackgroundRemoval.ts`

- `removeBackground()`:
  - Try `removeBgCloud(source)` first.
  - On `CloudBgRemovalError`, fall back to the existing worker path
    (`getWorker()` + postMessage `run`).
  - Set `source` state to `'cloud'` on success or `'worker'` on fallback.
- `warmup()`:
  - No-op by default (the worker is no longer pre-warmed on tab open).
  - Still exported and safe to call — used internally by the fallback path
    before the worker's first `run` message.
- New state field surfaced to the UI:
  ```ts
  source: 'cloud' | 'worker' | null;
  ```

#### `src/components/tools/CutoutTool.tsx`

- Remove the `useEffect(() => { warmup(); }, [warmup])` call on mount.
- Remove the "Downloads a ~44MB AI model on first use (then cached)" subhead —
  no longer true for the default path.
- `statusLabel` / button label:
  - Cloud in-flight: "Removing via cloud…"
  - Worker fallback in-flight: "Processing on device…" (and existing download
    UI re-appears if the model still needs to download).
- Keep the existing download-progress / inference-spinner UI — it now only
  appears when the worker fallback kicks in.

### UNCHANGED

- `src/workers/bgRemoval.worker.ts` — the fallback path, kept as-is.
- `src/lib/cutout.ts` — `compositeCutout`, `CutoutBackground` types.
- `CutoutTool` mask/background picker UI (transparent / color swatches / apply).
- All downstream `onApply` consumers in `Index.tsx`.

## Error handling & timeout strategy

| Failure | Client behavior | User-visible |
|---|---|---|
| Cloud call > 25s | Abort, fall back to worker | Brief "Switching to on-device…" if the worker then needs to download (most users never see this) |
| HF returns 429 (rate-limited) | Fall back to worker | Same as above |
| HF returns 5xx | Fall back to worker | Same as above |
| Network error (offline, DNS) | Fall back to worker | Same as above |
| Worker also fails | Surface error via existing `error` state | Existing red error panel in CutoutTool |
| Cloud returns malformed PNG | Treat as cloud failure, fall back | Same as timeout |

The fallback is **always** the on-device worker — there is no "give up" path
that doesn't at least try the worker first. Only if the worker also fails do
we surface a hard error.

## Data flow / privacy

- Image bytes leave the browser to: (1) our Vercel Edge function, then (2) the
  HF Inference Provider (Replicate or fal-ai). User accepted this trade-off.
- The Edge function does not log or store image bytes — it streams them
  straight through.
- No persistence anywhere. The mask is computed client-side from the returned
  PNG and lives only in React state, same as today.

## Testing

- **Unit tests** for `cloudBgRemoval.ts`:
  - Happy path: mock `fetch` returning a 1×1 transparent PNG → mask is all 0.
  - Timeout: mock `fetch` that never resolves within 25s → throws `{ kind: 'timeout' }`.
  - 429 → throws `{ kind: 'rate-limited' }`.
  - 5xx → throws `{ kind: 'http', status: 5xx }`.
  - Network error → throws `{ kind: 'network' }`.
- **Unit tests** for the serverless function:
  - Forwards the blob to `InferenceClient.imageToImage` with the right model.
  - Returns 503 when the client throws.
  - Does not leak the token in the response body.
- **Integration test** for `useBackgroundRemoval`:
  - Cloud succeeds → `source === 'cloud'`, worker never created.
  - Cloud fails (mocked) → worker path runs → `source === 'worker'`.
- **Manual smoke test** against the real HF endpoint before merge to confirm
  RMBG-1.4 is actually served and the PNG shape matches our extraction logic.

## Out of scope (future work)

- Caching cloud results (same image → same mask) to avoid re-billing.
- A user-facing "offline mode" toggle that forces the worker path.
- Migrating to a self-hosted container (Path B) when traffic justifies it.
- Swapping RMBG-1.4 for a newer model (RMBG-2.0 has a non-commercial license;
  stay on 1.4 unless a commercial-safe successor ships).

## Open questions to verify at implementation time

1. **Exact PNG shape from RMBG-1.4** — confirm alpha-channel-is-mask vs.
   grayscale-mask. Trivial either way; affects one line in `cloudBgRemoval.ts`.
2. **Which provider HF routes `briaai/RMBG-1.4` to** — Replicate vs. fal-ai.
   Affects cold-start expectations (Replicate cold starts ~10s; fal-ai is
   generally warmer). The fallback absorbs cold-start timeouts regardless.
3. **Edge function size limit** — `@huggingface/inference` adds bundle weight;
   verify it fits Vercel Edge's 1MB (compressed) limit. If not, drop to raw
   `fetch` against `https://router.huggingface.co/...` with the token header.
