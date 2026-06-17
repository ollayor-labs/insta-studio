import { describe, expect, it } from 'vitest';
import {
  createRecentsStorage,
  type IDBFactoryLike,
  type IDBObjectStoreLike,
  type IDBOpenDBRequestLike,
  type IDBDatabaseLike,
} from '@/lib/recents';

// A minimal in-memory IndexedDB facade. The recents storage only ever calls
// the four methods we implement below (`open`, `transaction`,
// `objectStore(..., ...).{add, delete, clear, getAll}`), so we don't need a
// full fake-indexeddb - we just model the surface it actually uses.

interface Row {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: number;
  blob: Blob;
}

class FakeStore implements IDBObjectStoreLike {
  rows: Row[] = [];
  add(value: Row): {
    result: unknown;
    error: unknown;
    onsuccess: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  } {
    const request = makeRequest();
    queueMicrotask(() => {
      this.rows.push(value);
      request.result = value.id;
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
  put(value: Row): {
    result: unknown;
    error: unknown;
    onsuccess: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  } {
    const request = makeRequest();
    queueMicrotask(() => {
      this.rows.push(value);
      request.result = value.id;
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
  delete(key: string): {
    result: unknown;
    error: unknown;
    onsuccess: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  } {
    const request = makeRequest();
    queueMicrotask(() => {
      this.rows = this.rows.filter((r) => r.id !== key);
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
  clear(): {
    result: unknown;
    error: unknown;
    onsuccess: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  } {
    const request = makeRequest();
    queueMicrotask(() => {
      this.rows = [];
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
  get(key: string): {
    result: unknown;
    error: unknown;
    onsuccess: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  } {
    const request = makeRequest();
    queueMicrotask(() => {
      request.result = this.rows.find((r) => r.id === key) ?? undefined;
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
  getAll(): {
    result: unknown;
    error: unknown;
    onsuccess: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  } {
    const request = makeRequest();
    queueMicrotask(() => {
      request.result = this.rows.slice();
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
  count(): never {
    throw new Error('count() not implemented in fake');
  }
}

function makeRequest(): {
  result: unknown;
  error: unknown;
  onsuccess: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
} {
  return { result: null, error: null, onsuccess: null, onerror: null };
}

class FakeDb implements IDBDatabaseLike {
  store = new FakeStore();
  objectStoreNames = { contains: (name: string) => name === "recents" };
  transaction(): {
    objectStore: () => IDBObjectStoreLike;
    oncomplete: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
    onabort: ((e: Event) => void) | null;
  } {
    const tx = {
      objectStore: () => this.store,
      oncomplete: null as ((e: Event) => void) | null,
      onerror: null as ((e: Event) => void) | null,
      onabort: null as ((e: Event) => void) | null,
    };
    queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
    return tx;
  }
  objectStore(): IDBObjectStoreLike {
    return this.store;
  }
  createObjectStore(): IDBObjectStoreLike {
    return this.store;
  }
  close(): void {}
}

function makeFactory(): IDBFactoryLike & { __lastDb: FakeDb | null } {
  let lastDb: FakeDb | null = null;
  return {
    __lastDb: null,
    open(): IDBOpenDBRequestLike {
      lastDb = new FakeDb();
      const req = {
        result: null as IDBDatabaseLike | null,
        error: null,
        onsuccess: null as ((e: Event) => void) | null,
        onerror: null as ((e: Event) => void) | null,
        onupgradeneeded: null as ((e: Event) => void) | null,
      };
      queueMicrotask(() => {
        // Dispatch an upgradeneeded event with oldVersion=0 so the
        // production code's first-install branch runs. A real browser
        // would send a proper IDBVersionChangeEvent; we only read
        // `oldVersion` off the event, so a plain Event works.
        const ev = { oldVersion: 0 } as unknown as Event;
        req.onupgradeneeded?.(ev);
        req.result = lastDb;
        req.onsuccess?.(new Event('success'));
      });
      return req;
    },
  };
}

function blob(content: string, type = 'image/jpeg'): Blob {
  return new Blob([content], { type });
}

describe('recents storage', () => {
  it('returns null when no IDB factory is available', () => {
    const storage = createRecentsStorage(null);
    expect(storage).toBeNull();
  });

  it('stores a recent and lists it back, newest first', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory);
    expect(storage).not.toBeNull();

    const first = await storage!.add({ name: 'a.jpg', mimeType: 'image/jpeg', blob: blob('a'), exifBytes: null });
    // Small delay so addedAt is strictly greater.
    await new Promise((r) => setTimeout(r, 5));
    const second = await storage!.add({ name: 'b.png', mimeType: 'image/png', blob: blob('b'), exifBytes: null });

    const list = await storage!.list();
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list[0].name).toBe('b.png');
  });

  it('caps the list at the configured max and evicts the oldest entries', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory)!;
    expect(storage.maxEntries).toBe(12);

    // Add maxEntries + 3 items; the oldest 3 should be evicted.
    for (let index = 0; index < storage.maxEntries + 3; index += 1) {
      await storage.add({ name: `img-${index}.jpg`, mimeType: 'image/jpeg', blob: blob(`x${index}`), exifBytes: null });
      // tiny delay so addedAt strictly increases
      await new Promise((r) => setTimeout(r, 10));
    }

    const list = await storage.list();
    expect(list).toHaveLength(storage.maxEntries);
    // Newest 12 are kept: img-14, img-13, ..., img-3
    expect(list[0].name).toBe(`img-${storage.maxEntries + 3 - 1}.jpg`);
    expect(list[list.length - 1].name).toBe('img-3.jpg');
  });

  it('removes a single entry by id', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory)!;
    const a = await storage.add({ name: 'a.jpg', mimeType: 'image/jpeg', blob: blob('a'), exifBytes: null });
    await new Promise((r) => setTimeout(r, 2));
    const b = await storage.add({ name: 'b.jpg', mimeType: 'image/jpeg', blob: blob('b'), exifBytes: null });

    await storage.remove(a.id);
    const list = await storage.list();
    expect(list.map((r) => r.id)).toEqual([b.id]);
  });

  it('clears all entries', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory)!;
    await storage.add({ name: 'a.jpg', mimeType: 'image/jpeg', blob: blob('a'), exifBytes: null });
    await storage.add({ name: 'b.jpg', mimeType: 'image/jpeg', blob: blob('b'), exifBytes: null });

    await storage.clear();
    const list = await storage.list();
    expect(list).toEqual([]);
  });

  it('preserves blob contents across the round trip', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory)!;
    const payload = blob('hello-world', 'image/png');
    const record = await storage.add({ name: 'x.png', mimeType: 'image/png', blob: payload, exifBytes: null });

    // list() returns metadata only -- the full bytes are NOT
    // included so the recents UI doesn't hold a dozen blobs in
    // memory. Use getById() to fetch the full record.
    const list = await storage.list();
    const found = list.find((r) => r.id === record.id);
    expect(found).toBeDefined();
    // Metadata-only shape: no blob / exifBytes on the listed entry.
    expect((found as unknown as { blob?: unknown }).blob).toBeUndefined();

    const full = await storage.getById(record.id);
    expect(full).not.toBeNull();
    expect(full!.blob.size).toBe(payload.size);
    expect(full!.blob.type).toBe('image/png');
    const text = await full!.blob.text();
    expect(text).toBe('hello-world');
  });

  it('list() returns metadata only (no blob, no exifBytes)', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory)!;
    await storage.add({
      name: 'a.jpg',
      mimeType: 'image/jpeg',
      blob: blob('a-payload'),
      exifBytes: new Uint8Array([0x01, 0x02]),
    });

    const list = await storage.list();
    expect(list).toHaveLength(1);
    const entry = list[0] as unknown as Record<string, unknown>;
    expect(entry.blob).toBeUndefined();
    expect(entry.exifBytes).toBeUndefined();
    // The metadata fields are present.
    expect(entry.name).toBe('a.jpg');
    expect(entry.mimeType).toBe('image/jpeg');
  });

  it('getById returns null for unknown ids', async () => {
    const factory = makeFactory();
    const storage = createRecentsStorage(factory)!;
    const found = await storage.getById('does-not-exist');
    expect(found).toBeNull();
  });
});
