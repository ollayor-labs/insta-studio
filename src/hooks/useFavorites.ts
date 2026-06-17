import { useCallback, useEffect, useState } from "react";
import {
  FAVORITE_SLOTS,
  clearFavoriteSlot,
  loadFavorites,
  setFavoriteSlot,
  type FavoritesMap,
  type FavoriteSlot,
} from "@/lib/filterEngine";
import { notifyStorageChanged, useStorageBusVersion } from "@/hooks/useStorageBus";

interface UseFavorites {
  favorites: FavoritesMap;
  isReady: boolean;
  setFavorite: (slot: FavoriteSlot, presetId: string) => FavoritesMap;
  clearFavorite: (slot: FavoriteSlot) => FavoritesMap;
  /** Returns the slot that holds a given preset, or undefined. */
  slotForPreset: (presetId: string) => FavoriteSlot | undefined;
}

export function useFavorites(): UseFavorites {
  // Bootstrap once on mount. The bus version drives re-reads via the
  // effect below. Compared to the previous per-hook `storage` listener,
  // this means we only read `localStorage` for the favorites key, only
  // when the bus fires for it, and we share one global listener with
  // `useRecents` / `useCustomPresets`.
  const [favorites, setFavorites] = useState<FavoritesMap>(() => loadFavorites());
  const [isReady, setIsReady] = useState(false);
  const version = useStorageBusVersion();

  useEffect(() => {
    setFavorites(loadFavorites());
    setIsReady(true);
  }, [version]);

  const setFavorite = useCallback((slot: FavoriteSlot, presetId: string) => {
    const next = setFavoriteSlot(slot, presetId);
    notifyStorageChanged();
    return next;
  }, []);

  const clearFavorite = useCallback((slot: FavoriteSlot) => {
    const next = clearFavoriteSlot(slot);
    notifyStorageChanged();
    return next;
  }, []);

  const slotForPreset = useCallback(
    (presetId: string) => {
      for (const slot of FAVORITE_SLOTS) {
        if (favorites[slot] === presetId) return slot;
      }
      return undefined;
    },
    [favorites],
  );

  return { favorites, isReady, setFavorite, clearFavorite, slotForPreset };
}
