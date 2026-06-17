export type HistoryKind =
  | "preset-change"
  | "strength"
  | "intensity"
  | "adjustment"
  | "reset"
  | "image-load"
  | "favorite"
  | "other";

export interface HistoryEntry<T> {
  state: T;
  label: string;
  timestamp: number;
  kind: HistoryKind;
}

export type HistoryEqual<T> = (a: T, b: T) => boolean;

export interface HistoryOptions<T> {
  capacity?: number;
  seedOnCommit?: boolean;
  equal?: HistoryEqual<T>;
}

const DEFAULT_CAPACITY = 100;

function defaultEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export type Unsubscribe = () => void;

export class HistoryStore<T> {
  private entries: HistoryEntry<T>[] = [];
  private redoEntries: HistoryEntry<T>[] = [];
  private currentState: T;
  private readonly capacity: number;
  private readonly seedOnCommit: boolean;
  private readonly equal: HistoryEqual<T>;
  private interactionStart: T | null = null;
  private seeded = false;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T, options: HistoryOptions<T> = {}) {
    this.currentState = initial;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.seedOnCommit = options.seedOnCommit ?? true;
    this.equal = options.equal ?? defaultEqual;
  }

  /** Subscribe to mutations. Returns an unsubscribe function. */
  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get current(): T {
    return this.currentState;
  }

  setCurrent(state: T): void {
    this.currentState = state;
    this.notify();
  }

  get past(): ReadonlyArray<HistoryEntry<T>> {
    return this.entries;
  }

  get future(): ReadonlyArray<HistoryEntry<T>> {
    return this.redoEntries;
  }

  canUndo(): boolean {
    return this.entries.length > 0;
  }

  canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  isInteracting(): boolean {
    return this.interactionStart !== null;
  }

  /**
   * Records a change. The CURRENT state is pushed to `past` before being
   * overwritten, so an `undo()` returns the caller to the state that
   * existed just before this commit. When `seedOnCommit` is enabled
   * (the default), the very first commit is treated as the baseline:
   * the state is set, no past entry is recorded, and the user has
   * nothing to undo "to" yet. Subsequent commits always push.
   */
  commit(state: T, label: string, kind: HistoryKind): void {
    if (this.seedOnCommit && !this.seeded) {
      this.seeded = true;
      this.currentState = state;
      this.notify();
      return;
    }
    if (this.equal(state, this.currentState)) {
      return;
    }
    this.entries.push({
      state: this.currentState,
      label,
      timestamp: Date.now(),
      kind,
    });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.redoEntries = [];
    this.currentState = state;
    this.notify();
  }

  undo(): T | null {
    const entry = this.entries.pop();
    if (!entry) return null;
    this.redoEntries.push({
      state: this.currentState,
      label: entry.label,
      timestamp: Date.now(),
      kind: entry.kind,
    });
    this.currentState = entry.state;
    this.notify();
    return this.currentState;
  }

  redo(): T | null {
    const entry = this.redoEntries.pop();
    if (!entry) return null;
    this.entries.push({
      state: this.currentState,
      label: entry.label,
      timestamp: Date.now(),
      kind: entry.kind,
    });
    this.currentState = entry.state;
    this.notify();
    return this.currentState;
  }

  beginInteraction(): void {
    this.interactionStart = this.currentState;
    this.notify();
  }

  setDuringInteraction(state: T): void {
    this.currentState = state;
    this.notify();
  }

  commitInteraction(label: string, kind: HistoryKind): void {
    const start = this.interactionStart;
    this.interactionStart = null;
    if (start === null) return;
    if (this.equal(start, this.currentState)) return;
    if (this.seedOnCommit && !this.seeded) {
      // A interaction before any explicit commit still acts as the
      // baseline; we just absorb the start state as the seed.
      this.seeded = true;
      this.notify();
      return;
    }
    this.entries.push({
      state: start,
      label,
      timestamp: Date.now(),
      kind,
    });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.redoEntries = [];
    this.notify();
  }

  cancelInteraction(): void {
    if (this.interactionStart !== null) {
      this.currentState = this.interactionStart;
      this.interactionStart = null;
      this.notify();
    }
  }

  reset(state: T, options: { seed?: boolean } = {}): void {
    this.entries = [];
    this.redoEntries = [];
    this.interactionStart = null;
    this.currentState = state;
    this.seeded = false;
    if (options.seed === false) {
      this.seedOnCommit = false;
    }
    this.notify();
  }
}
