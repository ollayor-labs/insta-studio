import { describe, expect, it } from "vitest";
import {
  createExportHistoryStorage,
  type IDBDatabaseLike,
  type IDBFactoryLike,
  type IDBObjectStoreLike,
  type IDBOpenDBRequestLike,
  type IDBRequestLike,
  type IDBTransactionLike,
} from "@/lib/export";

interface Row {
  id: string;
  date: number;
  fileName: string;
  profileId: string;
  profileLabel: string;
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
  thumbBlob?: Blob | null;
}

class FakeStore implements IDBObjectStoreLike {
  rows: Row[] = [];
  constructor(public name: string) {}
  private makeRequest<T>(result: T): IDBRequestLike {
    const request: IDBRequestLike = {
      result,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => request.onsuccess?.(new Event("success")));
    return request;
  }
  add(value: Row): IDBRequestLike {
    this.rows.push(value);
    return this.makeRequest(value.id);
  }
  put(value: Row): IDBRequestLike {
    const idx = this.rows.findIndex((r) => r.id === value.id);
    if (idx >= 0) this.rows[idx] = value;
    else this.rows.push(value);
    return this.makeRequest(value.id);
  }
  delete(key: string): IDBRequestLike {
    this.rows = this.rows.filter((r) => r.id !== key);
    return this.makeRequest(undefined);
  }
  clear(): IDBRequestLike {
    this.rows = [];
    return this.makeRequest(undefined);
  }
  get(key: string): IDBRequestLike {
    return this.makeRequest(this.rows.find((r) => r.id === key) ?? undefined);
  }
  getAll(): IDBRequestLike {
    return this.makeRequest([...this.rows]);
  }
  count(): IDBRequestLike {
    return this.makeRequest(this.rows.length);
  }
}

class FakeTransaction implements IDBTransactionLike {
  store: FakeStore;
  constructor(store: FakeStore) {
    this.store = store;
  }
  objectStore(_name: string): IDBObjectStoreLike {
    return this.store;
  }
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
}

class FakeDB implements IDBDatabaseLike {
  stores: Map<string, FakeStore> = new Map();
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  transaction(_names: string | string[], _mode?: "readonly" | "readwrite") {
    const store = this.stores.get("exports");
    if (!store) throw new Error("exports store not found in FakeDB");
    return new FakeTransaction(store);
  }
  objectStore(name: string): IDBObjectStoreLike {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeStore(name);
      this.stores.set(name, store);
    }
    return store;
  }
  createObjectStore(name: string): IDBObjectStoreLike {
    const store = new FakeStore(name);
    this.stores.set(name, store);
    return store;
  }
  close(): void {}
}

class FakeRequest implements IDBOpenDBRequestLike {
  result: IDBDatabaseLike | null = null;
  error: unknown = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: Event) => void) | null = null;
}

class FakeIDB implements IDBFactoryLike {
  request: FakeRequest;
  upgradeOldVersion = 0;
  constructor() {
    this.request = new FakeRequest();
  }
  open(name: string, version: number): IDBOpenDBRequestLike {
    const req = this.request;
    queueMicrotask(() => {
      // The real IDB sets request.result to the new db BEFORE
      // firing onupgradeneeded, so the callback can read it.
      const db = new FakeDB();
      req.result = db;
      if (req.onupgradeneeded) {
        const ev = { oldVersion: this.upgradeOldVersion } as unknown as Event;
        req.onupgradeneeded(ev);
        this.upgradeOldVersion = version;
      }
      req.onsuccess?.(new Event("success"));
    });
    return req;
  }
}

