// Lightweight IndexedDB-backed "recent images" store. The module is
// dependency-injected on the IDB factory so tests can pass a fake; production
// code uses `globalThis.indexedDB` via `getDefaultIDB()`. All public
// functions are async and return plain JS values (the storage shape never
// leaks IndexedDB-specific types).

const DB_NAME = "filtr-studio";
const DB_VERSION = 1;
const STORE_NAME = "recents";
const MAX_RECENTS = 12;

export interface RecentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: number;
  blob: Blob;
  /**
   * Raw EXIF TIFF payload from the original file (JPEG, PNG, WebP; null
   * for formats that don't carry EXIF or files that have no metadata).
   * Stored separately from `blob` because the editor may re-encode the
   * bytes on export and lose the metadata; keeping the original payload
   * lets us re-inject it on save in any supported format. The shape is
   * format-agnostic (bare TIFF, no JPEG "Exif\0\0" preamble) so the
   * export pipeline can route the same bytes into JPEG / PNG / WebP.
   * Safe to store in IndexedDB: it's just a `Uint8Array`.
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
  /**
   * The set of object store names already in this database. Real
   * `IDBDatabase` exposes this as a `DOMStringList`; our minimal
   * adapter uses a `Set<string>` with a `contains` method so the
   * exists-check is safe on first install (where calling
   * `objectStore(name)` on a missing store would throw).
   */
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
      // `oldVersion === 0` means a fresh install -- the previous schema
      // did not include this store, so we need to create it. For real
      // IndexedDB, calling `db.objectStore(name)` on a missing store
      // throws NotFoundError instead of returning null, which would
      // abort the versionchange transaction and leave the schema
      // uncreated. Use the event's oldVersion as the exists-check.
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

export interface RecentsStorage {
  add(input: { name: string; mimeType: string; blob: Blob; exifBytes: Uint8Array | null }): Promise<RecentRecord>;
  list(): Promise<RecentRecord[]>;
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
    // entries beyond the cap.
    const all = await list();
    if (all.length > MAX_RECENTS) {
      const evicted = all.slice(MAX_RECENTS);
      for (const old of evicted) {
        await withStore(db, "readwrite", (store) => store.delete(old.id));
      }
    }
    return record;
  }
  async function list(): Promise<RecentRecord[]> {
    const db = await getDb();
    const rows = (await withStore<RecentRecordRow[]>(db, "readonly", (store) => store.getAll())) as RecentRecordRow[];
    return rows.slice().sort((a, b) => b.addedAt - a.addedAt);
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
    remove,
    clear,
  } satisfies RecentsStorage;
}
