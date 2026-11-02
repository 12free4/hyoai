import type { ConversationWriteContext } from "@/lib/storage/indexeddbAdapter";

export type StorageCommit =
    | {
          kind: "conversation";
          id: string;
          revision: number;
          deleted: boolean;
          epoch: ConversationWriteContext;
      }
    | { kind: "reset"; scope: "conversations" | "all"; epoch: ConversationWriteContext }
    | { kind: "kv"; key: string; dbEpoch: string };
const listeners = new Set<(event: StorageCommit) => void>();
/** Called only after a successful database transaction; remote refreshes never emit. */
export function emitStorageCommit(event: StorageCommit): void {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch (error) {
            console.warn("hyoai: commit observer failed", error);
        }
    }
}
export function onStorageCommit(listener: (event: StorageCommit) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
