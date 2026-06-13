// Test helper: install a small set of jsdom-incompatible globals. The
// real test environment is jsdom (vitest default), which ships a
// `Blob` without `Blob.prototype.text()` and an `ImageData` whose
// `.data` field is a plain `Uint8Array` rather than a `Uint8ClampedArray`.
// This helper patches both so the brokers and recents tests can run.

import { vi } from "vitest";

class MockImageData implements ImageData {
  readonly colorSpace = "srgb";
  readonly data: Uint8ClampedArray;
  readonly height: number;
  readonly width: number;

  constructor(data: Uint8ClampedArray | number[], width: number, height: number) {
    this.data = data instanceof Uint8ClampedArray ? data : Uint8ClampedArray.from(data);
    this.width = width;
    this.height = height;
  }
}

function polyfillBlobText(): void {
  if (typeof Blob === "undefined") return;
  const proto = Blob.prototype as Blob & { text?: () => Promise<string> };
  if (typeof proto.text === "function") return;
  Object.defineProperty(proto, "text", {
    configurable: true,
    writable: true,
    value: function text(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error ?? new Error("Blob.text failed"));
        reader.readAsText(this);
      });
    },
  });
}

export function installMockGlobals(): void {
  polyfillBlobText();
  vi.stubGlobal("ImageData", MockImageData);
}

export function uninstallMockGlobals(): void {
  vi.unstubAllGlobals();
}
