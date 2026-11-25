import { IndexedDBKeyValueAdapter } from "@/lib/storage/indexeddbAdapter";

/**
 * Per-key write gate. Embedded widgets can read the host's stored state while
 * dropping writes that the current embed mode is not allowed to persist.
 */
let persistenceGate: ((key: string) => boolean) | null = null;

export function setPersistenceGate(gate: ((key: string) => boolean) | null): void {
    persistenceGate = gate;
}

export function isPersistenceAllowed(key: string): boolean {
    return persistenceGate === null || persistenceGate(key);
}

type StorageChangeListener = (key: string) => void;
const listeners = new Set<StorageChangeListener>();
const SYNC_KEY = "hyoai:storage-sync";
let channel: BroadcastChannel | null = null;
let channelInitialized = false;

function dispatchStorageChange(key: string): void {
    for (const listener of listeners) {
        try {
            listener(key);
        } catch {
            // A stale view must not break the storage pipeline.
        }
    }
}

function onStorageSignal(event: StorageEvent): void {
    if (event.key !== SYNC_KEY || !event.newValue) return;
    try {
        const message = JSON.parse(event.newValue) as { key?: unknown };
        if (typeof message.key === "string") dispatchStorageChange(message.key);
    } catch {
        // Ignore malformed cross-tab notifications.
    }
}

function ensureStorageChannel(): void {
    if (channelInitialized || typeof window === "undefined") return;
    channelInitialized = true;
    if (typeof BroadcastChannel !== "undefined") {
        try {
            channel = new BroadcastChannel("hyoai-storage-v1");
            channel.onmessage = (event: MessageEvent<{ key?: unknown }>) => {
                if (typeof event.data?.key === "string") dispatchStorageChange(event.data.key);
            };
            return;
        } catch {
            channel = null;
        }
    }
    window.addEventListener("storage", onStorageSignal);
}

/** Subscribe to changes committed by another same-origin HYOAI tab. */
export function onStorageChange(listener: StorageChangeListener): () => void {
    listeners.add(listener);
    ensureStorageChannel();
    return () => listeners.delete(listener);
}

function publishStorageChange(key: string): void {
    ensureStorageChannel();
    if (channel) {
        channel.postMessage({ key });
        return;
    }
    try {
        window.localStorage.setItem(SYNC_KEY, JSON.stringify({ key, nonce: Date.now() }));
    } catch {
        // Cross-tab refresh is best-effort; the committed IndexedDB write stands.
    }
}

/**
 * Remove the retained localStorage backup after an explicit user-requested
 * clear-all. Ordinary migration and conversation deletion leave the backup alone.
 */
export function clearLegacyBackup(): void {
    if (typeof window === "undefined") return;
    try {
        for (let index = window.localStorage.length - 1; index >= 0; index--) {
            const key = window.localStorage.key(index);
            if (key?.startsWith("lc:")) window.localStorage.removeItem(key);
        }
    } catch {
        // The authoritative IndexedDB database has already been cleared.
    }
}

/**
 * Compatibility singleton: the implementation now uses IndexedDB; retaining
 * this name avoids changing every existing persistence call site at once.
 */
export const localStorageAdapter = new IndexedDBKeyValueAdapter({
    isAllowed: isPersistenceAllowed,
    onChange: publishStorageChange,
});
