import "@testing-library/jest-dom";
// fake-indexeddb provides a working IndexedDB on jsdom. The recents
// storage layer is dependency-injected on the IDB factory, so the real
// production path also goes through this. The polyfill is imported for
// its side effect of seeding `globalThis.indexedDB`.
import "fake-indexeddb/auto";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

class MockImageData implements ImageData {
  readonly colorSpace = "srgb" as const;
  readonly data: Uint8ClampedArray;
  readonly height: number;
  readonly width: number;

  // jsdom's real `ImageData` accepts either (Uint8ClampedArray, w, h)
  // OR (width, height). Tests use the latter; without it, `data.slice()`
  // in the worker broker throws "next.source.data.slice is not a
  // function" because the `data` slot is a number.
  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
    if (typeof dataOrWidth === "number") {
      const w = dataOrWidth;
      const h = widthOrHeight ?? 1;
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
      return;
    }
    this.data = dataOrWidth;
    this.width = widthOrHeight ?? 0;
    this.height = height ?? 0;
  }
}

Object.defineProperty(globalThis, "ImageData", {
  writable: true,
  configurable: true,
  value: MockImageData,
});

// jsdom's `Blob` predates `Blob.prototype.text()`. Polyfill it once at
// setup time so any test that round-trips a blob (e.g. the recents
// storage round-trip) can call `.text()`.
if (typeof Blob !== "undefined") {
  const proto = Blob.prototype as Blob & { text?: () => Promise<string> };
  if (typeof proto.text !== "function") {
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
}
