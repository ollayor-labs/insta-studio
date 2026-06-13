import { useCallback, useEffect, useState } from "react";
import { createRecentsStorage, type RecentRecord } from "@/lib/recents";

interface UseRecents {
  recents: RecentRecord[];
  isReady: boolean;
  isSupported: boolean;
  addRecent: (input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }) => Promise<RecentRecord | null>;
  removeRecent: (id: string) => Promise<void>;
  clearRecents: () => Promise<void>;
  refresh: () => Promise<void>;
}

const STORAGE_EVENT = "filtr:recents-changed";

export function useRecents(): UseRecents {
  const storage = createRecentsStorage();
  const isSupported = storage !== null;
  const [recents, setRecents] = useState<RecentRecord[]>([]);
  const [isReady, setIsReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!storage) {
      setRecents([]);
      return;
    }
    const next = await storage.list();
    setRecents(next);
  }, [storage]);

  useEffect(() => {
    void refresh().finally(() => setIsReady(true));

    const handleStorage = (event: StorageEvent) => {
      if (event.key === null) {
        void refresh();
      }
    };
    const handleInternal = () => {
      void refresh();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(STORAGE_EVENT, handleInternal);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STORAGE_EVENT, handleInternal);
    };
  }, [refresh]);

  const addRecent = useCallback(
    async (input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }) => {
      if (!storage) return null;
      const record = await storage.add(input);
      await refresh();
      window.dispatchEvent(new Event(STORAGE_EVENT));
      return record;
    },
    [storage, refresh],
  );

  const removeRecent = useCallback(
    async (id: string) => {
      if (!storage) return;
      await storage.remove(id);
      await refresh();
      window.dispatchEvent(new Event(STORAGE_EVENT));
    },
    [storage, refresh],
  );

  const clearRecents = useCallback(async () => {
    if (!storage) return;
    await storage.clear();
    await refresh();
    window.dispatchEvent(new Event(STORAGE_EVENT));
  }, [storage, refresh]);

  return { recents, isReady, isSupported, addRecent, removeRecent, clearRecents, refresh };
}
