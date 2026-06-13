# Changelog

All notable changes to **insta-studio** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Renderer barrel in `src/lib/filter-engine/renderer.ts` retained as a placeholder; the real pipeline lives in `src/lib/filters/index.ts`. ARCHITECTURE.md already points at the real path; README updated.
- `useFullResolution` is now gated on source pixel area (greater than `PREVIEW_MAX_DIMENSION ** 2`) rather than on `zoom > 150`. A 4K image at 100% zoom now exports at full res; a small icon-sized import never does.
- The `ImageData` mock in `src/test/setup.ts` now accepts the `(width, height)` constructor shape that the broker tests use, and `Blob.prototype.text()` is polyfilled. `fake-indexeddb` is imported at setup so the recents round-trip test runs against a real IDB.

### Fixed
- `imageImport.ts`: when both HEIC conversion and the native decoder fail, the user now gets the right toast (`heic-conversion-failed`, not `image-decode-failed`).
- `exif.ts` `readExifFromJpeg` returns `null` for truncated mid-segment JPEGs (added a bounds check inside the APP1 branch).
- `exif.ts` `injectExifSegment` now normalizes its input so legacy APP1-with-preamble payloads and bare-TIFF payloads produce the same output. `normalizeExifPayload` also recognizes the legacy APP1-segment shape.
- `recommendPresets` tie-break is now ASCII-stable (no more `localeCompare` locale dependence).
- PNG `eXIf` CRC test sign fix (the implementation is correct; the test was reassembling bytes into a signed int).
- Legacy EXIF normalize test fixture: the segment length byte was 0x0e but the payload was 8 bytes — corrected to 0x10.

### Added
- `getExifOrientation(tiffBytes)` and `getExifOrientationFromBlob(blob)` helpers in `src/lib/exif.ts` parse the EXIF Orientation tag (IFD0, tag 0x0112) from a TIFF payload or Blob. Best-effort: returns 1 on any parse failure.
- Export pipeline now applies EXIF orientation to the rendered pixels so a portrait-orientation phone photo comes out the right way up. The output canvas is sized to the *oriented* dimensions for resample + encode.
- `usePrefersReducedMotion()` hook in `src/hooks/use-prefers-reduced-motion.ts` listens to `(prefers-reduced-motion: reduce)`.
- The magic-reveal preset-switch transition is skipped when the user prefers reduced motion.
- The Shift+C / Reveal button auto-cycle snaps to 50% and skips the RAF loop when the user prefers reduced motion.
- The `Rendering` chip in the canvas now also covers the studio render (`studioIsProcessing` from `useFilter`).


