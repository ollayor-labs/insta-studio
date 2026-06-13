# insta-studio

Premium image filter studio built with React, TypeScript, and a modular canvas-based grading engine.

## Development

```sh
npm install
npm run dev
```

Validation:

```sh
npm test
npm run build
```

See [ARCHITECTURE.md](/Users/ollayor/Code/Projects/filtr-studio/ARCHITECTURE.md) for the engine/worker/React topology and request-lifecycle diagrams, and [CHANGELOG.md](/Users/ollayor/Code/Projects/filtr-studio/CHANGELOG.md) for a running history of engine and UI changes.

## Export Quality

Exports run through a Float32 (0..1 per channel) pipeline internally and clamp to 8-bit only once at the end. The live preview stays on the faster Uint8 path. The Float32 path keeps sub-LSB precision across the chain, so smooth gradients (sky, shadow falloff) export without the visible banding you get from repeatedly clamping each pass to 0..255. Toggle the precision back to `uint8` by passing `precision: "uint8"` (the default) to `applyFilterToImageData`.

## Animated Reveal

The `Reveal` button in the bottom bar (or `Shift + C`) plays a 3-second animated before/after reveal: it auto-cycles the compare slider from 0 → 100 → 0 with a sine ease, so the source is on the left and the filtered output is on the right while the divider sweeps back and forth. If compare mode is off, the button turns it on automatically. Dragging the slider manually mid-animation cancels the auto-cycle and hands control back. Status is reflected in the button label (`Revealing…`) and the helper chip (`Auto-cycling`).

## Export Formats

The format selector in the bottom bar offers JPG, PNG, WebP, and Original. JPG and WebP are lossy and respect the quality slider; PNG is lossless (quality slider is disabled). Original honors the source file's MIME if it's PNG / JPEG / WebP and falls back to JPG otherwise, so HEIC and other browser-unencodable sources still produce a usable export. The filename extension always matches the actual export (e.g., `…_soft_portrait_20260613_1842.webp`).

## EXIF Preservation

Imports pull the raw EXIF TIFF payload out of the source (JPEG, PNG, and WebP) and store it on the recent's IndexedDB record. On export, the payload is spliced back into the new bytes in format-appropriate places — JPEG gets the APP1 segment with the `Exif\0\0` preamble right after SOI, PNG gets an `eXIf` chunk with a valid CRC32 right before `IEND`, and WebP gets an `EXIF` RIFF chunk with the file size header updated. The on-disk shape is format-agnostic (bare TIFF) so the same stored bytes can re-enter any output format. The reader is segment-only — the TIFF IFD tree is preserved as an opaque payload, not parsed.

## Recent Images

The empty state (no image loaded) surfaces a 12-entry recents grid under the dropzone. Each entry stores the original file as a `Blob` in IndexedDB (`filtr-studio` database, `recents` store) and reopens it through the same import pipeline. The list is capped; opening a new image evicts the oldest entry. Hover an entry to reveal a remove button; the header has a clear-all action.

The storage layer is dependency-injected on the IDB factory, so it falls back to a no-op (`recentsSupported: false`) on browsers without IndexedDB and is unit-testable without a real engine.

## Favorite Presets

Shift-click any preset card (built-in or custom) to mark it as a favorite. The card shows a small numeric chip in its top-left corner, and pressing that number key (1–9) anywhere on the page applies the favorite. Shift-click again to remove. The lowest empty slot wins when assigning, so the first favorite goes to `1`, the second to `2`, and so on. Favorites are stored under the `filtr.favorites` localStorage key, independent of custom-preset records.

## Keyboard Shortcuts

The editor responds to these shortcuts anywhere on the page (text inputs and contenteditable elements are ignored):

| Shortcut | Action |
| --- | --- |
| Hold `Space` | Preview the original, unedited image |
| `←` / `→` | Cycle through the previous / next preset |
| `R` | Reset manual adjustments to the active preset's defaults |
| `1` – `9` | Apply the favorite preset stored in that slot (if any) |
| `Shift` + `C` | Play a 3-second animated before/after reveal (auto-cycles the compare slider) |
| `Cmd` / `Ctrl` + `S` | Export the current image (same as the Export button) |

The drop-zone landing page also surfaces a paste shortcut:

| Shortcut | Action |
| --- | --- |
| `Cmd` / `Ctrl` + `V` | Paste an image from the clipboard (DropZone) |


## Product Direction

insta-studio is focused on realistic, premium, social-ready image grading:

- premium presets instead of loud novelty effects
- scene-aware adaptation for portraits, bright scenes, low-light images, indoor photos, and already-colorful files
- consistent results across lifestyle, food, portrait, street, and indoor imagery
- clean preset strength control and compare workflows

## Architecture

The filter engine now lives under [`src/lib/filter-engine`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine):

- [`types.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/types.ts): core adjustment, preset, analysis, and recommendation types
- [`presets.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/presets.ts): premium preset definitions, scene affinity, moods, and rationale
- [`analysis.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/analysis.ts): fast image-scene analysis used for adaptive grading and recommendations
- The composable execution pipeline lives in [`src/lib/filters/index.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filters/index.ts) (the legacy `src/lib/filter-engine/renderer.ts` barrel is a placeholder).
- [`recommendation.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/recommendation.ts): best-match scoring for presets
- [`storage.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/storage.ts): local-storage architecture for custom presets
- [`raster.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/raster.ts): shared image raster extraction helpers

The legacy facade at [`src/lib/filterEngine.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filterEngine.ts) remains as the compatibility entrypoint for the UI.

## Rendering Model

Each render pass follows this order:

1. Resolve preset definition, preset strength, manual adjustments, and scene adaptation.
2. Apply tonal shaping: brightness, contrast, highlights, shadows, whites, blacks.
3. Apply color shaping: temperature, tint, saturation, vibrance, HSL, tone curve, split toning.
4. Apply detail passes only when needed: clarity, sharpness, bloom.
5. Apply finishing passes: fade, grain, vignette.

This keeps preset definitions declarative and makes the execution path easier to extend.

## Performance Notes

- The editor uses a preview raster capped to a maximum dimension for interactive rendering.
- Export uses the full-resolution raster and the higher-quality render path.
- Scene analysis is computed once per loaded image and reused for preview, swatches, recommendations, and export.
- Expensive passes like bloom and detail enhancement only run when their adjustment values are non-zero.

## Tests

Critical engine behavior is covered in [`src/test/filter-engine.test.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/test/filter-engine.test.ts):

- zero-strength preset neutrality
- preset-strength scaling
- portrait-aware recommendation scoring
- monochrome output integrity

## Known Follow-Up

- The app-level ESLint run currently fails because of pre-existing issues in scaffolded UI files outside the filter-engine work.
- Custom preset persistence is implemented at the architecture layer but not yet surfaced in the UI.
- The renderer is still CPU/canvas based; GPU acceleration should only be considered after profiling larger export workloads.
