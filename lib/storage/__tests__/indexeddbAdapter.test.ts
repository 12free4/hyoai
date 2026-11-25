import { afterEach, describe, expect, it, vi } from "vitest";

import { IndexedDBKeyValueAdapter } from "../indexeddbAdapter";

class MemoryStorage {
    private readonly values = new Map<string, string>();

    constructor(entries: Array<[string, string]> = []) {
        for (const [key, value] of entries) this.values.set(key, value);
    }

    get length(): number {
        return this.values.size;
    }

    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

function fakeFactory() {
    const rows = new Map<IDBValidKey, unknown>();
    const stats = { opens: 0 };
    let hasStore = false;

    const store = {
        get(key: IDBValidKey) {
            const request = { result: rows.get(key), onsuccess: null as null | (() => void) };
            queueMicrotask(() => request.onsuccess?.());
            return request;
        },
        put(value: unknown, key: IDBValidKey) {
            rows.set(key, value);
            return {};
        },
        delete(key: IDBValidKey) {
            rows.delete(key);
            return {};
        },
        getAllKeys() {
            const request = {
                result: [...rows.keys()],
                onsuccess: null as null | (() => void),
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
        },
    };

    const db = {
        objectStoreNames: { contains: () => hasStore },
        createObjectStore: () => {
            hasStore = true;
            return store;
        },
        transaction: () => {
            const tx = {
                error: null as unknown,
                oncomplete: null as null | (() => void),
                onerror: null as null | (() => void),
                onabort: null as null | (() => void),
                objectStore: () => store,
            };
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            return tx;
        },
        close: () => {},
        onversionchange: null as null | (() => void),
    };

    const factory = {
        open: () => {
            stats.opens += 1;
            const request = {
                result: db,
                error: null,
                onupgradeneeded: null as null | ((event: IDBVersionChangeEvent) => void),
                onsuccess: null as null | (() => void),
                onerror: null as null | (() => void),
                onblocked: null as null | (() => void),
            };
            queueMicrotask(() => {
                request.onupgradeneeded?.({ oldVersion: 0 } as IDBVersionChangeEvent);
                request.onsuccess?.();
            });
            return request;
        },
    } as unknown as IDBFactory;

    return { factory, rows, stats };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("IndexedDBKeyValueAdapter", () => {
    it("atomically imports lc:* localStorage values and retains the backup", async () => {
        const legacy = new MemoryStorage([
            ["lc:settings", '{"theme":"dark"}'],
            ["lc:convs", "[]"],
            ["unrelated", "leave-me"],
        ]);
        vi.stubGlobal("window", { localStorage: legacy });
        const { factory, stats } = fakeFactory();
        const adapter = new IndexedDBKeyValueAdapter({ factory, legacyStorage: legacy });

        expect(await adapter.get("lc:settings")).toBe('{"theme":"dark"}');
        expect(await adapter.keys("lc:")).toEqual(["lc:settings", "lc:convs"]);
        expect(legacy.getItem("lc:settings")).toBe('{"theme":"dark"}');
        expect(await adapter.get("unrelated")).toBeNull();
        expect(stats.opens).toBe(1);
    });

    it("does not resurrect legacy values after a key is explicitly removed", async () => {
        const legacy = new MemoryStorage([["lc:settings", "old"]]);
        vi.stubGlobal("window", { localStorage: legacy });
        const { factory } = fakeFactory();
        const adapter = new IndexedDBKeyValueAdapter({ factory, legacyStorage: legacy });

        expect(await adapter.get("lc:settings")).toBe("old");
        await adapter.remove("lc:settings");
        expect(await adapter.get("lc:settings")).toBeNull();
    });

    it("respects the embed write gate and announces committed writes", async () => {
        const legacy = new MemoryStorage();
        vi.stubGlobal("window", { localStorage: legacy });
        const { factory } = fakeFactory();
        const changes: string[] = [];
        const adapter = new IndexedDBKeyValueAdapter({
            factory,
            legacyStorage: legacy,
            isAllowed: (key) => key !== "lc:blocked",
            onChange: (key) => changes.push(key),
        });

        await adapter.set("lc:blocked", "ignored");
        await adapter.set("lc:settings", "saved");

        expect(await adapter.get("lc:blocked")).toBeNull();
        expect(await adapter.get("lc:settings")).toBe("saved");
        expect(changes).toEqual(["lc:settings"]);
    });
});
