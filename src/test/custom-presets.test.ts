import { beforeEach, describe, expect, it } from "vitest";
import {
  createCustomPresetRecord,
  customPresetsToDefinitions,
  deleteCustomPreset,
  getFilterPresetByIdWithCustom,
  getFilterPresetByNameWithCustom,
  loadCustomPresets,
  saveCustomPreset,
} from "@/lib/filterEngine";

const STORAGE_KEY = "filtr.custom-presets";

describe("custom presets", () => {
  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("creates a record with a UUID id and trimmed fields", () => {
    const record = createCustomPresetRecord({
      name: "  My look  ",
      basePresetId: "minimal-rich",
      strength: 0.78,
      adjustments: { contrast: 12, vibrance: 6 },
      note: "  for night shots  ",
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.name).toBe("My look");
    expect(record.note).toBe("for night shots");
    expect(record.basePresetId).toBe("minimal-rich");
    expect(record.strength).toBe(0.78);
    expect(record.adjustments).toEqual({ contrast: 12, vibrance: 6 });
    expect(typeof record.createdAt).toBe("string");
  });

  it("drops empty notes", () => {
    const record = createCustomPresetRecord({
      name: "no note",
      basePresetId: "minimal-rich",
      strength: 0.5,
      adjustments: {},
      note: "   ",
    });
    expect(record.note).toBeUndefined();
  });

  it("save then load round-trips a preset", () => {
    const record = createCustomPresetRecord({
      name: "Editorial v1",
      basePresetId: "clean-luxury",
      strength: 0.6,
      adjustments: { temperature: -8, saturation: -4 },
    });

    saveCustomPreset(record);
    const loaded = loadCustomPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(record);
  });

  it("append multiple presets on successive saves", () => {
    saveCustomPreset(
      createCustomPresetRecord({
        name: "A",
        basePresetId: "minimal-rich",
        strength: 0.5,
        adjustments: { brightness: 5 },
      }),
    );
    saveCustomPreset(
      createCustomPresetRecord({
        name: "B",
        basePresetId: "clean-luxury",
        strength: 0.5,
        adjustments: { vibrance: 8 },
      }),
    );
    const loaded = loadCustomPresets();
    expect(loaded.map((entry) => entry.name)).toEqual(["A", "B"]);
  });

  it("deleteCustomPreset removes by id", () => {
    const a = createCustomPresetRecord({
      name: "A",
      basePresetId: "minimal-rich",
      strength: 0.5,
      adjustments: {},
    });
    const b = createCustomPresetRecord({
      name: "B",
      basePresetId: "minimal-rich",
      strength: 0.5,
      adjustments: {},
    });
    saveCustomPreset(a);
    saveCustomPreset(b);
    deleteCustomPreset(a.id);
    const loaded = loadCustomPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(b.id);
  });

  it("loadCustomPresets returns [] on corrupted JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    expect(loadCustomPresets()).toEqual([]);
  });

  it("customPresetsToDefinitions extends the base preset with overrides", () => {
    const record = createCustomPresetRecord({
      name: "My Soft Portrait",
      basePresetId: "aesthetic-soft",
      strength: 0.6,
      adjustments: { temperature: 10, clarity: -20 },
    });

    const [definition] = customPresetsToDefinitions([record]);
    expect(definition.id).toBe(record.id);
    expect(definition.name).toBe("My Soft Portrait");
    expect(definition.category).toBe("Custom");
    expect(definition.defaultStrength).toBe(0.6);
    expect(definition.adjustments.temperature).toBe(10);
    expect(definition.adjustments.clarity).toBe(-20);
    // The base preset's adjustments are still present (composition).
    expect(definition.adjustments.shadows).toBeDefined();
  });

  it("getFilterPresetByNameWithCustom returns the custom definition when the name matches", () => {
    const record = createCustomPresetRecord({
      name: "Look A",
      basePresetId: "minimal-rich",
      strength: 0.7,
      adjustments: { contrast: 10 },
    });
    const preset = getFilterPresetByNameWithCustom("Look A", [record]);
    expect(preset.id).toBe(record.id);
    expect(preset.adjustments.contrast).toBe(10);
  });

  it("getFilterPresetByNameWithCustom falls back to built-in presets when no match", () => {
    const preset = getFilterPresetByNameWithCustom("Minimal Rich", []);
    expect(preset.id).toBe("minimal-rich");
  });

  it("getFilterPresetByIdWithCustom resolves custom ids first, then built-ins", () => {
    const record = createCustomPresetRecord({
      name: "My Look",
      basePresetId: "minimal-rich",
      strength: 0.7,
      adjustments: {},
    });
    const byCustom = getFilterPresetByIdWithCustom(record.id, [record]);
    expect(byCustom.name).toBe("My Look");

    const byBuiltIn = getFilterPresetByIdWithCustom("clean-luxury", [record]);
    expect(byBuiltIn.id).toBe("clean-luxury");
  });
});
