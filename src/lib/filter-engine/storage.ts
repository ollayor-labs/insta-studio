import type { Adjustments, CustomPresetRecord } from "./types";

const STORAGE_KEY = "filtr.custom-presets";

export function createCustomPresetRecord(input: {
  name: string;
  basePresetId: string;
  strength: number;
  adjustments: Partial<Adjustments>;
  note?: string;
}): CustomPresetRecord {
  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    basePresetId: input.basePresetId,
    strength: input.strength,
    adjustments: input.adjustments,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
}

export function loadCustomPresets(): CustomPresetRecord[] {
  if (typeof window === "undefined") return [];

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as CustomPresetRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomPreset(record: CustomPresetRecord): CustomPresetRecord[] {
  const presets = [...loadCustomPresets(), record];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  return presets;
}

export function deleteCustomPreset(presetId: string): CustomPresetRecord[] {
  const presets = loadCustomPresets().filter((preset) => preset.id !== presetId);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  return presets;
}
