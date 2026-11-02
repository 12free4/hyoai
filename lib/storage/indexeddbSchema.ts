export const DATABASE_NAME = "hyoai";
export const DATABASE_VERSION = 1;
export const DATA_SCHEMA_VERSION = 1;
export const STORE_NAME = "kv";

export const IDB_KEYS = {
    meta: "meta",
    conversationsIndex: "conversations:index",
    conversationPrefix: "conversation:",
    conversationStatePrefix: "conversation-state:",
    conversation: (id: string) => `conversation:${id}`,
    conversationState: (id: string) => `conversation-state:${id}`,
} as const;

export function isReservedKey(key: string): boolean {
    return (
        key === IDB_KEYS.meta ||
        key === IDB_KEYS.conversationsIndex ||
        key.startsWith(IDB_KEYS.conversationPrefix) ||
        key.startsWith(IDB_KEYS.conversationStatePrefix)
    );
}
