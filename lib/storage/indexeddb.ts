import {
    type CommitConversationInput,
    type CommitReceipt,
    type ConversationOperations,
    type ConversationWriteContext,
    type DatabaseMeta,
    type IndexedDBStorageAdapter,
    IndexedDBStorageError,
    type ResetReceipt,
    type SizeChange,
    type StorageSnapshot,
    type WriteContext,
    type WriteReceipt,
} from "@/lib/storage/indexeddbAdapter";
import {
    DATA_SCHEMA_VERSION,
    DATABASE_NAME,
    DATABASE_VERSION,
    IDB_KEYS,
    isReservedKey,
    STORE_NAME,
} from "@/lib/storage/indexeddbSchema";
import type { ConversationMeta } from "@/types/chat";

type State = { revision: number; deleted: boolean };

function error(error: unknown): IndexedDBStorageError {
    if (error instanceof IndexedDBStorageError) return error;
    const name = (error as { name?: string } | null)?.name;
    return new IndexedDBStorageError(
        name === "QuotaExceededError" ? "QUOTA_EXCEEDED" : "DATABASE_ERROR",
        error instanceof Error ? error.message : String(error),
    );
}
function fail(message: string): never {
    throw new IndexedDBStorageError("DATABASE_ERROR", message);
}
function epoch(): string {
    return crypto.randomUUID();
}
function parseMeta(raw: unknown): DatabaseMeta {
    try {
        if (typeof raw !== "string") return fail("Missing database metadata");
        const meta = JSON.parse(raw) as DatabaseMeta;
        if (
            !meta ||
            meta.dataSchemaVersion !== DATA_SCHEMA_VERSION ||
            typeof meta.dbEpoch !== "string" ||
            !meta.dbEpoch ||
            typeof meta.conversationEpoch !== "string" ||
            !meta.conversationEpoch
        )
            return fail("Invalid or unsupported database metadata");
        return meta;
    } catch (e) {
        throw error(e);
    }
}
function check(meta: DatabaseMeta, context: WriteContext | ConversationWriteContext): void {
    if (!context || meta.dbEpoch !== context.dbEpoch)
        throw new IndexedDBStorageError("STALE_DB_EPOCH", "Database epoch changed");
}
function checkConversation(meta: DatabaseMeta, context: ConversationWriteContext): void {
    check(meta, context);
    if (meta.conversationEpoch !== context.conversationEpoch)
        throw new IndexedDBStorageError("STALE_CONVERSATION_EPOCH", "Conversation epoch changed");
}
function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function size(key: string, value: string | null): number {
    return value === null ? 0 : (key.length + value.length) * 2;
}
function str(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== "string") return fail("Invalid stored value");
    return value;
}
function state(raw: string | null): State | null {
    if (raw === null) return null;
    try {
        const s = JSON.parse(raw) as State;
        if (
            !s ||
            !Number.isSafeInteger(s.revision) ||
            s.revision < 1 ||
            typeof s.deleted !== "boolean"
        )
            return fail("Invalid conversation state");
        return s;
    } catch (e) {
        throw error(e);
    }
}
function index(raw: string | null): ConversationMeta[] {
    if (raw === null) return [];
    try {
        const items: unknown = JSON.parse(raw);
        if (
            !Array.isArray(items) ||
            items.some((v) => !v || typeof v !== "object" || typeof v.id !== "string")
        )
            return fail("Invalid conversation index");
        return items as ConversationMeta[];
    } catch (e) {
        throw error(e);
    }
}
function successor(prefix: string): string | null {
    for (let i = prefix.length - 1; i >= 0; i--) {
        const n = prefix.charCodeAt(i);
        if (n < 65535) return prefix.slice(0, i) + String.fromCharCode(n + 1);
    }
    return null;
}

/** Independent native IndexedDB backend. No legacy storage is consulted. */
export class IndexedDBStorage implements IndexedDBStorageAdapter, ConversationOperations {
    private connection: IDBDatabase | null = null;
    private opening: Promise<IDBDatabase> | null = null;
    private generation = 0;
    constructor(private readonly name = DATABASE_NAME) {}

    private async open(): Promise<IDBDatabase> {
        if (this.connection) return this.connection;
        if (this.opening) return this.opening;
        const generation = this.generation;
        const opening = new Promise<IDBDatabase>((resolve, reject) => {
            let rejected = false;
            let req: IDBOpenDBRequest;
            try {
                req = indexedDB.open(this.name, DATABASE_VERSION);
            } catch (e) {
                reject(error(e));
                return;
            }
            req.onupgradeneeded = (event) => {
                if (rejected || generation !== this.generation) {
                    req.transaction?.abort();
                    return;
                }
                if (event.oldVersion === 0) {
                    const store = req.result.createObjectStore(STORE_NAME);
                    const meta: DatabaseMeta = {
                        dataSchemaVersion: DATA_SCHEMA_VERSION,
                        dbEpoch: epoch(),
                        conversationEpoch: epoch(),
                    };
                    store.put(JSON.stringify(meta), IDB_KEYS.meta);
                }
            };
            req.onblocked = () => {
                rejected = true;
                reject(
                    new IndexedDBStorageError(
                        "DATABASE_ERROR",
                        "Database upgrade blocked by another connection",
                    ),
                );
            };
            req.onerror = () => reject(error(req.error));
            req.onsuccess = () => {
                const db = req.result;
                if (rejected || generation !== this.generation) {
                    db.close();
                    if (!rejected)
                        reject(new IndexedDBStorageError("DATABASE_ERROR", "Database was closed"));
                    return;
                }
                this.connection = db;
                db.onversionchange = () => {
                    db.close();
                    if (this.connection === db) this.connection = null;
                };
                db.onclose = () => {
                    if (this.connection === db) this.connection = null;
                };
                resolve(db);
            };
        });
        this.opening = opening;
        try {
            return await opening;
        } finally {
            if (this.opening === opening) this.opening = null;
        }
    }
    close(): void {
        this.generation++;
        this.connection?.close();
        this.connection = null;
    }