### Added
- Histogram badge on the canvas with per-channel (R, G, B) paths, mean luminance, and live highlight/shadow clipping detection.
- Live clipping warnings derived from the rendered preview (`detectClippingFromImageData`) — the badge turns destructive when any channel clips past a 0.5% sample threshold.
- Custom Presets UI: save a named preset from the Adjustments panel, browse a Custom section in the filter sidebar (grid and strip layouts), and delete with a hover-revealed trash button. Storage layer (`storage.ts`) was already implemented; this surfaces it.
- Keyboard shortcuts table in the README.
- `preferences` test that locks stable tie-breaking in `recommendPresets` (alphabetical-by-name on score ties).
- Golden test for the HSL skin-band guard: Soft Portrait at 100% strength moves a skin pixel under 45/channel-summed while a sky pixel moves visibly more.
- Image analysis now runs in a dedicated worker (`workers/analysisWorker.ts`) via a module-level broker (`lib/analysis-worker.ts`). The main thread stays free during the post-import settle.
- Filter render is now served by a singleton worker with a queued broker (`lib/filter-worker.ts`) and a cancellation API. Replaces per-mount `createFilterWorker()` / `worker.terminate()`.
- Adaptive / Studio segmented control in the Adjustments panel header. Toggling to Studio bypasses scene-aware tuning (`adaptToScene: false`) so the preset's base grading is applied verbatim. A new test in `filter-engine.test.ts` locks the divergence between the two paths so the toggle can never silently collapse to a no-op.
- A / B / C tri-view in the bottom bar (`BottomBar` view pill): `B` is the live adaptive render (default), `A` is the unedited source, `C` is the same preset rendered with scene adaptation disabled. The studio render is only paid for while the user is sitting on view `C`, so casual toggling costs nothing. Pressing-and-holding `Space` snaps the canvas to view `A` so users can still preview the source without leaving the keyboard.
- Recent images: a 12-entry IndexedDB-backed recents list appears in the empty state under the dropzone. Each thumbnail opens the stored image back into the editor (HEIC files are stored after the convert-to-JPEG step so reopen is instant). Entries can be removed individually (hover → trash) or cleared in bulk via the header button. The storage layer (`lib/recents.ts`) is dependency-injected on the IDB factory, so the IndexedDB surface is unit-tested without a real browser.
- 1–9 keyboard favorite shortcuts. Shift-click a preset card to mark it as a favorite (the lowest empty slot 1–9 wins). The card then shows a small numeric chip in its top-left corner, and pressing the matching number key anywhere applies the favorite. Built-in and custom presets both qualify. Storage is a `localStorage` key (`filtr.favorites`) decoupled from custom-preset records so the two stay independent. `getFavoritePresetId`, `setFavoriteSlot`, and `clearFavoriteSlot` are the public storage primitives, with input validation that drops out-of-range slots and non-string preset ids on read.
- Float32 export pipeline (`lib/filter-engine/float32.ts`). The export path now runs the full filter chain in 0..1 float space and clamps to `Uint8` once at the end, eliminating the per-pass `0..255` rounding that produced visible banding in smooth gradients. The live preview stays on the original Uint8 path for speed. The new option is `precision: "uint8" | "float32"` on `RenderOptions`; the engine dispatches on it in `applyFilterToImageData`, the worker dispatches on it in `filterWorker.ts`, and the export pipeline in `BottomBar` opts in. The Float32 path is a parallel implementation; if it ever has a bug, exports fall back to the existing Uint8 path on the next render (just don't pass `precision: "float32"`).
- Animated before/after reveal. A new `Reveal` button in the bottom bar (next to `Compare`) auto-cycles the compare slider from 0 → 100 → 0 over 3 seconds with a sine ease, then stops at the center. The keyboard shortcut is `Shift + C`. Pressing the button while compare mode is off automatically turns it on. Dragging the slider manually mid-animation cancels it instantly so the user is always in control. Status is reflected in the button label (`Revealing…` during play) and the helper chip (`Auto-cycling` / `Drag slider on image`).
- WebP and "Original" added to the export format selector. `WebP` gives smaller files than JPEG at equivalent quality. `Original` honors the source file's MIME if it's a supported export type (PNG, JPEG, WebP) and falls back to JPEG otherwise, so HEIC and other browser-unencodable sources still produce a usable export. The resolution helpers (`resolveExportMime`, `resolveExportExtension`) live in `lib/exportFormat.ts` so the bottom bar stays component-only. The source MIME is tracked through the import flow (already plumbed in via the recents turn) and threaded to the bottom bar so the filename extension always matches the actual export.
- EXIF round-trip on export. Imports pull the raw EXIF TIFF payload out of the source (JPEG, PNG, and WebP) and store it on the recent's IndexedDB record. On export, the payload is spliced back into the new bytes in format-appropriate places: JPEG gets the APP1 segment with the "Exif\0\0" preamble right after SOI, PNG gets an `eXIf` chunk (with valid CRC32) right before `IEND`, and WebP gets an "EXIF" RIFF chunk with the file size header updated. The reader is segment-only — we don't try to parse the TIFF IFD tree, just preserve the opaque payload. The on-disk shape is format-agnostic (bare TIFF) so the same stored bytes can re-enter any output format, with a normalization helper that strips a legacy JPEG preamble if a recent was saved under the old shape.
- Mouse-wheel and trackpad-pinch zoom on the image canvas. A regular mouse wheel steps the zoom in 10% increments; a trackpad pinch (which surfaces as `wheel` events with `ctrlKey: true` on macOS) gives a smooth proportional zoom. The zoom is anchored to the cursor — the pixel under the pointer stays under the pointer — so users can inspect details by rolling the wheel while the cursor sits on the spot of interest. The scroll offset is applied in a `useLayoutEffect` so it lands on the same frame the canvas resizes, with no visible jump. `Shift` + `Wheel` is left to the browser for native horizontal scroll. The two-finger touch pinch on touchpads/tablets is unchanged. Cursor switches to `zoom-in` over the image to advertise the gesture.
- Loading indicator for image imports. The dropzone (and a small floating pill in the editor header, used when the editor is already open and the user pastes a new file) now shows a contextual "Importing…" panel with a spinner, the file name, and the file size while the import is running. Indeterminate progress (no fake progress bar) because we don't have byte-level progress from `heicTo` or `Image.decode()`. The same loading state covers every entry point: drop, file picker, dropzone-focused paste, and the new global `Cmd+V` handler.
- Global `Cmd+V` paste handler. The README has always advertised `Cmd+V` as a way to import an image, but the actual handler was attached to the dropzone's `onPaste` — which only fires when the dropzone has focus. A new `window.addEventListener("paste", ...)` in `Index.tsx` covers the rest of the page. It's gated on `image !== null` (i.e. the editor is open) so it doesn't double-fire with the dropzone's own handler.

### Changed
- Preview debounce remains 16 ms; export debounce raised to 250 ms to keep full-res renders from queuing on a fast slider.
- HEIC import order flipped: convert-to-JPEG first via `heic-to`, with the native `Image` decoder as a second-chance fallback (was: native first, which always failed on non-Safari and cost an `objectURL` round trip per file).
- `useFilter` rewritten against the singleton broker. The hook no longer owns a `Worker`, no longer manages request/response ids, and no longer needs the RAF coalescing + `flushQueue` ref pattern.
- CI: `npm run lint` added to the existing `npm test` / `npm run build` pipeline.
- ESLint: `@typescript-eslint/no-unused-vars` re-enabled as a warning (with `_`-prefix opt-out) so dead imports are visible.

### Fixed
- Empty `interface` declarations in `command.tsx` and `textarea.tsx` converted to `type` aliases (lint errors).
- `require()` call in `tailwind.config.ts` replaced with an ESM `import` (lint error).
- `useEffect` missing-dep warning on `useFilter`'s `flushQueue` resolved by routing through a `flushQueueRef`.
- `vite.config.ts`: `lovable-tagger` is now opt-in (dev + `LOVABLE=1` env) and dynamically imported, so production builds don't ship it.

### Removed
- Dead `src/lib/filter-engine/presets.ts` barrel (re-exports from `../filters/presets`); callers updated to import from the source.
- `bun.lock` and `bun.lockb` removed from the index; `package-lock.json` is the only lockfile. `.gitignore` updated to match.

## [0.1.0] — 2026-03-12

Initial rebrand of the FILTR scaffold to **insta-studio**. Captures the work
from `e172703` and the commits that followed.

### Added
- HEIC and HEIF import support with `heic-to` conversion and graceful error toasts (`unsupported-format`, `heic-conversion-failed`, `image-decode-failed`).
- Reveal transition between presets: a clip-path-driven "magic" pass that masks the new image as the old one fades.
- Blacksmith CI/CD workflow running `npm test` and `npm run build`, with a `deploy` job that promotes main to Vercel production.
- Premium preset library: Minimal Rich, Aesthetic Soft, Clean Luxury, Monochrome Premium, Golden Hour, Moody Mono, Vivid Color, Low Light Film, Soft Portrait, Food True, Urban Street, Indoor Warm. Each carries an `AdaptiveTuning` block (portrait protection, saturation guard, highlight recovery, shadow safety, low-light restraint, indoor/outdoor moderation) and a `sceneAffinity` map used by the recommender.
- Composable filter engine: tonal (brightness, contrast, highlights, shadows, whites, blacks), color (temperature, tint, saturation, vibrance, HSL, tone curve, split toning), detail (clarity, sharpness, bloom), finish (fade, grain, vignette). Each pass is gated so the expensive ones (bloom, detail enhancement) only run when their adjustment is non-zero.
- Scene-aware `analyzeImageData` computing per-tag likelihoods (portrait, food, lifestyle, street, indoor, outdoor, bright, lowLight, colorful, flat, overexposed, underexposed).
- `recommendPresets` scoring + reasons for the top-N matches surfaced in the sidebar.
- Side-by-side compare slider with a draggable seam and a "drag slider on image" hint, plus a "Before" toggle bound to `Space`.
- Bottom bar with export pipeline: format (JPG/PNG), quality, size (original / 2x / 50%), watermark toggle, download, and clipboard copy.
- Keyboard shortcuts in the drop-zone footer: arrows to cycle, hold Space for original, Cmd/Ctrl+S to export, R to reset, Cmd/Ctrl+V to paste an image.
- Image drop / paste / browse ingestion with a focused DropZone.
- Vite + React + Tailwind + shadcn/ui scaffold, plus Radix primitives for the command palette, dialogs, popovers, and tabs.

[Unreleased]: https://github.com/your-org/insta-studio/compare/0.1.0...HEAD
[0.1.0]: https://github.com/your-org/insta-studio/releases/tag/0.1.0
