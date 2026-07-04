// Export history stored in IndexedDB. The DB is shared with the
// `recents` store (same database name `filtr-studio`); we bump
// the version to 2 and create the new `exports` store in the
// upgrade callback. The recents store is untouched.

import { createThumbnail } from "@/lib/thumbnail";
import type { ExportProfileId } from "./profile";

const DB_NAME = "filtr-studio";
const DB_VERSION = 2; // bumped from 1 (recents) to 1 + 1 (exports)
const STORE_NAME = "exports";
const RECENTS_STORE_NAME = "recents"; // existing store; referenced for upgrade check
const MAX_EXPORTS = 24;

export interface ExportHistoryRecord {
  id: string;
  /** Date.now() of the export click. */
  date: number;
  /** The file name the user downloaded. */
  fileName: string;
  profileId: ExportProfileId;
  profileLabel: string;
  /** Actual output dimensions after the profile was applied. */
  width: number;
  height: number;
  maxLongestEdge: number | null;
  format: "jpeg" | "png" | "webp";
  quality: number;
  srgb: boolean;
  sharpen: number;
  stripExif: boolean;
  optimizeForSocial: boolean;
  watermark: boolean;
  filterName: string;
  filterStrength: number;
  effectIntensity: number;
  /** 128px preview JPEG, used by the recent-exports menu. */
  thumbBlob: Blob | null;
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
      // Create the recents store at v1 (matches src/lib/recents.ts).
      // The recents module opens with its own version constant, so
      // a fresh browser might also hit this path on the first
      // export-history open. We mirror the recents schema so
      // the two stores coexist cleanly.
      if (oldVersion < 1 && !db.objectStoreNames.contains(RECENTS_STORE_NAME)) {
        db.createObjectStore(RECENTS_STORE_NAME, { keyPath: "id" });
      }
      // Add the exports store at v2.
      if (oldVersion < 2 && !db.objectStoreNames.contains(STORE_NAME)) {
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
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ExportHistoryStorage {
  add(input: Omit<ExportHistoryRecord, "id" | "date" | "thumbBlob"> & { thumbSource?: Blob | null }): Promise<ExportHistoryRecord>;
  list(): Promise<ExportHistoryRecord[]>;
  getById(id: string): Promise<ExportHistoryRecord | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  maxEntries: number;
}

export function createExportHistoryStorage(
  idb: IDBFactoryLike | null = getDefaultIDB(),
): ExportHistoryStorage | null {
  if (!idb) return null;
  let dbPromise: Promise<IDBDatabaseLike> | null = null;
  function getDb(): Promise<IDBDatabaseLike> {
    if (!dbPromise) dbPromise = openDb(idb!);
    return dbPromise;
  }
  async function add(
    input: Omit<ExportHistoryRecord, "id" | "date" | "thumbBlob"> & { thumbSource?: Blob | null },
  ): Promise<ExportHistoryRecord> {
    const db = await getDb();
    // Build a tiny thumbnail off the provided blob (if any). The
    // thumbnail pipeline swallows its own errors and returns
    // null on failure, so a broken encoder never blocks the
    // history write.
    const thumbBlob = input.thumbSource ? await createThumbnail(input.thumbSource) : null;
    const record: ExportHistoryRecord = {
      id: generateId(),
      date: Date.now(),
      fileName: input.fileName,
      profileId: input.profileId,
      profileLabel: input.profileLabel,
      width: input.width,
      height: input.height,
      maxLongestEdge: input.maxLongestEdge,
      format: input.format,
      quality: input.quality,
      srgb: input.srgb,
      sharpen: input.sharpen,
      stripExif: input.stripExif,
      optimizeForSocial: input.optimizeForSocial,
      watermark: input.watermark,
      filterName: input.filterName,
      filterStrength: input.filterStrength,
      effectIntensity: input.effectIntensity,
      thumbBlob,
    };
    await withStore(db, "readwrite", (store) => store.add(record));
    // Cap the list (oldest entries are evicted).
    const all = await list();
    if (all.length > MAX_EXPORTS) {
      const evicted = all.slice(MAX_EXPORTS);
      for (const old of evicted) {
        await withStore(db, "readwrite", (store) => store.delete(old.id));
      }
    }
    return record;
  }
  async function list(): Promise<ExportHistoryRecord[]> {
    const db = await getDb();
    const rows = (await withStore<ExportHistoryRecord[]>(db, "readonly", (store) => store.getAll())) as ExportHistoryRecord[];
    return rows.slice().sort((a, b) => b.date - a.date);
  }
  async function getById(id: string): Promise<ExportHistoryRecord | null> {
    const db = await getDb();
    const row = (await withStore<ExportHistoryRecord | undefined>(db, "readonly", (store) => store.get(id))) as
      | ExportHistoryRecord
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
    maxEntries: MAX_EXPORTS,
    add,
    list,
    getById,
    remove,
    clear,
  } satisfies ExportHistoryStorage;
}
