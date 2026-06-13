import { beforeEach, describe, expect, it, vi } from "vitest";
import { heicTo } from "heic-to";
import {
  IMAGE_INPUT_ACCEPT,
  ImageImportError,
  isHeicLikeFile,
  isSupportedImageFile,
  loadImportedImage,
  normalizeHeicConversionResult,
} from "@/lib/imageImport";

vi.mock("heic-to", () => ({
  heicTo: vi.fn(),
}));

const heicToMock = vi.mocked(heicTo);
const createObjectUrlMock = vi.fn(() => "blob:mock-url");
const revokeObjectUrlMock = vi.fn();

let imageLoadOutcomes: boolean[] = [];

class MockImage {
  decoding = "auto";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private currentSrc = "";

  get src() {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
    const shouldFail = imageLoadOutcomes.length > 0 ? imageLoadOutcomes.shift() ?? false : false;

    queueMicrotask(() => {
      if (shouldFail) {
        this.onerror?.();
        return;
      }

      this.onload?.();
    });
  }
}

describe("image import", () => {
  beforeEach(() => {
    heicToMock.mockReset();
    createObjectUrlMock.mockClear();
    revokeObjectUrlMock.mockClear();
    imageLoadOutcomes = [];

    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      value: createObjectUrlMock,
    });

    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      value: revokeObjectUrlMock,
    });

    Object.defineProperty(globalThis, "Image", {
      writable: true,
      value: MockImage,
    });
  });

  it("recognizes HEIC files by MIME type and extension", () => {
    expect(isHeicLikeFile(new File(["heic"], "portrait.jpg", { type: "image/heic" }))).toBe(true);
    expect(isHeicLikeFile(new File(["heic"], "portrait.HEIF", { type: "" }))).toBe(true);
    expect(isHeicLikeFile(new File(["jpg"], "portrait.jpg", { type: "image/jpeg" }))).toBe(false);
  });

  it("recognizes supported formats even when MIME type is missing", () => {
    expect(isSupportedImageFile(new File(["png"], "sample.png", { type: "" }))).toBe(true);
    expect(isSupportedImageFile(new File(["heic"], "sample.heic", { type: "" }))).toBe(true);
    expect(isSupportedImageFile(new File(["txt"], "sample.txt", { type: "text/plain" }))).toBe(false);
  });

  it("includes HEIC and HEIF in the file input accept list", () => {
    expect(IMAGE_INPUT_ACCEPT).toContain(".heic");
    expect(IMAGE_INPUT_ACCEPT).toContain(".heif");
  });

  it("uses the native load path for browser-readable files", async () => {
    const file = new File(["png"], "sample.png", { type: "image/png" });

    await loadImportedImage(file);

    expect(heicToMock).not.toHaveBeenCalled();
    expect(createObjectUrlMock).toHaveBeenCalledWith(file);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-url");
  });

  it("converts HEIC files before loading them", async () => {
    const file = new File(["heic"], "sample.HEIC", { type: "" });
    const convertedBlob = new Blob(["jpeg"], { type: "image/jpeg" });
    heicToMock.mockResolvedValue(convertedBlob);

    await loadImportedImage(file);

    expect(heicToMock).toHaveBeenCalledWith({
      blob: file,
      type: "image/jpeg",
      quality: 0.92,
    });
    expect(createObjectUrlMock).toHaveBeenCalledWith(convertedBlob);
    expect(createObjectUrlMock).not.toHaveBeenCalledWith(file);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-url");
  });

  it("falls back to native decode if HEIC conversion fails", async () => {
    const file = new File(["heic"], "sample.HEIC", { type: "" });
    heicToMock.mockRejectedValue(new Error("boom"));

    await loadImportedImage(file);

    expect(heicToMock).toHaveBeenCalled();
    expect(createObjectUrlMock).toHaveBeenCalledWith(file);
  });

  it("surfaces a heic-conversion-failed error when both conversion and native decode fail", async () => {
    const file = new File(["heic"], "sample.HEIC", { type: "" });
    heicToMock.mockRejectedValue(new Error("boom"));
    imageLoadOutcomes = [true];

    await expect(loadImportedImage(file)).rejects.toMatchObject<ImageImportError>({
      code: "heic-conversion-failed",
      message: "The HEIC image could not be converted.",
    });
  });



  it("normalizes converted blobs that do not report a MIME type", () => {
    const convertedBlob = new Blob(["jpeg"]);

    expect(normalizeHeicConversionResult(convertedBlob).type).toBe("image/jpeg");
  });

  it("maps HEIC conversion failures to a dedicated import error", async () => {
    const file = new File(["heic"], "sample.heic", { type: "image/heic" });
    imageLoadOutcomes = [true];
    heicToMock.mockRejectedValue(new Error("boom"));

    await expect(loadImportedImage(file)).rejects.toMatchObject<ImageImportError>({
      code: "heic-conversion-failed",
      message: "The HEIC image could not be converted.",
    });
  });

  it("maps decode failures to a dedicated import error", async () => {
    const file = new File(["jpeg"], "sample.jpg", { type: "image/jpeg" });
    imageLoadOutcomes = [true];

    await expect(loadImportedImage(file)).rejects.toMatchObject<ImageImportError>({
      code: "image-decode-failed",
      message: "The image could not be decoded in this browser.",
    });

    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-url");
  });
});
