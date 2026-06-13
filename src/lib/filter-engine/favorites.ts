// 1-9 keyboard favorite slots. A favorite maps a single-digit slot to a
// preset id (built-in or custom). Storage is a JSON object on its own
// `localStorage` key so it stays decoupled from custom-preset records and
// survives a presets reset.

const STORAGE_KEY = "filtr.favorites";

export type FavoriteSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export const FAVORITE_SLOTS: FavoriteSlot[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export type FavoritesMap = Partial<Record<FavoriteSlot, string>>;

function isFavoriteSlot(value: unknown): value is FavoriteSlot {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;
}

function isPresetId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function coerceMap(input: unknown): FavoritesMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: FavoritesMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const slot = Number(key);
    if (isFavoriteSlot(slot) && isPresetId(value)) {
      result[slot] = value;
    }
  }
  return result;
}

export function loadFavorites(): FavoritesMap {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return coerceMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeFavorites(map: FavoritesMap): FavoritesMap {
  if (typeof window === "undefined") return map;
  // Strip undefined entries before serialization so the JSON stays tight.
  const compact: FavoritesMap = {};
  for (const slot of FAVORITE_SLOTS) {
    const value = map[slot];
    if (typeof value === "string") compact[slot] = value;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
  return compact;
}

export function setFavoriteSlot(slot: FavoriteSlot, presetId: string): FavoritesMap {
  const next = { ...loadFavorites(), [slot]: presetId };
  return writeFavorites(next);
}

export function clearFavoriteSlot(slot: FavoriteSlot): FavoritesMap {
  const next = { ...loadFavorites() };
  delete next[slot];
  return writeFavorites(next);
}

export function getFavoritePresetId(map: FavoritesMap, slot: FavoriteSlot): string | undefined {
  return map[slot];
}
