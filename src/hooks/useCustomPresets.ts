import { useCallback, useEffect, useState } from "react";
import {
  createCustomPresetRecord,
  deleteCustomPreset,
  loadCustomPresets,
  saveCustomPreset,
  type Adjustments,
  type CustomPresetRecord,
} from "@/lib/filterEngine";
import { notifyStorageChanged, useStorageBusVersion } from "@/hooks/useStorageBus";

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

export function useCustomPresets(): UseCustomPresets {
  // See `useFavorites` for the bus pattern. Initial state is read
  // synchronously so the editor's first render already sees saved
  // presets; the effect below re-reads on any bus event.
  const [presets, setPresets] = useState<CustomPresetRecord[]>(() => loadCustomPresets());
  const [isReady, setIsReady] = useState(false);
  const version = useStorageBusVersion();

  useEffect(() => {
    setPresets(loadCustomPresets());
    setIsReady(true);
  }, [version]);

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
      notifyStorageChanged();
      return record;
    },
    [],
  );

  const removePreset = useCallback((presetId: string) => {
    const next = deleteCustomPreset(presetId);
    setPresets(next);
    notifyStorageChanged();
  }, []);

  return { presets, savePreset, removePreset, isReady };
}
