/// <reference lib="webworker" />

// On-device background removal worker using @huggingface/transformers.
//
// Model: onnx-community/BiRefNet_lite (MIT license — commercial safe).
// The model (~44MB) is downloaded once and cached by the browser
// (transformers.js uses the Cache Storage API by default).
//
// Messages IN:
//   { type: "init" }
//   { type: "run", bitmap: ImageBitmap }
// Messages OUT:
//   { type: "progress", value: number }   // 0..100 model download
//   { type: "ready" }
//   { type: "result", mask: ArrayBuffer, width, height }  // mask transferred
//   { type: "error", message: string }

import {
  AutoModel,
  AutoProcessor,
  RawImage,
  env,
  // Types are loose across transformers.js versions; treat as any where needed.
} from "@huggingface/transformers";

// Never look for models on the local dev server — always fetch from the Hub
// (and cache in the browser).
env.allowLocalModels = false;

const MODEL_ID = "onnx-community/BiRefNet_lite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processor: any = null;
let initPromise: Promise<void> | null = null;

function post(message: unknown, transfer?: Transferable[]) {
  if (transfer && transfer.length) {
    (self as unknown as Worker).postMessage(message, transfer);
  } else {
    (self as unknown as Worker).postMessage(message);
  }
}

function pickDeviceOptions(): { device: string; dtype: string } {
  // WebGPU when available (fast, fp16); otherwise WASM (works everywhere,
  // single-threaded when the page is not cross-origin isolated).
  const hasWebGPU = typeof (navigator as unknown as { gpu?: unknown }).gpu !== "undefined" &&
    (navigator as unknown as { gpu?: unknown }).gpu != null;
  return hasWebGPU
    ? { device: "webgpu", dtype: "fp16" }
    : { device: "wasm", dtype: "q8" };
}

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { device, dtype } = pickDeviceOptions();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const progress_callback = (data: any) => {
      // from_pretrained emits { status, progress, ... } events. We surface
      // download progress (0..100) so the UI can show a bar.
      if (data && typeof data.progress === "number") {
        post({ type: "progress", value: Math.max(0, Math.min(100, data.progress)) });
      }
    };

    model = await AutoModel.from_pretrained(MODEL_ID, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      device: device as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dtype: dtype as any,
      progress_callback,
    });

    processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback,
    });

    post({ type: "progress", value: 100 });
    post({ type: "ready" });
  })();

  return initPromise;
}

async function rawImageFromBitmap(bitmap: ImageBitmap): Promise<RawImage> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context in worker.");
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob();
  return RawImage.fromBlob(blob);
}

// Extract a single-channel 0..255 mask from the model output, resized to the
// requested source width/height using nearest/bilinear via RawImage.resize.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function maskFromOutput(output: any, width: number, height: number): Promise<Uint8Array> {
  // BiRefNet outputs a saliency map. Depending on version the tensor lives
  // under different keys; probe the common ones.
  const tensor =
    output?.output ??
    output?.logits ??
    output?.last_hidden_state ??
    (Array.isArray(output) ? output[0] : output);

  if (!tensor) throw new Error("Model output did not contain a saliency map.");

  // Some builds return an array of tensors (multi-scale); take the last
  // (highest-resolution) one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t: any = Array.isArray(tensor) ? tensor[tensor.length - 1] : tensor;

  // Squeeze to [1, H, W] then convert to a grayscale RawImage. sigmoid()
  // maps logits to 0..1; .mul(255) scales to a viewable image.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const image: any = await RawImage.fromTensor(
    t.sigmoid().mul(255).to("uint8"),
  );

  // Resize the mask to the source size and force a single channel.
  const resized = await image.resize(width, height);
  const gray = resized.channels === 1 ? resized : await resized.grayscale();

  // gray.data is a Uint8ClampedArray/Uint8Array of length width*height.
  const src = gray.data as Uint8Array | Uint8ClampedArray;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = src[i];
  return mask;
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  try {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "init") {
      await ensureInit();
      return;
    }

    if (msg.type === "run") {
      await ensureInit();

      const bitmap: ImageBitmap = msg.bitmap;
      const width = bitmap.width;
      const height = bitmap.height;

      const rawImage = await rawImageFromBitmap(bitmap);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inputs = await processor(rawImage);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output = await model(inputs);

      const mask = await maskFromOutput(output, width, height);

      // Free the bitmap now that we've consumed it.
      try {
        bitmap.close();
      } catch {
        /* ignore */
      }

      post(
        { type: "result", mask: mask.buffer, width, height },
        [mask.buffer],
      );
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: "error", message });
  }
};
