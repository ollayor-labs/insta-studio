import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Adjustments } from "@/lib/filter-engine";
import { HistoryStore, type HistoryEntry, type HistoryKind } from "@/lib/history";

export interface EditorSnapshot {
  activeFilter: string;
  filterStrength: number;
  effectIntensity: number;
  adjustments: Adjustments;
}

export interface UseHistoryResult {
  state: EditorSnapshot;
  canUndo: boolean;
  canRedo: boolean;
  past: ReadonlyArray<HistoryEntry<EditorSnapshot>>;
  future: ReadonlyArray<HistoryEntry<EditorSnapshot>>;
  apply: (state: EditorSnapshot, label: string, kind: HistoryKind) => void;
  beginInteraction: () => void;
  setDuringInteraction: (state: EditorSnapshot) => void;
  commitInteraction: (label: string, kind: HistoryKind) => void;
  cancelInteraction: () => void;
  isInteracting: () => boolean;
  undo: () => void;
  redo: () => void;
  reset: (initial: EditorSnapshot) => void;
}

export interface UseHistoryOptions {
  capacity?: number;
}

/**
 * Wires a `HistoryStore<EditorSnapshot>` into React via
 * `useSyncExternalStore` for the snapshot. `canUndo` / `canRedo` /
 * `past` / `future` are mirrored into React state via a tiny
 * subscription so consumers re-render when the stack contents change.
 */
export function useHistory(initial: EditorSnapshot, options: UseHistoryOptions = {}): UseHistoryResult {
  const storeRef = useRef<HistoryStore<EditorSnapshot> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new HistoryStore<EditorSnapshot>(initial, { capacity: options.capacity });
  }
  const store = storeRef.current;

  const state = useSyncExternalStore(
    store.subscribe.bind(store),
    () => store.current,
    () => store.current,
  );

  const [version, setVersion] = useState(0);
  useEffect(() => {
    return store.subscribe(() => setVersion((v) => v + 1));
  }, [store]);

  const apply = useCallback(
    (next: EditorSnapshot, label: string, kind: HistoryKind) => {
      store.commit(next, label, kind);
    },
    [store],
  );

  const beginInteraction = useCallback(() => {
    store.beginInteraction();
  }, [store]);

  const setDuringInteraction = useCallback(
    (next: EditorSnapshot) => {
      store.setDuringInteraction(next);
    },
    [store],
  );

  const commitInteraction = useCallback(
    (label: string, kind: HistoryKind) => {
      store.commitInteraction(label, kind);
    },
    [store],
  );

  const cancelInteraction = useCallback(() => {
    store.cancelInteraction();
  }, [store]);

  const isInteracting = useCallback(() => store.isInteracting(), [store]);

  const undo = useCallback(() => {
    store.undo();
  }, [store]);

  const redo = useCallback(() => {
    store.redo();
  }, [store]);

  const reset = useCallback(
    (next: EditorSnapshot) => {
      store.reset(next);
    },
    [store],
  );

  useEffect(() => {
    return () => {
      store.cancelInteraction();
    };
  }, [store]);

  void version;
  return {
    state,
    canUndo: store.canUndo(),
    canRedo: store.canRedo(),
    past: store.past,
    future: store.future,
    apply,
    beginInteraction,
    setDuringInteraction,
    commitInteraction,
    cancelInteraction,
    isInteracting,
    undo,
    redo,
    reset,
  };
}
