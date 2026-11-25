import { StorageQuotaError, type StorageAdapter } from "@/lib/storage/adapter";
import { STORAGE_KEYS } from "@/types/storage";

const DATABASE_NAME = "hyoai-global";
const DATABASE_VERSION = 1;
const STORE_NAME = "kv";
const LEGACY_MIGRATION_KEY = "__hyoai_local_storage_migration_v1__";

type LegacyStorage = Pick<Storage, "length" | "key" | "getItem">;

interface IndexedDBAdapterOptions {
    factory?: IDBFactory | null;
    legacyStorage?: LegacyStorage | null;
    isAllowed?: (key: string) => boolean;
    onChange?: (key: string) => void;
}

function isQuotaError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "QuotaExceededError"
    );
}

function storageError(error: unknown, key?: string): Error {
    if (isQuotaError(error)) {
        return new StorageQuotaError(
            key
                ? `IndexedDB quota exceeded while writing "${key}"`
                : "IndexedDB quota exceeded",
            key,
        );
    }
    return error instanceof Error ? error : new Error(String(error));
}

function getLegacyStorage(): LegacyStorage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function legacyEntries(storage: LegacyStorage | null): Array<[string, string]> {
    if (!storage) return [];
    const entries: Array<[string, string]> = [];
    try {
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (!key?.startsWith("lc:")) continue;
            const value = storage.getItem(key);
            if (value !== null) entries.push([key, value]);
        }
    } catch {
        // If localStorage is blocked, leave the new database usable and empty.
    }
    return entries;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request: IDBOpenDBRequest;
        try {
            request = factory.open(DATABASE_NAME, DATABASE_VERSION);
        } catch (error) {
            reject(storageError(error));
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
            if (settled) {
                request.result.close();
                return;
            }
            settled = true;
            resolve(request.result);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            reject(storageError(request.error ?? new Error("Could not open IndexedDB")));
        };
        request.onblocked = () => {
            if (settled) return;
            settled = true;
            reject(new Error("IndexedDB open is blocked by another tab"));
        };
    });
}

/**
 * Run an IndexedDB transaction and resolve only after the transaction commits.
 * Returning the request lets callers read its result after the commit.
 */
function transact<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => T,
    key?: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        let tx: IDBTransaction;
        let result: T;
        try {
            tx = db.transaction(STORE_NAME, mode);
            result = run(tx.objectStore(STORE_NAME));
        } catch (error) {
            reject(storageError(error, key));
            return;
        }
        tx.oncomplete = () => resolve(result);
        const fail = () => reject(storageError(tx.error ?? new Error("IndexedDB transaction failed"), key));
        tx.onerror = fail;
        tx.onabort = fail;
    });
}

/**
 * Copy the old lc:* localStorage records into IndexedDB once, in one atomic
 * transaction. The source values are deliberately retained as a rollback
 * backup; the migration marker prevents a later clear-all from resurrecting
 * them on the next boot.
 */
function migrateLegacyStorage(db: IDBDatabase, legacy: LegacyStorage | null): Promise<void> {
    const entries = legacyEntries(legacy);
    return new Promise((resolve, reject) => {
        let tx: IDBTransaction;
        try {
            tx = db.transaction(STORE_NAME, "readwrite");
        } catch (error) {
            reject(storageError(error));
            return;
        }
        const store = tx.objectStore(STORE_NAME);
        const marker = store.get(LEGACY_MIGRATION_KEY);
        marker.onsuccess = () => {
            if (marker.result === "done") return;
            try {
                for (const [key, value] of entries) store.put(value, key);
                store.put("done", LEGACY_MIGRATION_KEY);
            } catch (error) {
                try {
                    tx.abort();
                } catch {
                    // The transaction may already have aborted.
                }
                reject(storageError(error));
            }
        };
        tx.oncomplete = () => resolve();
        const fail = () => reject(storageError(tx.error ?? new Error("Legacy storage migration failed")));
        tx.onerror = fail;
        tx.onabort = fail;
    });
}

/**
 * Key/value StorageAdapter backed by IndexedDB. The old export name
 * localStorageAdapter is retained at the call sites, but application data is
 * stored in IndexedDB from this version onward.
 */
export class IndexedDBKeyValueAdapter implements StorageAdapter {
    private readonly factory: IDBFactory | undefined;
    private readonly legacyStorage: LegacyStorage | null;
    private readonly isAllowed: (key: string) => boolean;
    private readonly onChange: (key: string) => void;
    private opening: Promise<IDBDatabase> | null = null;

    constructor(options: IndexedDBAdapterOptions = {}) {
        this.factory =
            options.factory === null
                ? undefined
                : (options.factory ??
                  (typeof indexedDB === "undefined" ? undefined : indexedDB));
        this.legacyStorage =
            options.legacyStorage === undefined ? getLegacyStorage() : options.legacyStorage;
        this.isAllowed = options.isAllowed ?? (() => true);
        this.onChange = options.onChange ?? (() => {});
    }

    private database(): Promise<IDBDatabase> {
        if (this.opening) return this.opening;
        if (!this.factory) return Promise.reject(new Error("IndexedDB is not available in this browser"));

        let tracked: Promise<IDBDatabase>;
        tracked = openDatabase(this.factory)
            .then(async (db) => {
                db.onversionchange = () => {
                    db.close();
                    if (this.opening === tracked) this.opening = null;
                };
                try {
                    await migrateLegacyStorage(db, this.legacyStorage);
                    return db;
                } catch (error) {
                    db.close();
                    throw error;
                }
            })
            .catch((error) => {
                if (this.opening === tracked) this.opening = null;
                throw error;
            });
        this.opening = tracked;
        return tracked;
    }

    async get(key: string): Promise<string | null> {
        if (typeof window === "undefined") return null;
        const db = await this.database();
        const request = await transact(db, "readonly", (store) => store.get(key), key);
        return typeof request.result === "string" ? request.result : null;
    }

    async set(key: string, value: string): Promise<void> {
        if (typeof window === "undefined" || !this.isAllowed(key)) return;
        const db = await this.database();
        await transact(db, "readwrite", (store) => store.put(value, key), key);
        this.mirrorBootValue(key, value);
        this.onChange(key);
    }

    async remove(key: string): Promise<void> {
        if (typeof window === "undefined" || !this.isAllowed(key)) return;
        const db = await this.database();
        await transact(db, "readwrite", (store) => store.delete(key), key);
        this.mirrorBootValue(key, null);
        this.onChange(key);
    }

    async keys(prefix: string): Promise<string[]> {
        if (typeof window === "undefined") return [];
        const db = await this.database();
        const request = await transact(db, "readonly", (store) => store.getAllKeys());
        return (request.result as IDBValidKey[]).filter(
            (key): key is string => typeof key === "string" && key.startsWith(prefix),
        );
    }

    private mirrorBootValue(key: string, value: string | null): void {
        if (key !== STORAGE_KEYS.skin && key !== STORAGE_KEYS.motion) return;
        try {
            if (value === null) window.localStorage.removeItem(key);
            else window.localStorage.setItem(key, value);
        } catch {
            // The mirror only prevents a pre-paint flash; IndexedDB remains authoritative.
        }
    }
}
