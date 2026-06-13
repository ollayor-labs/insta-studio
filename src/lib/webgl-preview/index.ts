/**
 * Preview backend abstraction. The broker dispatches a render to
 * either a JS worker backend (the existing path) or a WebGL2
 * fragment-shader backend, depending on the consumer and the host
 * capability. The WebGL backend's `webglcontextlost` handler
 * automatically routes future renders to JS for the rest of the
 * session, so a lost GPU context never breaks the user-visible
 * preview.
 */
export type { PreviewBackend, PreviewBackendKind, RenderRequest, RenderResult, RenderRejection, RenderOutcome, PreviewAbortSignal } from "./types";
export { JsBackend } from "./js-backend";
export type { JsBackendInit } from "./js-backend";
export { WebGlBackend, isWebGlPreviewSupported } from "./webgl-backend";
export type { WebGlBackendState, WebGlBackendOptions } from "./webgl-backend";
export {
  setPreviewBackendPolicy,
  getPreviewBackendPolicy,
  settingsRequireBlurPasses,
  setWebGlDegraded,
  isWebGlDegraded,
  type BackendFactory,
  type PreviewBackendPolicy,
} from "./selection";