    private async transaction<T>(
        mode: IDBTransactionMode,
        work: (store: IDBObjectStore) => Promise<T>,
    ): Promise<T> {
        const db = await this.open();
        return new Promise<T>((resolve, reject) => {
            let tx: IDBTransaction;
            try {
                tx = db.transaction(STORE_NAME, mode);
            } catch (e) {
                reject(error(e));
                return;
            }
            let result: T;
            let failure: unknown;
            let done = false;
            tx.oncomplete = () => {
                if (done) resolve(result);
                else reject(error(failure ?? "Transaction completed before operation"));
            };
            tx.onabort = () => reject(error(failure ?? tx.error ?? "Transaction aborted"));
            tx.onerror = () => {
                /* onabort provides the final transaction outcome */
            };
            work(tx.objectStore(STORE_NAME)).then(
                (value) => {
                    result = value;
                    done = true;
                },
                (e: unknown) => {
                    failure = e;
                    try {
                        tx.abort();
                    } catch {
                        reject(error(e));
                    }
                },
            );
        });
    }
    async get(key: string): Promise<string | null> {
        return this.transaction("readonly", async (s) => str(await request(s.get(key))));
    }
    async readSnapshot(keys: readonly string[]): Promise<StorageSnapshot> {
        return this.transaction("readonly", async (s) => {
            const unique = [...new Set(keys)];
            const requests = [
                request(s.get(IDB_KEYS.meta)),
                ...unique.map((k) => request(s.get(k))),
            ];
            const [raw, ...values] = await Promise.all(requests);
            const meta = parseMeta(raw);
            return {
                dbEpoch: meta.dbEpoch,
                conversationEpoch: meta.conversationEpoch,
                values: new Map(unique.map((k, i) => [k, str(values[i])])),
            };
        });
    }
    async keys(prefix: string): Promise<string[]> {
        return this.transaction(
            "readonly",
            (s) =>
                new Promise((resolve, reject) => {
                    const upper = successor(prefix);
                    const range =
                        prefix === ""
                            ? undefined
                            : upper === null
                              ? IDBKeyRange.lowerBound(prefix)
                              : IDBKeyRange.bound(prefix, upper, false, true);
                    const req = s.openKeyCursor(range);
                    const keys: string[] = [];
                    req.onerror = () => reject(req.error);
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) {
                            resolve(keys);
                            return;
                        }
                        if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
                            keys.push(cursor.key);
                            cursor.continue();
                        } else resolve(keys);
                    };
                }),
        );
    }
    private async write(
        key: string,
        value: string | null,
        context: WriteContext,
    ): Promise<WriteReceipt> {
        if (isReservedKey(key)) throw new IndexedDBStorageError("DATABASE_ERROR", "Reserved key");
        return this.transaction("readwrite", async (s) => {
            const [rawMeta, old] = await Promise.all([
                request(s.get(IDB_KEYS.meta)),
                request(s.get(key)),
            ]);
            const meta = parseMeta(rawMeta);
            check(meta, context);
            const previous = str(old);
            if (value === null) await request(s.delete(key));
            else await request(s.put(value, key));
            return {
                key,
                previousSize: size(key, previous),
                currentSize: size(key, value),
                epoch: { dbEpoch: meta.dbEpoch },
            };
        });
    }
    set(key: string, value: string, context: WriteContext): Promise<WriteReceipt> {
        return this.write(key, value, context);
    }
    remove(key: string, context: WriteContext): Promise<WriteReceipt> {
        return this.write(key, null, context);
    }

    async commitConversation(input: CommitConversationInput): Promise<CommitReceipt> {
        if (
            !input.id ||
            (input.kind !== "create" && input.kind !== "update") ||
            (input.value !== undefined && typeof input.value !== "string") ||
            (input.kind === "create" &&
                (input.expectedRevision !== null || input.metadata?.id !== input.id)) ||
            (input.kind === "update" &&
                (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
        )
            throw new IndexedDBStorageError("DATABASE_ERROR", "Invalid conversation id");
        return this.changeConversation(
            input.id,
            input.context,
            input.expectedRevision,
            input.metadata,
            input.value,
            false,
        );
    }
    async deleteConversation(input: {
        id: string;
        expectedRevision: number;
        context: ConversationWriteContext;
    }): Promise<CommitReceipt> {
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
            throw new IndexedDBStorageError("DATABASE_ERROR", "Invalid conversation revision");
        return this.changeConversation(
            input.id,
            input.context,
            input.expectedRevision,
            undefined,
            undefined,
            true,
        );
    }
    private async changeConversation(
        id: string,
        context: ConversationWriteContext,
        expected: number | null,
        metadata: Partial<ConversationMeta> | undefined,
        value: string | undefined,
        deleted: boolean,
    ): Promise<CommitReceipt> {
        if (!id) throw new IndexedDBStorageError("DATABASE_ERROR", "Invalid conversation id");
        return this.transaction("readwrite", async (s) => {
            const bodyKey = IDB_KEYS.conversation(id),
                stateKey = IDB_KEYS.conversationState(id),
                indexKey = IDB_KEYS.conversationsIndex;
            const [rawMeta, rawBody, rawState, rawIndex] = await Promise.all([
                request(s.get(IDB_KEYS.meta)),
                request(s.get(bodyKey)),
                request(s.get(stateKey)),
                request(s.get(indexKey)),
            ]);
            const meta = parseMeta(rawMeta);
            checkConversation(meta, context);
            const oldBody = str(rawBody),
                oldState = str(rawState),
                oldIndex = str(rawIndex),
                previous = state(oldState),
                items = index(oldIndex);
            const existing = items.find((m) => m.id === id);
            if (expected === null) {
                if (previous || oldBody !== null || existing)
                    throw new IndexedDBStorageError(
                        "ID_COLLISION",
                        "Conversation id already exists",
                    );
                if (!metadata || value === undefined)
                    return fail("Create requires metadata and body");
            } else if (
                !previous ||
                previous.deleted ||
                previous.revision !== expected ||
                !existing ||
                oldBody === null
            ) {
                throw new IndexedDBStorageError(
                    "REVISION_CONFLICT",
                    "Conversation revision changed",
                );
            }
            const revision = (previous?.revision ?? 0) + 1;
            if (!Number.isSafeInteger(revision)) return fail("Conversation revision exhausted");
            const nextItems = items.filter((m) => m.id !== id);
            if (!deleted)
                nextItems.push({ ...(existing ?? {}), ...metadata, id } as ConversationMeta);
            const newIndex = JSON.stringify(nextItems),
                newState = JSON.stringify({ revision, deleted });
            const newBody = deleted ? null : (value ?? oldBody);
            const changes: SizeChange[] = [
                [bodyKey, oldBody, newBody],
                [stateKey, oldState, newState],
                [indexKey, oldIndex, newIndex],
            ].map(([key, before, after]) => ({
                key: key!,
                previousSize: size(key!, before),
                currentSize: size(key!, after),
            }));
            await Promise.all([
                newBody === null ? request(s.delete(bodyKey)) : request(s.put(newBody, bodyKey)),
                request(s.put(newState, stateKey)),
                request(s.put(newIndex, indexKey)),
            ]);
            return {
                conversationId: id,
                revision,
                deleted,
                epoch: { dbEpoch: meta.dbEpoch, conversationEpoch: meta.conversationEpoch },
                changes,
            };
        });
    }
    clearConversations(context: ConversationWriteContext): Promise<ResetReceipt> {
        return this.reset(context, false);
    }
    clearAll(context: ConversationWriteContext): Promise<ResetReceipt> {
        return this.reset(context, true);
    }
    private async reset(context: ConversationWriteContext, all: boolean): Promise<ResetReceipt> {
        return this.transaction("readwrite", async (s) => {
            const meta = parseMeta(await request(s.get(IDB_KEYS.meta)));
            checkConversation(meta, context);
            const next: DatabaseMeta = {
                ...meta,
                dbEpoch: all ? epoch() : meta.dbEpoch,
                conversationEpoch: epoch(),
            };
            if (all) await request(s.clear());
            else {
                await new Promise<void>((resolve, reject) => {
                    const cursor = s.openKeyCursor();
                    cursor.onerror = () => reject(cursor.error);
                    cursor.onsuccess = () => {
                        const c = cursor.result;
                        if (!c) {
                            resolve();
                            return;
                        }
                        const k = c.key;
                        if (
                            typeof k === "string" &&
                            (k === IDB_KEYS.conversationsIndex ||
                                k.startsWith(IDB_KEYS.conversationPrefix) ||
                                k.startsWith(IDB_KEYS.conversationStatePrefix))
                        )
                            s.delete(k);
                        c.continue();
                    };
                });
            }
            await request(s.put(JSON.stringify(next), IDB_KEYS.meta));
            return {
                scope: all ? "all" : "conversations",
                previousEpoch: { dbEpoch: meta.dbEpoch, conversationEpoch: meta.conversationEpoch },
                epoch: { dbEpoch: next.dbEpoch, conversationEpoch: next.conversationEpoch },
                usageDirty: true,
            };
        });
    }
}
