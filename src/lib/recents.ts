// Lightweight IndexedDB-backed "recent images" store. The module is
// dependency-injected on the IDB factory so tests can pass a fake; production
// code uses `globalThis.indexedDB` via `getDefaultIDB()`. All public
// functions are async and return plain JS values (the storage shape never
// leaks IndexedDB-specific types).

const DB_NAME = "filtr-studio";
const DB_VERSION = 1;
const STORE_NAME = "recents";
const MAX_RECENTS = 12;

/**
 * Lightweight metadata for a recent image. The list call returns
 * this shape -- no `blob`, no `exifBytes` -- so the recents UI can
 * render thumbnails-by-extension and the page can hold 12 entries
 * resident in JS heap without materialising tens of MB of image
 * bytes. Use `getById(id)` to fetch the full record on demand.
 */
export interface RecentMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: number;
}

/**
 * A full recent record including the source bytes. Returned only by
 * `getById(id)` and the `add` mutator (which hands the new record
 * back to the caller so it can re-hydrate the editor immediately).
 * The `blob` and `exifBytes` fields are intentionally optional on
 * the metadata list so callers can't accidentally hold all twelve
 * blobs in memory at once.
 */
export interface RecentRecord extends RecentMeta {
  blob: Blob;
  /**
   * Raw EXIF TIFF payload from the original file (JPEG, PNG, WebP;
   * null for formats that don't carry EXIF or files with no
   * metadata). Stored alongside the blob so the editor can re-inject
   * the original EXIF on export even after a re-encode. Format-
   * agnostic (bare TIFF, no JPEG "Exif\0\0" preamble) so the export
   * pipeline can route the same bytes into JPEG / PNG / WebP.
   */
  exifBytes: Uint8Array | null;
}

interface RecentRecordRow extends RecentRecord {
  // Stored shape mirrors `RecentRecord`; this alias keeps the IDB types
  // readable in one place if we ever extend the schema.
  [key: string]: unknown;
}

export type IDBFactoryLike = {
  open(name: string, version: number): IDBOpenDBRequestLike;
  deleteDatabase?(name: string): IDBOpenDBRequestLike;
  cmp?(first: unknown, second: unknown): number;
};

export interface IDBOpenDBRequestLike {
  result: IDBDatabaseLike | null;
  error: unknown;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onupgradeneeded: ((event: Event) => void) | null;
}

export interface IDBDatabaseLike {
  transaction(storeNames: string | string[], mode?: "readonly" | "readwrite"): IDBTransactionLike;
  objectStore(name: string): IDBObjectStoreLike;
  objectStoreNames: { contains(name: string): boolean };
  close(): void;
  createObjectStore(name: string, options?: { keyPath?: string }): IDBObjectStoreLike;
}

export interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onabort: ((event: Event) => void) | null;
}

export interface IDBObjectStoreLike {
  add(value: unknown, key?: IDBValidKey): IDBRequestLike;
  put(value: unknown, key?: IDBValidKey): IDBRequestLike;
  delete(key: IDBValidKey): IDBRequestLike;
  clear(): IDBRequestLike;
  get(key: IDBValidKey): IDBRequestLike;
  getAll(): IDBRequestLike;
  count(): IDBRequestLike;
}

export interface IDBRequestLike {
  result: unknown;
  error: unknown;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

function getDefaultIDB(): IDBFactoryLike | null {
  if (typeof globalThis === "undefined") return null;
  const candidate = (globalThis as { indexedDB?: unknown }).indexedDB;
  if (!candidate) return null;
  return candidate as IDBFactoryLike;
}

function openDb(idb: IDBFactoryLike): Promise<IDBDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db) return;
      const oldVersion = (event as IDBVersionChangeEvent | undefined)?.oldVersion ?? 0;
      if (oldVersion < DB_VERSION && !db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      if (request.result) resolve(request.result);
      else reject(new Error("IndexedDB open returned no database"));
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function withStore<T>(
  db: IDBDatabaseLike,
  mode: "readonly" | "readwrite",
  fn: (store: IDBObjectStoreLike) => IDBRequestLike,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    tx.onerror = () => reject(new Error("IndexedDB transaction error"));
    tx.onabort = () => reject(new Error("IndexedDB transaction aborted"));
  });
}

