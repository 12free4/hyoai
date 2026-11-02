import { indexedDBStorage as storage } from "@/lib/storage/backend";
import type { SizeChange } from "@/lib/storage/indexeddbAdapter";
import type { StorageUsage } from "@/types/storage";
let dirty = true,
    version = 0,
    calibratedAt = 0;
let sizes = new Map<string, number>();
let calibration: Promise<void> | null = null;
export function invalidateUsage(): void {
    dirty = true;
    version++;
}
export function recordSizes(changes: readonly SizeChange[]): void {
    version++;
    for (const change of changes) {
        if (change.currentSize) sizes.set(change.key, change.currentSize);
        else sizes.delete(change.key);
    }
}
async function calibrate(): Promise<void> {
    const before = version;
    const keys = await storage.keys("");
    const snapshot = await storage.readSnapshot(keys);
    const next = new Map<string, number>();
    for (const [key, value] of snapshot.values)
        if (value !== null) next.set(key, (key.length + value.length) * 2);
    if (before !== version) {
        dirty = true;
        return;
    }
    sizes = next;
    dirty = false;
    calibratedAt = Date.now();
}
export async function estimateUsage(): Promise<StorageUsage> {
    if (dirty || Date.now() - calibratedAt > 60_000) {
        if (!calibration)
            calibration = calibrate().finally(() => {
                calibration = null;
            });
        await calibration;
    }
    let usedBytes = 0,
        quotaBytes = 0;
    try {
        const estimate = await navigator.storage?.estimate();
        usedBytes = estimate?.usage ?? 0;
        quotaBytes = estimate?.quota ?? 0;
    } catch {}
    return {
        usedBytes,
        quotaBytes,
        logicalBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
        conversations: [...sizes]
            .filter(([key]) => key.startsWith("conversation:"))
            .map(([key, bytes]) => ({ id: key.slice(13), bytes })),
    };
}
