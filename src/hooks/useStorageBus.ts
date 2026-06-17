/**
 * A single shared "localStorage changed" subscription for the editor's
 * persisted state. Three hooks (`useFavorites`, `useCustomPresets`,
 * `useRecents`) each used to attach their own
 * `window.addEventListener("storage", ...)` plus a custom `*::changed`
 * event, which meant every write to `localStorage` re-ran all three
 * listeners and re-read all three keys. The bus here owns exactly one
 * `storage` listener plus one listener per in-process change event.
 *
 * Subscribers use `useSyncExternalStore` against the bus's
 * monotonically-increasing version number. The version bumps on (a)
 * the `storage` event for any of the keys the editor owns, (b) the
 * same in-process change events the old hooks used to dispatch, and
 * (c) explicit `notifyStorageChanged()` calls.
 *
 * The keys we watch are the three that the editor actually owns. The
 * `storage` event also fires for unrelated keys in the same origin
 * (other apps on the same domain, devtools, etc.) -- we filter those
 * out so they don't wake up React commits.
 */
import { useSyncExternalStore } from "react";

const WATCHED_KEYS = new Set(["filtr.favorites", "filtr.custom-presets"]);

const RECENTS_EVENT = "filtr:recents-changed";
const FAVORITES_EVENT = "filtr:favorites-changed";
const CUSTOM_PRESETS_EVENT = "filtr:custom-presets-changed";

type Listener = () => void;

class StorageBus {
  private version = 0;
  private listeners = new Set<Listener>();
  private attached = false;

  getSnapshot = (): number => {
    return this.version;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.attachOnce();
    return () => {
      this.listeners.delete(listener);
    };
  };

  notify = (): void => {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  };

  private attachOnce(): void {
    if (this.attached) return;
    if (typeof window === "undefined") return;
    this.attached = true;

    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || WATCHED_KEYS.has(event.key)) {
        this.notify();
      }
    };
    const handleRecents = () => this.notify();
    const handleFavorites = () => this.notify();
    const handleCustomPresets = () => this.notify();

    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECENTS_EVENT, handleRecents);
    window.addEventListener(FAVORITES_EVENT, handleFavorites);
    window.addEventListener(CUSTOM_PRESETS_EVENT, handleCustomPresets);
  }
}

const bus = new StorageBus();

/**
 * Subscribe to the storage bus. Returns a `version` number that flips
 * on every bus event. Hooks (`useFavorites`, `useCustomPresets`,
 * `useRecents`) read this and re-read their persisted state when it
 * changes. Wraps `useSyncExternalStore` so React's concurrent reads
 * are tear-safe.
 */
export function useStorageBusVersion(): number {
  return useSyncExternalStore(bus.subscribe, bus.getSnapshot, () => 0);
}

/**
 * Imperative entry point for callers that just wrote to localStorage
 * or IndexedDB and want same-tab subscribers to pick it up. Equivalent
 * to the old hooks' `window.dispatchEvent(new Event(STORAGE_EVENT))`,
 * but the bus is now the single source of truth.
 */
export function notifyStorageChanged(): void {
  bus.notify();
}
