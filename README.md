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
- [`renderer.ts`](/Users/ollayor/Code/Projects/filtr-studio/src/lib/filter-engine/renderer.ts): composable execution pipeline for tonal work, color work, detail, bloom, grain, and vignette
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