function generateId(): string {
  const cryptoObj = (typeof globalThis !== "undefined" ? globalThis.crypto : undefined) as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeRecord(input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }): RecentRecord {
  return {
    id: generateId(),
    name: input.name,
    mimeType: input.mimeType,
    size: input.blob.size,
    addedAt: Date.now(),
    blob: input.blob,
    exifBytes: input.exifBytes,
  };
}

/**
 * Project a stored row down to the metadata-only shape returned by
 * `list()`. Centralised so a future column added to `RecentRecord`
 * is also omitted from the list projection -- the previous shape
 * had the `blob` field on the same type as the stored row, which
 * meant every consumer held the full bytes in memory. Stripping
 * `blob` / `exifBytes` here is what buys the RAM win.
 */
function toMeta(row: RecentRecordRow): RecentMeta {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    addedAt: row.addedAt,
  };
}

export interface RecentsStorage {
  add(input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }): Promise<RecentRecord>;
  /**
   * Returns metadata only (`RecentMeta[]`). The full source bytes
   * are NOT included -- callers should call `getById(id)` to fetch
   * the bytes for a specific entry on demand. This is the main
   * memory win: the recents UI no longer holds 12 full-resolution
   * `Blob` instances resident in JS heap.
   */
  list(): Promise<RecentMeta[]>;
  /**
   * Fetch the full record (with `blob` and `exifBytes`) for a
   * single id. Returns `null` if the entry no longer exists
   * (e.g. evicted by the cap, or cleared).
   */
  getById(id: string): Promise<RecentRecord | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  maxEntries: number;
}

export function createRecentsStorage(idb: IDBFactoryLike | null = getDefaultIDB()): RecentsStorage | null {
  if (!idb) return null;

  let dbPromise: Promise<IDBDatabaseLike> | null = null;
  function getDb(): Promise<IDBDatabaseLike> {
    if (!dbPromise) dbPromise = openDb(idb!);
    return dbPromise;
  }

  async function add(input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }): Promise<RecentRecord> {
    const db = await getDb();
    const record = makeRecord(input);
    // Add the new record first so a failure during eviction doesn't lose
    // the user's current image.
    await withStore(db, "readwrite", (store) => store.add(record as RecentRecordRow));
    // Cap the list. If we just inserted the (n+1)-th, evict the oldest
    // entries beyond the cap. We list-by-metadata so the eviction
    // check doesn't drag the full blobs into memory.
    const all = await list();
    if (all.length > MAX_RECENTS) {
      const evicted = all.slice(MAX_RECENTS);
      for (const old of evicted) {
        await withStore(db, "readwrite", (store) => store.delete(old.id));
      }
    }
    return record;
  }
  async function list(): Promise<RecentMeta[]> {
    const db = await getDb();
    // `getAll` returns the full rows; we project down to metadata
    // before crossing the storage boundary so the caller never sees
    // the `blob` / `exifBytes` fields. The full bytes are still in
    // the IDB result buffer, so this projection is the single most
    // important line for memory: it stops the JS heap from holding
    // all twelve blobs in `recents` state.
    const rows = (await withStore<RecentRecordRow[]>(db, "readonly", (store) => store.getAll())) as RecentRecordRow[];
    return rows
      .slice()
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(toMeta);
  }
  async function getById(id: string): Promise<RecentRecord | null> {
    const db = await getDb();
    const row = (await withStore<RecentRecordRow | undefined>(db, "readonly", (store) => store.get(id))) as
      | RecentRecordRow
      | undefined;
    return row ?? null;
  }
  async function remove(id: string): Promise<void> {
    const db = await getDb();
    await withStore(db, "readwrite", (store) => store.delete(id));
  }
  async function clear(): Promise<void> {
    const db = await getDb();
    await withStore(db, "readwrite", (store) => store.clear());
  }
  return {
    maxEntries: MAX_RECENTS,
    add,
    list,
    getById,
    remove,
    clear,
  } satisfies RecentsStorage;
}
