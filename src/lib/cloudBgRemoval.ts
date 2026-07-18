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
  const width =
    source instanceof ImageBitmap
      ? source.width
      : source.naturalWidth || source.width;
  const height =
    source instanceof ImageBitmap
      ? source.height
      : source.naturalHeight || source.height;

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
    if (controller.signal.aborted) {
      throw { kind: "timeout" } satisfies CloudBgRemovalError;
    }
    throw { kind: "network" } satisfies CloudBgRemovalError;
  } finally {
    clearTimeout(timeout);
  }

  const err = classifyResponse(res.status);
  if (err) throw err;

  return maskFromPngBlob(await res.blob(), width, height);
}