describe("export storage / createExportHistoryStorage", () => {
  it("returns null when IDB is unavailable", () => {
    expect(createExportHistoryStorage(null)).toBeNull();
  });

  it("add() persists a record and list() returns it", async () => {
    const idb = new FakeIDB();
    const storage = createExportHistoryStorage(idb);
    expect(storage).not.toBeNull();
    const record = await storage!.add({
      fileName: "test.jpg",
      profileId: "instagram-feed",
      profileLabel: "Instagram Feed",
      width: 1350,
      height: 1013,
      maxLongestEdge: 1350,
      format: "jpeg",
      quality: 92,
      srgb: true,
      sharpen: 0.4,
      stripExif: true,
      optimizeForSocial: true,
      watermark: false,
      filterName: "Original",
      filterStrength: 100,
      effectIntensity: 100,
    });
    expect(record.id).toBeTruthy();
    expect(record.date).toBeGreaterThan(0);
    const all = await storage!.list();
    expect(all).toHaveLength(1);
    expect(all[0].fileName).toBe("test.jpg");
  });

  it("list() is sorted newest first", async () => {
    const idb = new FakeIDB();
    const storage = createExportHistoryStorage(idb)!;
    const first = await storage.add({
      fileName: "a.jpg",
      profileId: "custom",
      profileLabel: "Custom",
      width: 800,
      height: 600,
      maxLongestEdge: null,
      format: "jpeg",
      quality: 95,
      srgb: false,
      sharpen: 0,
      stripExif: false,
      optimizeForSocial: false,
      watermark: false,
      filterName: "Original",
      filterStrength: 100,
      effectIntensity: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await storage.add({
      fileName: "b.jpg",
      profileId: "custom",
      profileLabel: "Custom",
      width: 800,
      height: 600,
      maxLongestEdge: null,
      format: "jpeg",
      quality: 95,
      srgb: false,
      sharpen: 0,
      stripExif: false,
      optimizeForSocial: false,
      watermark: false,
      filterName: "Original",
      filterStrength: 100,
      effectIntensity: 100,
    });
    const all = await storage.list();
    expect(all[0].id).toBe(second.id);
    expect(all[1].id).toBe(first.id);
  });

  it("remove() drops a record", async () => {
    const idb = new FakeIDB();
    const storage = createExportHistoryStorage(idb)!;
    const record = await storage.add({
      fileName: "x.jpg",
      profileId: "custom",
      profileLabel: "Custom",
      width: 800,
      height: 600,
      maxLongestEdge: null,
      format: "jpeg",
      quality: 95,
      srgb: false,
      sharpen: 0,
      stripExif: false,
      optimizeForSocial: false,
      watermark: false,
      filterName: "Original",
      filterStrength: 100,
      effectIntensity: 100,
    });
    await storage.remove(record.id);
    const all = await storage.list();
    expect(all).toHaveLength(0);
  });

  it("clear() empties the store", async () => {
    const idb = new FakeIDB();
    const storage = createExportHistoryStorage(idb)!;
    await storage.add({
      fileName: "a.jpg",
      profileId: "custom",
      profileLabel: "Custom",
      width: 800,
      height: 600,
      maxLongestEdge: null,
      format: "jpeg",
      quality: 95,
      srgb: false,
      sharpen: 0,
      stripExif: false,
      optimizeForSocial: false,
      watermark: false,
      filterName: "Original",
      filterStrength: 100,
      effectIntensity: 100,
    });
    await storage.clear();
    const all = await storage.list();
    expect(all).toHaveLength(0);
  });

  it("getById() returns the matching record or null", async () => {
    const idb = new FakeIDB();
    const storage = createExportHistoryStorage(idb)!;
    const record = await storage.add({
      fileName: "a.jpg",
      profileId: "custom",
      profileLabel: "Custom",
      width: 800,
      height: 600,
      maxLongestEdge: null,
      format: "jpeg",
      quality: 95,
      srgb: false,
      sharpen: 0,
      stripExif: false,
      optimizeForSocial: false,
      watermark: false,
      filterName: "Original",
      filterStrength: 100,
      effectIntensity: 100,
    });
    const fetched = await storage.getById(record.id);
    expect(fetched?.fileName).toBe("a.jpg");
    const missing = await storage.getById("nope");
    expect(missing).toBeNull();
  });
});
