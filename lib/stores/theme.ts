import { onStorageCommit } from "@/lib/storage/events";
import { isPersistenceAllowed } from "@/lib/storage/gate";
import { loadRaw, storageOperationStore, writeRawNow } from "@/lib/storage/persistence";
import { createStore } from "@/lib/store";
export type Theme = "light" | "dark" | "system";
export const themeStore = createStore<{ theme: Theme; ready: boolean }>({
    theme: "system",
    ready: false,
});
export const isTheme = (value: unknown): value is Theme =>
    value === "light" || value === "dark" || value === "system";
let tail: Promise<unknown> = Promise.resolve();
function ordered(work: () => Promise<void>): Promise<void> {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
}
export function hydrateTheme(): Promise<void> {
    return ordered(async () => {
        const value = await loadRaw("theme");
        themeStore.setState({ theme: isTheme(value) ? value : "system", ready: true });
    });
}
/** Sole user-facing entry point; only committed values reach the rendering bridge. */
export function setTheme(value: string): Promise<void> {
    if (
        !isTheme(value) ||
        !isPersistenceAllowed("theme") ||
        storageOperationStore.getState().clearing === "all"
    )
        return Promise.resolve();
    return ordered(async () => {
        await writeRawNow("theme", value);
        themeStore.setState({ theme: value, ready: true });
    });
}

onStorageCommit((change) => {
    if (change.kind === "kv" && change.key === "theme")
        void hydrateTheme().catch((error) =>
            console.warn("hyoai: committed theme refresh failed", error),
        );
});
