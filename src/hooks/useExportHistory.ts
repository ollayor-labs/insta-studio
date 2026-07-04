import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createExportHistoryStorage,
  type ExportHistoryRecord,
} from "@/lib/export";
import { notifyStorageChanged, useStorageBusVersion } from "@/hooks/useStorageBus";

export interface UseExportHistory {
  exports: ExportHistoryRecord[];
  isReady: boolean;
  isSupported: boolean;
  addExport: (
    input: Omit<ExportHistoryRecord, "id" | "date" | "thumbBlob"> & { thumbSource?: Blob | null },
  ) => Promise<ExportHistoryRecord | null>;
  removeExport: (id: string) => Promise<void>;
  clearExports: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useExportHistory(): UseExportHistory {
  const storage = useMemo(() => createExportHistoryStorage(), []);
  const isSupported = storage !== null;
  const [exports, setExports] = useState<ExportHistoryRecord[]>([]);
  const [isReady, setIsReady] = useState(false);
  const version = useStorageBusVersion();

  const refresh = useCallback(async () => {
    if (!storage) {
      setExports([]);
      return;
    }
    const next = await storage.list();
    setExports(next);
  }, [storage]);

  useEffect(() => {
    void refresh().finally(() => setIsReady(true));
  }, [refresh, version]);

  const addExport = useCallback(
    async (
      input: Omit<ExportHistoryRecord, "id" | "date" | "thumbBlob"> & { thumbSource?: Blob | null },
    ) => {
      if (!storage) return null;
      const record = await storage.add(input);
      await refresh();
      notifyStorageChanged();
      return record;
    },
    [storage, refresh],
  );

  const removeExport = useCallback(
    async (id: string) => {
      if (!storage) return;
      await storage.remove(id);
      await refresh();
      notifyStorageChanged();
    },
    [storage, refresh],
  );

  const clearExports = useCallback(async () => {
    if (!storage) return;
    await storage.clear();
    await refresh();
    notifyStorageChanged();
  }, [storage, refresh]);

  return {
    exports,
    isReady,
    isSupported,
    addExport,
    removeExport,
    clearExports,
    refresh,
  };
}
