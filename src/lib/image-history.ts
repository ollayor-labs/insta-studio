/**
 * Lightweight image undo/redo stack. Stores data-URL snapshots of the
 * editor's source image so destructive operations (cutout, blur) can
 * be undone. This is a *parallel* stack to the main HistoryStore —
 * slider / filter adjustments are tracked separately and remain
 * non-destructive.
 *
 * Capacity is kept small (default 10) because each entry holds a
 * full-resolution PNG data URL (~5-20 MB).
 */

const DEFAULT_IMAGE_HISTORY_CAPACITY = 10;

export interface ImageHistoryEntry {
  /** PNG data URL of the source image at the time of the snapshot. */
  dataUrl: string;
  /** Human-readable label shown in the undo toast. */
  label: string;
  /** Tool kind — mirrors HistoryKind for consistency. */
  kind: "cutout" | "blur" | "other";
  timestamp: number;
}

export class ImageHistory {
  private past: ImageHistoryEntry[] = [];
  private future: ImageHistoryEntry[] = [];
  private readonly capacity: number;

  constructor(capacity = DEFAULT_IMAGE_HISTORY_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  /** Snapshot the current image before a destructive edit. */
  push(dataUrl: string, label: string, kind: ImageHistoryEntry["kind"]): void {
    this.past.push({ dataUrl, label, kind, timestamp: Date.now() });
    if (this.past.length > this.capacity) {
      this.past.splice(0, this.past.length - this.capacity);
    }
    // A new destructive edit invalidates the redo branch.
    this.future = [];
  }

  /**
   * Pop the most recent snapshot (undo).
   * Returns the data URL to restore, or null if nothing to undo.
   * `currentDataUrl` is the image *before* the restore — it gets
   * pushed onto the redo stack so redo can re-apply the edit.
   */
  popUndo(currentDataUrl: string): ImageHistoryEntry | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({
      dataUrl: currentDataUrl,
      label: entry.label,
      kind: entry.kind,
      timestamp: Date.now(),
    });
    return entry;
  }

  /**
   * Re-apply a previously undone edit (redo).
   * Returns the data URL to restore, or null if nothing to redo.
   * `currentDataUrl` is the image *before* the redo — it gets
   * pushed onto the past stack so undo can revert again.
   */
  popRedo(currentDataUrl: string): ImageHistoryEntry | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({
      dataUrl: currentDataUrl,
      label: entry.label,
      kind: entry.kind,
      timestamp: Date.now(),
    });
    return entry;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Peek at the next undo entry without popping it. */
  peekUndo(): ImageHistoryEntry | null {
    return this.past.length > 0 ? this.past[this.past.length - 1] : null;
  }

  /** Peek at the next redo entry without popping it. */
  peekRedo(): ImageHistoryEntry | null {
    return this.future.length > 0 ? this.future[this.future.length - 1] : null;
  }

  /** Wipe everything — called when a new image is loaded. */
  reset(): void {
    this.past = [];
    this.future = [];
  }
}
