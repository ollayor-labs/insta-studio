import { useCallback, useEffect, useState } from "react";
import {
  FAVORITE_SLOTS,
  clearFavoriteSlot,
  loadFavorites,
  setFavoriteSlot,
  type FavoritesMap,
  type FavoriteSlot,
} from "@/lib/filterEngine";

interface UseFavorites {
  favorites: FavoritesMap;
  isReady: boolean;
  setFavorite: (slot: FavoriteSlot, presetId: string) => FavoritesMap;
  clearFavorite: (slot: FavoriteSlot) => FavoritesMap;
  /** Returns the slot that holds a given preset, or undefined. */
  slotForPreset: (presetId: string) => FavoriteSlot | undefined;
}

const STORAGE_EVENT = "filtr:favorites-changed";

export function useFavorites(): UseFavorites {
  const [favorites, setFavorites] = useState<FavoritesMap>({});
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setFavorites(loadFavorites());
    setIsReady(true);

    const handleStorage = (event: StorageEvent) => {
      if (event.key === "filtr.favorites" || event.key === null) {
        setFavorites(loadFavorites());
      }
    };
    const handleInternal = () => setFavorites(loadFavorites());

    window.addEventListener("storage", handleStorage);
    window.addEventListener(STORAGE_EVENT, handleInternal);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STORAGE_EVENT, handleInternal);
    };
  }, []);

  const setFavorite = useCallback((slot: FavoriteSlot, presetId: string) => {
    const next = setFavoriteSlot(slot, presetId);
    setFavorites(next);
    window.dispatchEvent(new Event(STORAGE_EVENT));
    return next;
  }, []);

  const clearFavorite = useCallback((slot: FavoriteSlot) => {
    const next = clearFavoriteSlot(slot);
    setFavorites(next);
    window.dispatchEvent(new Event(STORAGE_EVENT));
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
