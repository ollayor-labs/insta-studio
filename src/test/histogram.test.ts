import { describe, expect, it } from "vitest";
import { analyzeImageData, detectClippingFromImageData } from "@/lib/filterEngine";

function createImageData(width: number, height: number, pixels: number[]): ImageData {
  return new ImageData(Uint8ClampedArray.from(pixels), width, height);
}

describe("histogram and clipping", () => {
  it("populates luminance and per-channel histograms for the source image", () => {
    const source = createImageData(2, 2, [
      10, 20, 30, 255,
      80, 100, 120, 255,
      200, 180, 160, 255,
      250, 240, 230, 255,
    ]);
    const analysis = analyzeImageData(source);

    expect(analysis.histogram.luminance).toBeInstanceOf(Uint16Array);
    expect(analysis.histogram.luminance.length).toBe(256);

    const rSum = analysis.channelHistogram.r.reduce((acc, value) => acc + value, 0);
    const gSum = analysis.channelHistogram.g.reduce((acc, value) => acc + value, 0);
    const bSum = analysis.channelHistogram.b.reduce((acc, value) => acc + value, 0);
    expect(rSum).toBe(4);
    expect(gSum).toBe(4);
    expect(bSum).toBe(4);

    expect(analysis.channelHistogram.r[250]).toBe(1);
    expect(analysis.channelHistogram.g[240]).toBe(1);
    expect(analysis.channelHistogram.b[230]).toBe(1);
  });

  it("flags clipping channels when extreme values exceed 0.5% of samples", () => {
    // source is built below
    const data = new Uint8ClampedArray(10 * 10 * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 255;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
    const analysis = analyzeImageData(new ImageData(data, 10, 10));
    expect(analysis.clippingChannels.highlight.r).toBe(true);
    expect(analysis.clippingChannels.shadow.g).toBe(true);
    expect(analysis.clippingChannels.shadow.b).toBe(true);
  });

  it("does not flag clipping for a balanced mid-tone image", () => {
    // source is built below
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 128;
      data[index + 1] = 128;
      data[index + 2] = 128;
      data[index + 3] = 255;
    }
    const analysis = analyzeImageData(new ImageData(data, 4, 4));
    expect(analysis.clippingChannels.highlight.r).toBe(false);
    expect(analysis.clippingChannels.highlight.g).toBe(false);
    expect(analysis.clippingChannels.highlight.b).toBe(false);
    expect(analysis.clippingChannels.shadow.r).toBe(false);
    expect(analysis.clippingChannels.shadow.g).toBe(false);
    expect(analysis.clippingChannels.shadow.b).toBe(false);
  });

  it("detects clipping from any ImageData independent of analysis", () => {
    const data = new Uint8ClampedArray(4 * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 254;
      data[index + 1] = 254;
      data[index + 2] = 254;
      data[index + 3] = 255;
    }
    const imageData = new ImageData(data, 2, 1);
    const clipping = detectClippingFromImageData(imageData);
    expect(clipping.highlight.r).toBe(true);
    expect(clipping.highlight.g).toBe(true);
    expect(clipping.highlight.b).toBe(true);
    expect(clipping.shadow.r).toBe(false);
  });
});
