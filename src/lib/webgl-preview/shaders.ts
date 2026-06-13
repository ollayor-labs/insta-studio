/**
 * GLSL shader sources for the per-pixel preview pipeline. The
 * shaders live in `.glsl` files (see `./glsl/`) and are loaded as
 * raw strings via Vite's `?raw` query suffix. This keeps the GLSL
 * out of the TypeScript source so the SWC parser doesn't try to
 * interpret `#version 300 es` and `precision highp float;` as
 * JavaScript.
 *
 * The shader implements the per-pixel base+final passes from
 * `src/lib/filters/index.ts`. The blur-based passes (clarity,
 * sharpness, bloom) stay on the JS engine -- the WebGL backend
 * falls back to JS for those.
 */
import vertexSource from "./glsl/vertex.glsl?raw";
import fragmentSource from "./glsl/fragment.glsl?raw";

export const PER_PIXEL_VERTEX_SHADER: string = vertexSource;
export const PER_PIXEL_FRAGMENT_SHADER: string = fragmentSource;
