import { describe, expect, it, beforeEach } from "vitest";
import {
  clearFavoriteSlot,
  FAVORITE_SLOTS,
  getFavoritePresetId,
  loadFavorites,
  setFavoriteSlot,
} from "@/lib/filterEngine";

const STORAGE_KEY = "filtr.favorites";

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("favorites storage", () => {
  it("returns an empty map when nothing has been stored", () => {
    expect(loadFavorites()).toEqual({});
  });

  it("stores and reads back a single slot", () => {
    setFavoriteSlot(3, "preset-soft-portrait");
    const map = loadFavorites();
    expect(map[3]).toBe("preset-soft-portrait");
    expect(getFavoritePresetId(map, 3)).toBe("preset-soft-portrait");
    expect(getFavoritePresetId(map, 1)).toBeUndefined();
  });

  it("rejects non-integer or out-of-range slots", () => {
    setFavoriteSlot(3, "ok");
    // Force-write a bogus slot directly to the storage and ensure loadFavorites
    // drops it on read.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "0": "zero", "10": "ten", "abc": "abc", "3": "kept" }),
    );
    const map = loadFavorites();
    expect(map[3]).toBe("kept");
    expect(Object.keys(map)).toEqual(["3"]);
  });

  it("rejects non-string preset ids on read", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "5": 42, "6": null, "7": "ok" }),
    );
    const map = loadFavorites();
    expect(map[5]).toBeUndefined();
    expect(map[6]).toBeUndefined();
    expect(map[7]).toBe("ok");
  });

  it("clears a single slot", () => {
    setFavoriteSlot(1, "a");
    setFavoriteSlot(2, "b");
    clearFavoriteSlot(1);
    const map = loadFavorites();
    expect(map[1]).toBeUndefined();
    expect(map[2]).toBe("b");
  });

  it("supports the full 1-9 slot range", () => {
    for (const slot of FAVORITE_SLOTS) {
      setFavoriteSlot(slot, `preset-${slot}`);
    }
    const map = loadFavorites();
    for (const slot of FAVORITE_SLOTS) {
      expect(map[slot]).toBe(`preset-${slot}`);
    }
  });

  it("overwrites a slot when reassigned", () => {
    setFavoriteSlot(4, "first");
    setFavoriteSlot(4, "second");
    expect(loadFavorites()[4]).toBe("second");
  });

  it("returns an empty map for malformed JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(loadFavorites()).toEqual({});
  });

  it("returns an empty map for non-object JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadFavorites()).toEqual({});
  });
});
