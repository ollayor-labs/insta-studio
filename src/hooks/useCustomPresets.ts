import { useCallback, useEffect, useState } from "react";
import {
  createCustomPresetRecord,
  deleteCustomPreset,
  loadCustomPresets,
  saveCustomPreset,
  type Adjustments,
  type CustomPresetRecord,
} from "@/lib/filterEngine";

interface UseCustomPresets {
  presets: CustomPresetRecord[];
  savePreset: (input: {
    name: string;
    basePresetId: string;
    strength: number;
    adjustments: Partial<Adjustments>;
    note?: string;
  }) => CustomPresetRecord;
  removePreset: (presetId: string) => void;
  isReady: boolean;
}

const STORAGE_EVENT = "filtr:custom-presets-changed";

export function useCustomPresets(): UseCustomPresets {
  const [presets, setPresets] = useState<CustomPresetRecord[]>([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setPresets(loadCustomPresets());
    setIsReady(true);

    const handleStorage = (event: StorageEvent) => {
      if (event.key === "filtr.custom-presets") {
        setPresets(loadCustomPresets());
      }
    };
    const handleInternal = () => setPresets(loadCustomPresets());

    window.addEventListener("storage", handleStorage);
    window.addEventListener(STORAGE_EVENT, handleInternal);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STORAGE_EVENT, handleInternal);
    };
  }, []);

  const savePreset = useCallback(
    (input: {
      name: string;
      basePresetId: string;
      strength: number;
      adjustments: Partial<Adjustments>;
      note?: string;
    }): CustomPresetRecord => {
      const record = createCustomPresetRecord(input);
      const next = saveCustomPreset(record);
      setPresets(next);
      window.dispatchEvent(new Event(STORAGE_EVENT));
      return record;
    },
    [],
  );

  const removePreset = useCallback((presetId: string) => {
    const next = deleteCustomPreset(presetId);
    setPresets(next);
    window.dispatchEvent(new Event(STORAGE_EVENT));
  }, []);

  return { presets, savePreset, removePreset, isReady };
}
