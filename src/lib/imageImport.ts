const BROWSER_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const HEIC_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

const BROWSER_IMAGE_EXTENSIONS = new Set([
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

const HEIC_IMAGE_EXTENSIONS = new Set([
  ".heic",
  ".heif",
]);

const ACCEPTED_IMAGE_TYPES = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ...BROWSER_IMAGE_MIME_TYPES,
  ...HEIC_IMAGE_MIME_TYPES,
];

export const IMAGE_INPUT_ACCEPT = ACCEPTED_IMAGE_TYPES.join(",");

export type ImageImportErrorCode =
  | "unsupported-format"
  | "heic-conversion-failed"
  | "image-decode-failed";

export class ImageImportError extends Error {
  readonly code: ImageImportErrorCode;

  constructor(code: ImageImportErrorCode, message: string) {
    super(message);
    this.name = "ImageImportError";
    this.code = code;
  }
}

function getFileExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf(".");
  return lastDotIndex === -1 ? "" : name.slice(lastDotIndex).toLowerCase();
}

export function isHeicLikeFile(file: Pick<File, "name" | "type">): boolean {
  const normalizedType = file.type.trim().toLowerCase();
  return HEIC_IMAGE_MIME_TYPES.has(normalizedType) || HEIC_IMAGE_EXTENSIONS.has(getFileExtension(file.name));
}

function isBrowserReadableImageFile(file: Pick<File, "name" | "type">): boolean {
  const normalizedType = file.type.trim().toLowerCase();
  return BROWSER_IMAGE_MIME_TYPES.has(normalizedType) || BROWSER_IMAGE_EXTENSIONS.has(getFileExtension(file.name));
}

export function isSupportedImageFile(file: Pick<File, "name" | "type">): boolean {
  return isBrowserReadableImageFile(file) || isHeicLikeFile(file);
}

export function normalizeHeicConversionResult(blob: Blob): Blob {
  if (!blob) {
    throw new ImageImportError("heic-conversion-failed", "The HEIC file could not be converted.");
  }

  if (blob.type === "image/jpeg") {
    return blob;
  }

  if (!blob.type) {
    return new Blob([blob], { type: "image/jpeg" });
  }

  return blob;
}

async function convertHeicFile(file: File): Promise<Blob> {
  const { heicTo } = await import("heic-to");

  const converted = await heicTo({
    blob: file,
    type: "image/jpeg",
    quality: 0.92,
  });

  return normalizeHeicConversionResult(converted);
}

export async function loadBlobAsImage(
  blob: Blob,
  errorCode: ImageImportErrorCode = "image-decode-failed",
): Promise<LoadImportedImageResult> {
  const objectUrl = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";

    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(objectUrl);
    };

    image.onload = () => {
      cleanup();
      resolve({ image, blob });
    };

    image.onerror = () => {
      cleanup();
      reject(new ImageImportError(errorCode, "The image could not be decoded in this browser."));
    };

    image.src = objectUrl;
  });
}

export interface LoadImportedImageResult {
  image: HTMLImageElement;
  blob: Blob;
}

export async function loadImportedImage(file: File): Promise<LoadImportedImageResult> {
  if (!isSupportedImageFile(file)) {
    throw new ImageImportError("unsupported-format", "This file format is not supported.");
  }

  if (!isHeicLikeFile(file)) {
    return await loadBlobAsImage(file);
  }

  // HEIC files: convert to JPEG first, then decode. The previous order tried
  // the browser-native decoder first, which always fails on non-Safari
  // engines and costs an object URL + Image decode attempt per file. Going
  // straight to the JS converter avoids that wasted round trip and gives
  // consistent behavior across browsers. We still fall back to the native
  // decoder if conversion throws so that future engines (e.g. a WebView
  // gaining HEIC support) keep working.
  //
  // Error mapping: if the converter throws a non-ImageImportError, the
  // file is HEIC and the conversion genuinely failed — track that so
  // the second-chance path can map the final failure to
  // `heic-conversion-failed` (a regular decode error would otherwise
  // be surfaced as `image-decode-failed` and the user would see the
  // wrong toast for what's really a HEIC problem).
  let converterFailed = false;
  try {
    const converted = await convertHeicFile(file);
    return await loadBlobAsImage(converted);
  } catch (conversionError) {
    if (conversionError instanceof ImageImportError && conversionError.code !== "heic-conversion-failed") {
      throw conversionError;
    }
    converterFailed = true;
  }

  try {
    return await loadBlobAsImage(file);
  } catch (nativeError) {
    if (nativeError instanceof ImageImportError) {
      if (nativeError.code === "image-decode-failed" && converterFailed) {
        throw new ImageImportError("heic-conversion-failed", "The HEIC image could not be converted.");
      }
      throw nativeError;
    }
    throw new ImageImportError("heic-conversion-failed", "The HEIC image could not be converted.");
  }
}
