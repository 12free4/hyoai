import { type Codec, StorageQuotaError } from "@/lib/storage/adapter";
import { indexedDBStorage as storage } from "@/lib/storage/backend";
import { cacheBootValue } from "@/lib/storage/bootCache";
import { identityCodec, lzCodec } from "@/lib/storage/codec";
import { emitStorageCommit } from "@/lib/storage/events";
import { canClearStorage, isPersistenceAllowed } from "@/lib/storage/gate";
import {
    type ConversationWriteContext,
    IndexedDBStorageError,
    type StorageSnapshot,
} from "@/lib/storage/indexeddbAdapter";
import { IDB_KEYS } from "@/lib/storage/indexeddbSchema";
import { invalidateUsage, recordSizes } from "@/lib/storage/usage";
import { createStore } from "@/lib/store";
import type { ConversationData, ConversationMeta } from "@/types/chat";
import { STORAGE_KEYS } from "@/types/storage";

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2000;
interface Pending {
    generation: number;
    prepare: () => () => Promise<void>;
    debounce: ReturnType<typeof setTimeout> | null;
    maxWait: ReturnType<typeof setTimeout> | null;
}
interface Draft {
    metadata: ConversationMeta;
    produce?: () => unknown | null;
}
export interface PersistenceProblem {
    key: string;
    code: string;
    message: string;
}
export const persistenceProblems = createStore<{ problems: PersistenceProblem[] }>({
    problems: [],
});
const pending = new Map<string, Pending>();
const activeEntries = new Map<string, Pending>();
export const storageOperationStore = createStore<{ clearing: "all" | "conversations" | null }>({
    clearing: null,
});
function affected(key: string, scope: "all" | "conversations"): boolean {
    return (
        scope === "all" ||
        key === STORAGE_KEYS.conversationsIndex ||
        key.startsWith(STORAGE_KEYS.conversationPrefix)
    );
}
function paused(key: string): boolean {
    const scope = storageOperationStore.getState().clearing;
    return scope !== null && affected(key, scope);
}
const generations = new Map<string, number>();
const revisions = new Map<string, number | null>();
const drafts = new Map<string, Draft>();
const deleted = new Set<string>();
const inFlight = new Map<string, number>();
const quotaCallbacks = new Set<(error: StorageQuotaError) => void>();
const callbacks = new Set<(id: string, removed: boolean) => void>();
let context: ConversationWriteContext | null = null;
let hydration: StorageSnapshot | null = null;
let tail: Promise<void> = Promise.resolve();

