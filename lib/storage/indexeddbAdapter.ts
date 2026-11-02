import type { ConversationMeta } from "@/types/chat";

/** Storage operations for the new database, independent of the legacy adapter. */
export type StorageErrorCode =
    | "ID_COLLISION"
    | "STALE_DB_EPOCH"
    | "STALE_CONVERSATION_EPOCH"
    | "REVISION_CONFLICT"
    | "QUOTA_EXCEEDED"
    | "DATABASE_ERROR";

export class IndexedDBStorageError extends Error {
    constructor(
        public readonly code: StorageErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "IndexedDBStorageError";
    }
}

export interface DatabaseMeta {
    dataSchemaVersion: number;
    dbEpoch: string;
    conversationEpoch: string;
}

export interface WriteContext {
    dbEpoch: string;
}

export interface ConversationWriteContext extends WriteContext {
    conversationEpoch: string;
}

export interface StorageSnapshot extends ConversationWriteContext {
    values: ReadonlyMap<string, string | null>;
}

export interface SizeChange {
    key: string;
    previousSize: number;
    currentSize: number;
}

export interface WriteReceipt extends SizeChange {
    epoch: WriteContext;
}

export interface CommitReceipt {
    conversationId: string;
    revision: number;
    deleted: boolean;
    epoch: ConversationWriteContext;
    changes: SizeChange[];
}

export interface ResetReceipt {
    scope: "conversations" | "all";
    previousEpoch: ConversationWriteContext;
    epoch: ConversationWriteContext;
    usageDirty: true;
}

export interface IndexedDBStorageAdapter {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, context: WriteContext): Promise<WriteReceipt>;
    remove(key: string, context: WriteContext): Promise<WriteReceipt>;
    keys(prefix: string): Promise<string[]>;
    readSnapshot(keys: readonly string[]): Promise<StorageSnapshot>;
}

export type CommitConversationInput =
    | {
          kind: "create";
          id: string;
          expectedRevision: null;
          metadata: ConversationMeta;
          value: string;
          context: ConversationWriteContext;
      }
    | {
          kind: "update";
          id: string;
          expectedRevision: number;
          metadata?: Partial<Omit<ConversationMeta, "id">>;
          value?: string;
          context: ConversationWriteContext;
      };

export interface ConversationOperations {
    commitConversation(input: CommitConversationInput): Promise<CommitReceipt>;
    deleteConversation(input: {
        id: string;
        expectedRevision: number;
        context: ConversationWriteContext;
    }): Promise<CommitReceipt>;
    clearConversations(context: ConversationWriteContext): Promise<ResetReceipt>;
    clearAll(context: ConversationWriteContext): Promise<ResetReceipt>;
}
