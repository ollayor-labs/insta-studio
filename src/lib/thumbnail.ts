// Small image thumbnailer used by the recents store. Generates a
// downscaled JPEG preview from a source Blob so the recents list can
// show a real preview without holding full-resolution source bytes in
// the page's JS heap. A 128px-on-the-long-edge JPEG is in the
// single-digit KB range, so 12 of them is well under 100KB resident.

const THUMBNAIL_MAX_DIMENSION = 128;
const THUMBNAIL_QUALITY = 0.78;
const THUMBNAIL_MIME_TYPE = "image/jpeg";

/**
 * Build a tiny JPEG preview of `blob`. The blob is decoded into an
 * HTMLImageElement, drawn onto an offscreen canvas at the target size
 * (preserving aspect ratio), and re-encoded via
 * `canvas.toBlob("image/jpeg", ...)`. Returns `null` on any failure
 * (decode error, canvas readback blocked, very small source) so the
 * caller can keep the recents record without a preview rather than
 * rejecting the import.
 */
export async function createThumbnail(blob: Blob): Promise<Blob | null> {
  if (blob.size <= 16 * 1024) {
    try {
      const url = URL.createObjectURL(blob);
      try {
        const probe = await probeImage(url);
        if (probe.width <= THUMBNAIL_MAX_DIMENSION && probe.height <= THUMBNAIL_MAX_DIMENSION) {
          return blob;
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      // Fall through to the normal canvas path.
    }
  }

  let url: string | null = null;
  try {
    url = URL.createObjectURL(blob);
    const image = await loadImage(url);
    const { width, height } = fitInside(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      THUMBNAIL_MAX_DIMENSION,
    );
    if (width <= 0 || height <= 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    return await canvasToBlob(canvas, THUMBNAIL_MIME_TYPE, THUMBNAIL_QUALITY);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function fitInside(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= maxDimension) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("thumbnail: image decode failed"));
    };
    image.src = url;
  });
}

function probeImage(url: string): Promise<{ width: number; height: number }> {
  return loadImage(url).then((image) => ({
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }));
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (result) => resolve(result),
      type,
      quality,
    );
  });
}
