# Cutout Progress UI — Implementation Plan

## Problem
First Cutout use stalls silently for seconds. The user clicks "Remove background" and faces three silent phases — worker script fetch (493 KB), WASM runtime fetch (22.5 MB), and model inference — before the one phase that *does* have a progress bar (the ~44 MB model download) even begins. The current progress bar also has a first-run bug: when the model finishes loading mid-first-run, status flips `loading → ready` (not `running`), so the "Processing…" caption never shows during inference.

## Design

### 1. Enrich the worker's progress messages (`src/workers/bgRemoval.worker.ts`)
Replace the lossy scalar `progress_callback` filter with a **phase-aware** message protocol:

- Expand the outbound message to carry `phase` and file/byte info where available:
  ```
  { type: "progress", phase: "download", value, loaded?, total?, file? }
  ```
- Capture the full `progress_callback` payload from transformers.js — it emits `{ status, name, file, loaded, total, progress }`. Forward byte counts (`loaded`/`total`) and file name so the UI can show "Downloading model… 12 MB / 44 MB".
- Post explicit phase transitions for the silent phases:
  - `{ type: "progress", phase: "init" }` when `ensureInit()` starts (worker script + WASM fetch window — the user sees "Preparing…" since these are silent)
  - `{ type: "progress", phase: "download", ... }` during model download (the reported phase)
  - The existing `{ type: "ready" }` marks the end of loading
- Post `{ type: "progress", phase: "inference" }` right before `model(inputs)` starts, so the UI can show "Processing…" with an indeterminate state during inference (no byte progress available).
- Surface the device (WebGPU vs WASM) in the `ready` message: `{ type: "ready", device: "webgpu" | "wasm" }` — lets the UI hint "Running on CPU — may take longer" when WASM.

### 2. Add a `warmup()` method to the hook (`src/hooks/useBackgroundRemoval.ts`)
- Add `warmup: () => void` to the `UseBackgroundRemoval` interface. It constructs the worker (if not already) and posts `{ type: "init" }` — the worker's `init` handler already exists (`bgRemoval.worker.ts:141-143`) but is currently dead code. This triggers `ensureInit()` (model + processor download) without running inference.
- Extend the `WorkerOut` type union to match the enriched messages (add `phase`, `loaded`, `total`, `file`, `device`).
- Add state for `phase: "init" | "download" | "inference"` and `device: "webgpu" | "wasm" | null`.
- **Fix the first-run inference feedback bug**: when `ready` arrives while a run is pending (`pendingRef.current` exists), transition to `running` instead of ignoring — the `ready` handler at line 66 currently only handles `loading → ready`. Add: `case "ready": setStatus(s => pendingRef.current ? "running" : s === "loading" ? "ready" : s); setDevice(msg.device)`.

### 3. Pre-fetch on Cutout tab activation (`src/components/tools/CutoutTool.tsx`)
- Call `warmup()` in a `useEffect` on component mount (when the Cutout tab becomes active and `CutoutTool` mounts). This starts the model download as soon as the user shows intent by opening the tab, rather than waiting for the button click.
- The worker construction + WASM fetch now happen on tab-open instead of button-click, hiding the 493 KB + 22.5 MB silent fetches behind the user's exploration of the panel.

### 4. Redesign the CutoutTool progress UI (`src/components/tools/CutoutTool.tsx`)
Replace the single progress bar + "%" with a phased status display matching the existing visual language (`font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground`, `Loader2 animate-spin` from MetadataTool/DropZone):

| Phase | Status | UI |
|---|---|---|
| `init` | preparing worker + WASM | `Loader2 spinner` + "Preparing AI engine…" (indeterminate) |
| `download` | model download | `Progress bar` + "Downloading model… 12 MB / 44 MB" + `N%` |
| `inference` | running model | `Loader2 spinner` + "Processing… {device hint}" (indeterminate) |
| `ready` + `running` | (warm) re-run | `Loader2 spinner` + "Processing…" |
| `error` | — | existing destructive box |

- Device hint on WASM: "Running on CPU — this may take a bit" (since the page isn't cross-origin isolated, WASM is single-threaded).
- Show `loaded` / `total` bytes (formatted via the existing `formatFileSize` from `@/lib/fileSize`) alongside the percentage during download — more honest than a bare percentage.
- Keep the existing `Progress` (radix) component for the determinate download phase; use `Loader2` spinners for the indeterminate phases.

## Files modified
1. `src/workers/bgRemoval.worker.ts` — enrich `progress_callback`, add phase messages, add `device` to `ready`, post `inference` phase before `model(inputs)`
2. `src/hooks/useBackgroundRemoval.ts` — extend `WorkerOut` type, add `phase`/`device` state, add `warmup()` method, fix first-run inference status bug
3. `src/components/tools/CutoutTool.tsx` — call `warmup()` on mount, redesign progress UI with phased states + byte counts + device hint + `Loader2` spinners

## Constraints
- No new dependencies (reuse `Loader2` from lucide-react, `Progress` from existing ui, `formatFileSize` from `@/lib/fileSize`).
- Preserve the existing message protocol backward-compat where possible (the `value` field stays on progress messages for any other consumers).
- Don't change the model, device selection logic, or mask compositing — only progress reporting and UI.
- Match existing code style (comment density, naming, `font-mono-ui` patterns).

## Verification
- `pnpm run verify` (lint + 234 tests + build) must pass
- Manual check: open Cutout tab, verify "Preparing…" → "Downloading model… N MB / 44 MB" → "Processing…" progression on first use
- Verify second use shows "Processing…" immediately (model cached)