function ctx(): ConversationWriteContext {
    if (!context) throw new Error("Storage is not initialized");
    return context;
}
function validateSnapshot(snapshot: StorageSnapshot): void {
    const current = ctx();
    if (snapshot.dbEpoch !== current.dbEpoch)
        throw new IndexedDBStorageError(
            "STALE_DB_EPOCH",
            "Database was reset. Reload before saving.",
        );
    if (snapshot.conversationEpoch !== current.conversationEpoch)
        throw new IndexedDBStorageError(
            "STALE_CONVERSATION_EPOCH",
            "Conversations were reset. Reload before saving.",
        );
}
export async function beginStorageHydration(): Promise<void> {
    if (pending.size || inFlight.size || persistenceProblems.getState().problems.length)
        throw new Error("Unsaved changes exist. Reload explicitly before reinitializing storage.");
    // The index and revision records must come from one view, including newly added ids.
    for (let attempt = 0; attempt < 3; attempt++) {
        const states = await storage.keys(IDB_KEYS.conversationStatePrefix);
        const snapshot = await storage.readSnapshot([
            ...Object.values(STORAGE_KEYS).flatMap((key) => (typeof key === "string" ? [key] : [])),
            ...states,
        ]);
        const index = JSON.parse(
            snapshot.values.get(STORAGE_KEYS.conversationsIndex) ?? "[]",
        ) as ConversationMeta[];
        if (!Array.isArray(index)) throw new Error("Invalid conversation index");
        if (index.some((meta) => !snapshot.values.has(IDB_KEYS.conversationState(meta.id))))
            continue;
        context = { dbEpoch: snapshot.dbEpoch, conversationEpoch: snapshot.conversationEpoch };
        hydration = snapshot;
        revisions.clear();
        drafts.clear();
        deleted.clear();
        for (const meta of index) {
            const state = JSON.parse(
                snapshot.values.get(IDB_KEYS.conversationState(meta.id)) ?? "null",
            );
            if (
                !state ||
                state.deleted ||
                !Number.isSafeInteger(state.revision) ||
                state.revision < 1
            )
                throw new Error("Invalid conversation revision");
            revisions.set(meta.id, state.revision);
            drafts.set(meta.id, { metadata: meta });
        }
        return;
    }
    throw new Error("Database changed during initialization. Retry.");
}
export async function finishStorageHydration(): Promise<void> {
    validateSnapshot(await storage.readSnapshot([]));
    hydration = null;
}
export function cancelStorageHydration(): void {
    hydration = null;
}
export async function loadRaw(key: string): Promise<string | null> {
    if (hydration?.values.has(key)) return hydration.values.get(key) ?? null;
    return storage.get(key);
}
export async function loadJson<T>(key: string, codec: Codec = identityCodec): Promise<T | null> {
    const raw = await loadRaw(key);
    return raw === null ? null : (JSON.parse(codec.decode(raw)) as T);
}
function clearTimers(entry: Pending): void {
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.maxWait) clearTimeout(entry.maxWait);
    entry.debounce = entry.maxWait = null;
}
function generation(key: string): number {
    const next = (generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    return next;
}
function cancel(key: string): void {
    const entry = pending.get(key);
    if (entry) clearTimers(entry);
    pending.delete(key);
    generation(key);
}
function report(key: string, error: unknown): void {
    const code = error instanceof IndexedDBStorageError ? error.code : "DATABASE_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    persistenceProblems.setState((s) => ({
        problems: [...s.problems.filter((p) => p.key !== key), { key, code, message }],
    }));
    if (code === "QUOTA_EXCEEDED")
        for (const cb of quotaCallbacks) {
            try {
                cb(new StorageQuotaError(message, key));
            } catch {}
        }
}
function clearProblem(key: string): void {
    persistenceProblems.setState((s) => ({ problems: s.problems.filter((p) => p.key !== key) }));
}
function notify(id: string, removed: boolean): void {
    for (const cb of callbacks) {
        try {
            cb(id, removed);
        } catch {}
    }
}
export function onConversationChange(cb: (id: string, removed: boolean) => void): () => void {
    callbacks.add(cb);
    return () => {
        callbacks.delete(cb);
    };
}
export function onQuotaError(cb: (error: StorageQuotaError) => void): () => void {
    quotaCallbacks.add(cb);
    return () => {
        quotaCallbacks.delete(cb);
    };
}
function schedule(key: string, prepare: Pending["prepare"]): void {
    if (!isPersistenceAllowed(key) || paused(key)) return;
    const previous = pending.get(key);
    if (previous?.debounce) clearTimeout(previous.debounce);
    if (persistenceProblems.getState().problems.some((problem) => problem.key === key)) {
        if (previous) clearTimers(previous);
        pending.set(key, { generation: generation(key), prepare, debounce: null, maxWait: null });
        return;
    }
    const entry: Pending = {
        generation: generation(key),
        prepare,
        debounce: setTimeout(() => {
            void flushKey(key).catch(() => undefined);
        }, DEBOUNCE_MS),
        maxWait:
            previous?.maxWait ??
            setTimeout(() => {
                void flushKey(key).catch(() => undefined);
            }, MAX_WAIT_MS),
    };
    pending.set(key, entry);
}
function enqueue(key: string, entry: Pending): Promise<void> {
    let operation: () => Promise<void>;
    try {
        operation = entry.prepare();
    } catch (error) {
        pending.set(key, entry);
        report(key, error);
        return Promise.reject(error);
    }
    activeEntries.set(key, entry);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    const result = tail
        .then(async () => {
            if (!isPersistenceAllowed(key)) return;
            try {
                await operation();
                clearProblem(key);
            } catch (error) {
                if (generations.get(key) === entry.generation && !pending.has(key))
                    pending.set(key, entry);
                const newer = pending.get(key);
                if (newer) clearTimers(newer);
                report(key, error);
                throw error;
            }
        })
        .finally(() => {
            if (activeEntries.get(key) === entry) activeEntries.delete(key);
            const count = (inFlight.get(key) ?? 1) - 1;
            if (count) inFlight.set(key, count);
            else inFlight.delete(key);
        });
    tail = result.catch(() => undefined);
    return result;
}
export async function flushKey(key: string): Promise<void> {
    const entry = pending.get(key);
    if (!entry) {
        await tail;
        const problem = persistenceProblems.getState().problems.find((item) => item.key === key);
        if (problem) throw new Error(problem.message);
        return;
    }
    clearTimers(entry);
    pending.delete(key);
    await enqueue(key, entry);
}
export async function flushAll(): Promise<void> {
    const work = [...pending.keys()].map((key) => flushKey(key));
    const barrier = tail;
    const results = await Promise.allSettled(work);
    await barrier;
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (persistenceProblems.getState().problems.length)
        throw new Error("Some changes have not been saved");
}
export function scheduleJson(
    key: string,
    produce: () => unknown | null,
    codec: Codec = identityCodec,
): void {
    schedule(key, () => {
        const value = produce();
        const encoded = value === null ? null : codec.encode(JSON.stringify(value));
        const current = ctx();
        return async () => {
            if (encoded !== null) {
                await commitRaw(key, encoded, current);
                emitStorageCommit({ kind: "kv", key, dbEpoch: current.dbEpoch });
            }
        };
    });
}
export function scheduleRaw(key: string, produce: () => string): void {
    schedule(key, () => {
        const value = produce(),
            current = ctx();
        return async () => {
            await commitRaw(key, value, current);
            emitStorageCommit({ kind: "kv", key, dbEpoch: current.dbEpoch });
        };
    });
}
function immediately(key: string, prepare: Pending["prepare"]): Promise<void> {
    if (!isPersistenceAllowed(key) || paused(key)) return Promise.resolve();
    cancel(key);
    return enqueue(key, {
        generation: generations.get(key)!,
        prepare,
        debounce: null,
        maxWait: null,
    });
}
export function writeJsonNow(
    key: string,
    value: unknown,
    codec: Codec = identityCodec,
): Promise<void> {
    return immediately(key, () => {
        const encoded = codec.encode(JSON.stringify(value)),
            current = ctx();
        return async () => {
            await commitRaw(key, encoded, current);
            emitStorageCommit({ kind: "kv", key, dbEpoch: current.dbEpoch });
        };
    });
}
export function removeKey(key: string): Promise<void> {
    return immediately(key, () => {
        const current = ctx();
        return async () => {
            const receipt = await storage.remove(key, current);
            if (receipt) recordSizes([receipt]);
            if (key === STORAGE_KEYS.settings) cacheBootValue("skin", null);
            if (key === STORAGE_KEYS.locale) cacheBootValue("locale", null);
            emitStorageCommit({ kind: "kv", key, dbEpoch: current.dbEpoch });
        };
    });
}
export function isConversationDirty(id: string): boolean {
    const key = STORAGE_KEYS.conversation(id);
    return pending.has(key) || inFlight.has(key);
}
export function stageConversationMeta(metadata: ConversationMeta): void {
    if (deleted.has(metadata.id) || !isPersistenceAllowed(STORAGE_KEYS.conversation(metadata.id)))
        return;
    const previous = drafts.get(metadata.id);
    drafts.set(metadata.id, { ...previous, metadata });
    scheduleConversation(metadata.id);
}
function prepareConversation(id: string): () => Promise<void> {
    const draft = drafts.get(id);
    if (!draft) throw new Error("Missing conversation metadata");
    const metadata = { ...draft.metadata },
        data = draft.produce?.();
    const value = data == null ? undefined : lzCodec.encode(JSON.stringify(data));
    const current = ctx();
    return async () => {
        if (deleted.has(id)) return;
        const expectedRevision = revisions.get(id) ?? null;
        if (expectedRevision === null && value === undefined)
            throw new Error("New conversation has no body");
        const receipt = await storage.commitConversation(
            expectedRevision === null
                ? {
                      kind: "create",
                      id,
                      expectedRevision: null,
                      metadata,
                      value: value!,
                      context: current,
                  }
                : { kind: "update", id, expectedRevision, metadata, value, context: current },
        );
        recordSizes(receipt.changes ?? []);
        revisions.set(id, receipt.revision);
        notify(id, false);
        emitStorageCommit({
            kind: "conversation",
            id,
            revision: receipt.revision,
            deleted: false,
            epoch: current,
        });
    };
}
function scheduleConversation(id: string): void {
    if (!deleted.has(id)) schedule(STORAGE_KEYS.conversation(id), () => prepareConversation(id));
}
export function scheduleConversationWrite(id: string, produce: () => unknown | null): void {
    if (deleted.has(id) || !isPersistenceAllowed(STORAGE_KEYS.conversation(id))) return;
    const draft = drafts.get(id);
    if (!draft) return;
    draft.produce = produce;
    scheduleConversation(id);
}
export function writeConversationNow(id: string, value: unknown): Promise<void> {
    if (deleted.has(id)) return Promise.resolve();
    const draft = drafts.get(id);
    if (draft) draft.produce = () => value;
    return immediately(STORAGE_KEYS.conversation(id), () => prepareConversation(id));
}
export async function readConversation(id: string): Promise<unknown | null> {
    const key = STORAGE_KEYS.conversation(id),
        stateKey = IDB_KEYS.conversationState(id);
    const snapshot = await storage.readSnapshot([key, stateKey]);
    validateSnapshot(snapshot);
    const raw = snapshot.values.get(key),
        stateRaw = snapshot.values.get(stateKey);
    if (!raw || !stateRaw) return null;
    const state = JSON.parse(stateRaw) as { revision: number; deleted: boolean };
    if (state.deleted) return null;
    // Reading for search/export must not silently upgrade a dirty editor's revision.

    return JSON.parse(lzCodec.decode(raw));
}
export async function deleteConversation(id: string): Promise<void> {
    const key = STORAGE_KEYS.conversation(id);
    if (!isPersistenceAllowed(key)) return;
    deleted.add(id);
    await immediately(key, () => {
        const current = ctx();
        return async () => {
            const expectedRevision = revisions.get(id);
            if (expectedRevision != null)
                recordSizes(
                    (await storage.deleteConversation({ id, expectedRevision, context: current }))
                        ?.changes ?? [],
                );
            drafts.delete(id);
            notify(id, true);
            if (expectedRevision != null)
                emitStorageCommit({
                    kind: "conversation",
                    id,
                    revision: expectedRevision + 1,
                    deleted: true,
                    epoch: current,
                });
        };
    });
}
export async function createImportedConversation(
    metadata: ConversationMeta,
    data: ConversationData,
    override?: ConversationWriteContext,
): Promise<void> {
    const key = STORAGE_KEYS.conversation(metadata.id);
    if (!isPersistenceAllowed(key) || paused(key)) throw new Error("Persistence is disabled");
    if (deleted.has(metadata.id))
        throw new IndexedDBStorageError("ID_COLLISION", "Conversation id was retired in this tab");
    const value = lzCodec.encode(JSON.stringify(data));
    try {
        await immediately(key, () => {
            const current = override ?? ctx();
            return async () => {
                const receipt = await storage.commitConversation({
                    kind: "create",
                    id: metadata.id,
                    expectedRevision: null,
                    metadata,
                    value,
                    context: current,
                });
                recordSizes(receipt.changes ?? []);
                revisions.set(metadata.id, receipt.revision);
                drafts.set(metadata.id, { metadata, produce: () => data });
                notify(metadata.id, false);
                emitStorageCommit({
                    kind: "conversation",
                    id: metadata.id,
                    revision: receipt.revision,
                    deleted: false,
                    epoch: {
                        dbEpoch: current.dbEpoch,
                        conversationEpoch: current.conversationEpoch,
                    },
                });
            };
        });
    } catch (error) {
        if (error instanceof IndexedDBStorageError && error.code === "ID_COLLISION") {
            cancel(key);
            clearProblem(key);
        }
        throw error;
    }
}
export async function saveConflictCopy(id: string): Promise<void> {
    const draft = drafts.get(id);
    if (!draft) throw new Error("No local conversation metadata is available");
    // This explicit user action may save into a new epoch. It never upgrades the
    // original editor's context or retries its conflicting write automatically.
    const snapshot = await storage.readSnapshot([
        STORAGE_KEYS.conversation(id),
        IDB_KEYS.conversationState(id),
    ]);
    const raw = snapshot.values.get(STORAGE_KEYS.conversation(id));
    const value = draft.produce?.() ?? (raw ? JSON.parse(lzCodec.decode(raw)) : null);
    if (!value) throw new Error("No conversation body is available to copy");
    const copyId = crypto.randomUUID();
    const data = { ...(value as ConversationData), id: copyId };
    await createImportedConversation({ ...draft.metadata, id: copyId }, data, snapshot);
    cancel(STORAGE_KEYS.conversation(id));
}
export async function listConversationIds(): Promise<string[]> {
    return (await storage.keys(STORAGE_KEYS.conversationPrefix)).map((key) =>
        key.slice(STORAGE_KEYS.conversationPrefix.length),
    );
}
// Usage accounting is isolated from business persistence.
export { estimateUsage } from "@/lib/storage/usage";
let lifecycleCleanup: (() => void) | null = null;
export function registerLifecycleFlush(): () => void {
    if (typeof window === "undefined") return () => {};
    if (lifecycleCleanup) return lifecycleCleanup;
    const flush = () => {
        void flushAll().catch(() => undefined);
    };
    const hidden = () => {
        if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("freeze", flush);
    window.addEventListener("pagehide", flush);
    lifecycleCleanup = () => {
        document.removeEventListener("visibilitychange", hidden);
        document.removeEventListener("freeze", flush);
        window.removeEventListener("pagehide", flush);
        lifecycleCleanup = null;
    };
    return lifecycleCleanup;
}

export async function readConversationForEditor(id: string) {
    const snapshot = await storage.readSnapshot([
        STORAGE_KEYS.conversation(id),
        IDB_KEYS.conversationState(id),
        STORAGE_KEYS.conversationsIndex,
    ]);
    validateSnapshot(snapshot);
    const raw = snapshot.values.get(STORAGE_KEYS.conversation(id));
    const state = JSON.parse(snapshot.values.get(IDB_KEYS.conversationState(id)) ?? "null") as {
        revision: number;
        deleted: boolean;
    } | null;
    const index = JSON.parse(
        snapshot.values.get(STORAGE_KEYS.conversationsIndex) ?? "[]",
    ) as ConversationMeta[];
    const metadata = index.find((meta) => meta.id === id);
    if (!raw || !state || state.deleted || !metadata) return null;
    if (!Number.isSafeInteger(state.revision) || state.revision < 1)
        throw new Error("Invalid conversation revision");
    const data = JSON.parse(lzCodec.decode(raw)) as ConversationData;
    if (!data || data.id !== id || !data.rootId || !data.nodes || !data.nodes[data.rootId])
        throw new Error("Invalid conversation body");
    return {
        snapshot,
        revision: state.revision,
        metadata,
        data,
    };
}
export function acceptConversationRead(
    id: string,
    read: NonNullable<Awaited<ReturnType<typeof readConversationForEditor>>>,
): boolean {
    validateSnapshot(read.snapshot);
    if (isConversationDirty(id) || deleted.has(id)) return false;
    const currentRevision = revisions.get(id);
    if (currentRevision != null && read.revision < currentRevision) return false;
    revisions.set(id, read.revision);
    drafts.set(id, { metadata: read.metadata, produce: () => read.data });
    return true;
}

/** The caller stops every runtime while new writes are suspended, outside any IDB transaction. */
export async function clearStorage(
    scope: "all" | "conversations",
    stopWriters: () => readonly string[] | void,
): Promise<void> {
    if (!canClearStorage(scope)) throw new Error("This embed cannot clear the requested data");
    if (storageOperationStore.getState().clearing)
        throw new Error("A clear operation is already running");
    const previousDeleted = new Set(deleted);
    const retained = new Map<string, Pending>();
    for (const [key, entry] of [...activeEntries, ...pending])
        if (affected(key, scope)) retained.set(key, entry);
    storageOperationStore.setState({ clearing: scope });
    let succeeded = false;
    try {
        const retiringIds = stopWriters();
        if (retiringIds) for (const id of retiringIds) deleted.add(id);
        for (const id of drafts.keys()) deleted.add(id);
        for (const [key, entry] of pending)
            if (affected(key, scope)) {
                retained.set(key, entry);
                cancel(key);
            }
        // Already submitted operations finish before the clear; new writes are suspended.
        await tail;
        const receipt =
            scope === "all"
                ? await storage.clearAll(ctx())
                : await storage.clearConversations(ctx());
        const ids = [...drafts.keys()];
        for (const key of pending.keys()) if (affected(key, scope)) cancel(key);
        invalidateUsage();
        context = receipt.epoch;
        hydration = null;
        revisions.clear();
        drafts.clear();
        persistenceProblems.setState((s) => ({
            problems: s.problems.filter((problem) => !affected(problem.key, scope)),
        }));
        for (const id of ids) notify(id, true);
        emitStorageCommit({ kind: "reset", scope, epoch: receipt.epoch });
        succeeded = true;
    } finally {
        if (!succeeded) {
            deleted.clear();
            for (const id of previousDeleted) deleted.add(id);
            for (const [key, entry] of retained) {
                clearTimers(entry);
                entry.generation = generation(key);
                pending.set(key, entry);
            }
        }
        // All-data clear stays suspended until the caller reloads the empty database.
        if (!succeeded || scope === "conversations")
            storageOperationStore.setState({ clearing: null });
    }
}

export interface Reconciliation {
    index: ConversationMeta[];
    changed: string[];
    removed: string[];
    resetConversations: boolean;
    blocked: boolean;
    retry: boolean;
}
export interface LiveStorageState {
    liveIds: Set<string>;
    busyIds: Set<string>;
}
/** Re-read authoritative metadata; never advance the revision of an active editor here. */
export async function reconcileConversations(
    liveState: () => LiveStorageState,
): Promise<Reconciliation | null> {
    if (!context || hydration || storageOperationStore.getState().clearing) return null;
    const initial = context;
    const before = new Map(revisions);
    let snapshot: StorageSnapshot | null = null;
    let remote: ConversationMeta[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const stateKeys = await storage.keys(IDB_KEYS.conversationStatePrefix);
        const candidate = await storage.readSnapshot([
            STORAGE_KEYS.conversationsIndex,
            ...stateKeys,
        ]);
        remote = JSON.parse(
            candidate.values.get(STORAGE_KEYS.conversationsIndex) ?? "[]",
        ) as ConversationMeta[];
        if (!Array.isArray(remote)) throw new Error("Invalid conversation index");
        if (remote.some((meta) => !candidate.values.has(IDB_KEYS.conversationState(meta.id))))
            continue;
        snapshot = candidate;
        break;
    }
    if (!snapshot) throw new Error("Conversation index changed repeatedly or is invalid");
    if (context !== initial || storageOperationStore.getState().clearing) return null;
    const { liveIds, busyIds } = liveState();
    const known = new Set([...drafts.keys(), ...revisions.keys(), ...liveIds]);
    const protectedIds = new Set(
        [...known].filter((id) => isConversationDirty(id) || busyIds.has(id)),
    );
    const dbChanged = snapshot.dbEpoch !== initial.dbEpoch;
    const conversationsChanged = snapshot.conversationEpoch !== initial.conversationEpoch;
    const result: Reconciliation = {
        index: remote,
        changed: [],
        removed: [],
        resetConversations: false,
        blocked: false,
        retry: false,
    };
    if (dbChanged || conversationsChanged) {
        const code = dbChanged ? "STALE_DB_EPOCH" : "STALE_CONVERSATION_EPOCH";
        if (dbChanged || protectedIds.size) {
            const fault = new IndexedDBStorageError(
                code,
                dbChanged
                    ? "All data was cleared in another tab. Reload before saving."
                    : "Conversations were cleared in another tab. Keep a copy or reload.",
            );
            for (const id of protectedIds) {
                const key = STORAGE_KEYS.conversation(id);
                const entry = pending.get(key);
                if (entry) clearTimers(entry);
                report(key, fault);
            }
            if (dbChanged || !protectedIds.size) report(STORAGE_KEYS.meta, fault);
            result.index = [...drafts.values()].map((d) => d.metadata);
            result.blocked = true;
            return result;
        }
        // A conversation-only reset must not invalidate ordinary preference writes.
        context = { dbEpoch: initial.dbEpoch, conversationEpoch: snapshot.conversationEpoch };
        for (const id of known) {
            deleted.add(id);
            notify(id, true);
        }
        revisions.clear();
        drafts.clear();
        result.resetConversations = true;
        result.removed = [...known];
    }
    const merged = new Map(remote.map((meta) => [meta.id, meta]));
    for (const id of new Set([...known, ...remote.map((meta) => meta.id)])) {
        const raw = snapshot.values.get(IDB_KEYS.conversationState(id));
        const state = raw ? (JSON.parse(raw) as { revision: number; deleted: boolean }) : null;
        const metadata = merged.get(id);
        if (
            state &&
            (!Number.isSafeInteger(state.revision) ||
                state.revision < 1 ||
                typeof state.deleted !== "boolean")
        )
            throw new Error("Invalid conversation revision");
        if (metadata && (!state || state.deleted))
            throw new Error("Conversation index and state disagree");
        const revision = revisions.get(id);
        if (!result.resetConversations && before.get(id) !== revision) {
            const local = drafts.get(id);
            if (local) merged.set(id, local.metadata);
            result.retry = true;
            continue;
        }
        const removed = !metadata || !state || state.deleted;
        const changed = removed ? revision != null : revision !== state.revision;
        if (protectedIds.has(id)) {
            const local = drafts.get(id);
            if (local) merged.set(id, local.metadata);
            if (changed) {
                const key = STORAGE_KEYS.conversation(id);
                const entry = pending.get(key);
                if (entry) clearTimers(entry);
                report(
                    key,
                    new IndexedDBStorageError(
                        "REVISION_CONFLICT",
                        "Conversation changed in another tab. Keep a copy or reload.",
                    ),
                );
            }
            continue;
        }
        if (!changed && !result.resetConversations) continue;
        notify(id, removed);
        if (removed) {
            deleted.add(id);
            drafts.delete(id);
            revisions.delete(id);
            result.removed.push(id);
        } else {
            if (liveIds.has(id)) result.changed.push(id);
            else {
                revisions.set(id, state.revision);
                drafts.set(id, { metadata });
            }
        }
    }
    result.index = [...merged.values()];
    return result;
}

async function commitRaw(
    key: string,
    value: string,
    current: ConversationWriteContext,
): Promise<void> {
    const receipt = await storage.set(key, value, current);
    if (receipt) recordSizes([receipt]);
    if (key === STORAGE_KEYS.locale) cacheBootValue("locale", value);
    if (key === STORAGE_KEYS.settings) {
        const settings = JSON.parse(value);
        if (typeof settings.skin === "string") cacheBootValue("skin", settings.skin);
    }
}
export function writeRawNow(key: string, value: string): Promise<void> {
    return immediately(key, () => {
        const current = ctx();
        return async () => {
            await commitRaw(key, value, current);
            emitStorageCommit({ kind: "kv", key, dbEpoch: current.dbEpoch });
        };
    });
}
