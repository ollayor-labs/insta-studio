import { useCallback, useEffect, useState } from "react";
import { createRecentsStorage, type RecentMeta, type RecentRecord } from "@/lib/recents";
import { notifyStorageChanged, useStorageBusVersion } from "@/hooks/useStorageBus";

interface UseRecents {
  /**
   * Metadata-only list. The full source bytes (and EXIF payload) are
   * NOT included -- callers should use `getRecentBlob(id)` to fetch
   * the bytes for a specific entry on demand. This is the main
   * memory win: the recents UI no longer holds a dozen full-
   * resolution `Blob` instances resident in JS heap.
   */
  recents: RecentMeta[];
  isReady: boolean;
  isSupported: boolean;
  addRecent: (input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }) => Promise<RecentRecord | null>;
  removeRecent: (id: string) => Promise<void>;
  clearRecents: () => Promise<void>;
  /**
   * Fetch the full record (with `blob` and `exifBytes`) for a
   * single id. Returns `null` if the entry no longer exists. The
   * page calls this when the user clicks a recents row, then
   * immediately hands the bytes to the image importer.
   */
  getRecentBlob: (id: string) => Promise<RecentRecord | null>;
  refresh: () => Promise<void>;
}

export function useRecents(): UseRecents {
  const storage = createRecentsStorage();
  const isSupported = storage !== null;
  const [recents, setRecents] = useState<RecentMeta[]>([]);
  const [isReady, setIsReady] = useState(false);
  const version = useStorageBusVersion();

  const refresh = useCallback(async () => {
    if (!storage) {
      setRecents([]);
      return;
    }
    // list() returns metadata only, so this read is cheap regardless
    // of how many recent images are stored. The full blobs stay in
    // IndexedDB until a caller explicitly asks for them.
    const next = await storage.list();
    setRecents(next);
  }, [storage]);

  useEffect(() => {
    void refresh().finally(() => setIsReady(true));
  }, [refresh, version]);

  const addRecent = useCallback(
    async (input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }) => {
      if (!storage) return null;
      const record = await storage.add(input);
      await refresh();
      notifyStorageChanged();
      return record;
    },
    [storage, refresh],
  );

  const removeRecent = useCallback(
    async (id: string) => {
      if (!storage) return;
      await storage.remove(id);
      await refresh();
      notifyStorageChanged();
    },
    [storage, refresh],
  );

  const clearRecents = useCallback(async () => {
    if (!storage) return;
    await storage.clear();
    await refresh();
    notifyStorageChanged();
  }, [storage, refresh]);

  const getRecentBlob = useCallback(
    async (id: string) => {
      if (!storage) return null;
      return storage.getById(id);
    },
    [storage],
  );

  return { recents, isReady, isSupported, addRecent, removeRecent, clearRecents, getRecentBlob, refresh };
}
