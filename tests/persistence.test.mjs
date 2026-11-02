import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRequire = createRequire(import.meta.url);
const defer = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const meta = (id) => ({ id, title: id, pinned: false, createdAt: 1, lastModified: 1 });
const body = (id) => ({
    id,
    rootId: "root",
    currNode: "root",
    nodes: {
        root: { id: "root", role: "root", content: "", parent: null, children: [], createdAt: 1 },
    },
});

function harness() {
    const cache = new Map();
    const overrides = new Map();
    const values = new Map();
    const log = [];
    let epochs = { dbEpoch: "db-1", conversationEpoch: "conversations-1" };
    const backend = {
        beforeSet: null,
        beforeCommit: null,
        beforeClear: null,
        async clearConversations(context) {
            if (this.beforeClear) await this.beforeClear();
            check(context, true);
            for (const key of values.keys())
                if (key.startsWith("conversation:") || key.startsWith("conversation-state:"))
                    values.delete(key);
            values.set("conversations:index", "[]");
            epochs = { ...epochs, conversationEpoch: epochs.conversationEpoch + "-reset" };
            log.push(["clear", "conversations"]);
            return { epoch: { ...epochs } };
        },
        async clearAll(context) {
            if (this.beforeClear) await this.beforeClear();
            check(context);
            values.clear();
            epochs = {
                dbEpoch: epochs.dbEpoch + "-reset",
                conversationEpoch: epochs.conversationEpoch + "-reset",
            };
            log.push(["clear", "all"]);
            return { epoch: { ...epochs } };
        },
        async keys(prefix) {
            return [...values.keys()].filter((key) => key.startsWith(prefix));
        },
        async get(key) {
            return values.get(key) ?? null;
        },
        async readSnapshot(keys) {
            return {
                ...epochs,
                values: new Map(keys.map((key) => [key, values.get(key) ?? null])),
            };
        },
        async set(key, value, context) {
            if (this.beforeSet) await this.beforeSet();
            check(context);
            values.set(key, value);
            log.push(["set", key, value]);
        },
        async remove(key, context) {
            check(context);
            values.delete(key);
            log.push(["remove", key]);
        },
        async commitConversation(input) {
            if (this.beforeCommit) await this.beforeCommit();
            check(input.context, true);
            const key = "conversation:" + input.id,
                stateKey = "conversation-state:" + input.id;
            const previous = JSON.parse(values.get(stateKey) ?? "null");
            if (input.kind === "create" && previous) throw fault("ID_COLLISION");
            if (
                input.kind === "update" &&
                (!previous || previous.deleted || previous.revision !== input.expectedRevision)
            )
                throw fault("REVISION_CONFLICT");
            const revision = (previous?.revision ?? 0) + 1;
            values.set(stateKey, JSON.stringify({ revision, deleted: false }));
            if (input.value !== undefined) values.set(key, input.value);
            const index = JSON.parse(values.get("conversations:index") ?? "[]");
            const existing = index.find((m) => m.id === input.id);
            values.set(
                "conversations:index",
                JSON.stringify([
                    ...index.filter((m) => m.id !== input.id),
                    { ...existing, ...input.metadata, id: input.id },
                ]),
            );
            log.push(["commit", input.id, revision]);
            return { revision };
        },
        async deleteConversation(input) {
            check(input.context, true);
            const key = "conversation-state:" + input.id;
            const old = JSON.parse(values.get(key) ?? "null");
            if (!old || old.deleted || old.revision !== input.expectedRevision)
                throw fault("REVISION_CONFLICT");
            values.set(key, JSON.stringify({ revision: old.revision + 1, deleted: true }));
            values.delete("conversation:" + input.id);
            log.push(["delete", input.id]);
        },
    };
    function load(name) {
        if (overrides.has(name)) return overrides.get(name);
        if (name === "@/lib/storage/backend") return { indexedDBStorage: backend };
        if (!name.startsWith("@/")) return nativeRequire(name);
        if (cache.has(name)) return cache.get(name).exports;
        const filename = path.join(root, name.slice(2) + ".ts");
        const source = fs.readFileSync(filename, "utf8");
        const output = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        const loadedModule = { exports: {} };
        cache.set(name, loadedModule);
        new Function("require", "module", "exports", output)(
            load,
            loadedModule,
            loadedModule.exports,
        );
        return loadedModule.exports;
    }
    function fault(code) {
        const { IndexedDBStorageError } = load("@/lib/storage/indexeddbAdapter");
        return new IndexedDBStorageError(code, code);
    }
    function check(context, conversation = false) {
        if (context.dbEpoch !== epochs.dbEpoch) throw fault("STALE_DB_EPOCH");
        if (conversation && context.conversationEpoch !== epochs.conversationEpoch)
            throw fault("STALE_CONVERSATION_EPOCH");
    }
    const p = load("@/lib/storage/persistence");
    return {
        p,
        overrides,
        backend,
        values,
        log,
        load,
        fault,
        reset: () => {
            epochs = { dbEpoch: "db-2", conversationEpoch: "conversations-2" };
        },
        async init() {
            await p.beginStorageHydration();
            await p.finishStorageHydration();
        },
    };
}

test("hydration uses one frozen view and rejects a reset before completion", async () => {
    const h = harness();
    h.values.set("settings", '{"skin":"flat"}');
    h.values.set("locale", "zh");
    await h.p.beginStorageHydration();
    h.values.set("locale", "en");
    h.values.set("settings", '{"skin":"soft"}');
    assert.equal(await h.p.loadRaw("locale"), "zh");
    assert.equal((await h.p.loadJson("settings")).skin, "flat");
    h.reset();
    await assert.rejects(h.p.finishStorageHydration(), { code: "STALE_DB_EPOCH" });
});
test("flush barrier waits for in-flight writes; direct writes retain submission order", async () => {
    const h = harness();
    await h.init();
    const entered = defer(),
        release = defer();
    h.backend.beforeSet = async () => {
        entered.resolve();
        await release.promise;
    };
    const first = h.p.writeJsonNow("settings", { value: 1 });
    await entered.promise;
    const second = h.p.writeJsonNow("settings", { value: 2 });
    let flushed = false;
    const barrier = h.p.flushAll().then(() => {
        flushed = true;
    });
    await Promise.resolve();
    assert.equal(flushed, false);
    release.resolve();
    await Promise.all([first, second, barrier]);
    assert.equal(JSON.parse(h.values.get("settings")).value, 2);
});
test("debounce coalesces producers and flush reads the latest value", async () => {
    const h = harness();
    await h.init();
    let value = 1;
    h.p.scheduleJson("settings", () => ({ value }));
    value = 2;
    h.p.scheduleJson("settings", () => ({ value }));
    await h.p.flushAll();
    assert.equal(h.log.filter((x) => x[0] === "set").length, 1);
    assert.equal(JSON.parse(h.values.get("settings")).value, 2);
});
test("quota failure remains dirty and succeeds on explicit retry", async () => {
    const h = harness();
    await h.init();
    h.backend.beforeSet = () => {
        throw h.fault("QUOTA_EXCEEDED");
    };
    h.p.scheduleJson("settings", () => ({ value: 1 }));
    await assert.rejects(h.p.flushAll(), { code: "QUOTA_EXCEEDED" });
    assert.equal(h.p.persistenceProblems.getState().problems[0].code, "QUOTA_EXCEEDED");
    h.backend.beforeSet = null;
    await h.p.flushAll();
    assert.equal(h.p.persistenceProblems.getState().problems.length, 0);
});
test("delete waits for an already submitting create and rejects later local snapshots", async () => {
    const h = harness();
    await h.init();
    const entered = defer(),
        release = defer();
    h.backend.beforeCommit = async () => {
        entered.resolve();
        await release.promise;
    };
    h.p.stageConversationMeta(meta("a"));
    h.p.scheduleConversationWrite("a", () => body("a"));
    const save = h.p.flushKey("conversation:a");
    await entered.promise;
    const remove = h.p.deleteConversation("a");
    h.p.scheduleConversationWrite("a", () => body("a"));
    release.resolve();
    await Promise.all([save, remove]);
    await h.p.flushAll();
    assert.equal(h.values.has("conversation:a"), false);
    assert.deepEqual(
        h.log.map((x) => x[0]),
        ["commit", "delete"],
    );
});
test("search reads do not adopt a remote revision and bypass editor conflict checks", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    h.values.set("conversation-state:a", JSON.stringify({ revision: 2, deleted: false }));
    await h.p.readConversation("a");
    h.p.scheduleConversationWrite("a", () => body("a"));
    await assert.rejects(h.p.flushAll(), { code: "REVISION_CONFLICT" });
});
test("import retries only ID_COLLISION; tombstoned id is remapped", async () => {
    const h = harness();
    await h.init();
    h.values.set("conversation-state:a", JSON.stringify({ revision: 2, deleted: true }));
    const transfer = h.load("@/lib/transfer");
    const imported = { ...meta("a"), ...body("a") };
    const result = await transfer.applyImport({
        format: "hyoai-export",
        version: 1,
        exportedAt: 0,
        conversations: [imported],
    });
    assert.equal(result.conversations, 1);
    assert.equal(h.values.has("conversation:a"), false);
    assert.equal(h.log.filter((x) => x[0] === "commit").length, 1);
    h.reset();
    await assert.rejects(
        transfer.applyImport({
            format: "hyoai-export",
            version: 1,
            exportedAt: 0,
            conversations: [{ ...meta("b"), ...body("b") }],
        }),
        { code: "STALE_DB_EPOCH" },
    );
    assert.equal(h.log.filter((x) => x[0] === "commit").length, 1);
});
test("embed gate prevents preference and conversation writes", async () => {
    const h = harness();
    await h.init();
    h.load("@/lib/storage/gate").setPersistenceGate(() => false);
    h.p.scheduleJson("settings", () => ({}));
    h.p.stageConversationMeta(meta("a"));
    h.p.scheduleConversationWrite("a", () => body("a"));
    await h.p.writeJsonNow("settings", {});
    await h.p.flushAll();
    assert.equal(h.log.length, 0);
});

test("max-wait commits during continuous scheduling", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    await h.init();
    let value = 0;
    for (let i = 0; i < 5; i++) {
        value = i;
        h.p.scheduleJson("settings", () => ({ value }));
        t.mock.timers.tick(400);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.log.filter((entry) => entry[0] === "set").length, 1);
    assert.equal(JSON.parse(h.values.get("settings")).value, 4);
    await h.p.flushAll();
});
test("serialization failure is retained for explicit retry", async () => {
    const h = harness();
    await h.init();
    let broken = true;
    h.p.scheduleJson("settings", () => {
        if (broken) throw new Error("serialization failed");
        return { ok: true };
    });
    await assert.rejects(h.p.flushAll(), /serialization failed/);
    broken = false;
    await h.p.flushAll();
    assert.equal(h.values.get("settings"), '{"ok":true}');
});
test("late editor read cannot overwrite a switched view", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    const { createStore } = h.load("@/lib/store");
    h.overrides.set("@/lib/conversation", {
        createConversation: () => ({ meta: meta("new"), data: body("new") }),
    });
    h.overrides.set("@/lib/stores/models", {
        modelsStore: createStore({ entries: [] }),
        setActiveModel: () => {},
    });
    const lifecycle = h.load("@/lib/chat/lifecycle");
    const { createChatStore } = h.load("@/lib/stores/chat");
    const store = createChatStore();
    store.setState({ conversationId: "a", ...body("a") });
    const read = h.backend.readSnapshot.bind(h.backend),
        entered = defer(),
        release = defer();
    h.backend.readSnapshot = async (keys) => {
        const snapshot = await read(keys);
        if (keys.includes("conversation:a")) {
            entered.resolve();
            await release.promise;
        }
        return snapshot;
    };
    const ctx = {
        store,
        selection: createStore({}),
        followGlobalModel: false,
        syncUrlMaybe: () => {},
        stopGeneration: () => {},
        isChunking: () => false,
    };
    const reload = lifecycle.reloadConversation(ctx, "a");
    await entered.promise;
    store.setState({ conversationId: "b", nodes: {} });
    release.resolve();
    await reload;
    assert.equal(store.getState().conversationId, "b");
    assert.deepEqual(store.getState().nodes, {});
});
test("late snapshot from an older adopted database epoch is rejected", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    const read = h.backend.readSnapshot.bind(h.backend),
        entered = defer(),
        release = defer();
    h.backend.readSnapshot = async (keys) => {
        const snapshot = await read(keys);
        if (keys.includes("conversation:a")) {
            entered.resolve();
            await release.promise;
        }
        return snapshot;
    };
    const pendingRead = h.p.readConversationForEditor("a");
    await entered.promise;
    h.reset();
    await h.p.beginStorageHydration();
    await h.p.finishStorageHydration();
    release.resolve();
    await assert.rejects(pendingRead, { code: "STALE_DB_EPOCH" });
});

test("failed older write cannot replace newer queued content", async () => {
    const h = harness();
    await h.init();
    const entered = defer(),
        release = defer();
    h.backend.beforeSet = async () => {
        entered.resolve();
        await release.promise;
        throw h.fault("QUOTA_EXCEEDED");
    };
    const old = h.p.writeJsonNow("settings", { value: "old" });
    await entered.promise;
    h.p.scheduleJson("settings", () => ({ value: "new" }));
    release.resolve();
    await assert.rejects(old, { code: "QUOTA_EXCEEDED" });
    h.backend.beforeSet = null;
    await h.p.flushAll();
    assert.equal(JSON.parse(h.values.get("settings")).value, "new");
});
test("conflicting streaming changes stay dirty without automatic retry timers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    let attempts = 0;
    h.backend.beforeCommit = () => {
        attempts++;
        throw h.fault("REVISION_CONFLICT");
    };
    h.p.scheduleConversationWrite("a", () => body("a"));
    await assert.rejects(h.p.flushAll(), { code: "REVISION_CONFLICT" });
    h.p.scheduleConversationWrite("a", () => body("a"));
    t.mock.timers.tick(3000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(h.p.isConversationDirty("a"), true);
});

test("clear waits for submitting writes, keeps preferences and rejects late conversation writes", async () => {
    const h = harness();
    await h.init();
    const events = [];
    h.load("@/lib/storage/events").onStorageCommit((e) => events.push(e));
    const entered = defer(),
        release = defer();
    h.backend.beforeCommit = async () => {
        entered.resolve();
        await release.promise;
    };
    h.p.stageConversationMeta(meta("a"));
    h.p.scheduleConversationWrite("a", () => body("a"));
    const save = h.p.flushAll();
    await entered.promise;
    let stopped = false;
    const clear = h.p.clearStorage("conversations", () => {
        stopped = true;
    });
    assert.equal(stopped, true);
    assert.equal(h.log.length, 0);
    const settings = h.p.writeJsonNow("settings", { value: 1 });
    release.resolve();
    await Promise.all([save, clear, settings]);
    h.p.scheduleConversationWrite("a", () => body("a"));
    await h.p.flushAll();
    assert.equal(h.values.has("conversation:a"), false);
    assert.equal(JSON.parse(h.values.get("settings")).value, 1);
    assert.equal(events.filter((e) => e.kind === "reset").length, 1);
    assert.equal(h.p.storageOperationStore.getState().clearing, null);
});

test("failed clear restores pending content and never broadcasts a reset", async () => {
    const h = harness();
    await h.init();
    h.p.stageConversationMeta(meta("a"));
    h.p.scheduleConversationWrite("a", () => body("a"));
    const events = [];
    h.load("@/lib/storage/events").onStorageCommit((e) => events.push(e));
    h.backend.beforeClear = async () => {
        throw h.fault("DATABASE_ERROR");
    };
    await assert.rejects(
        h.p.clearStorage("conversations", () => {}),
        { code: "DATABASE_ERROR" },
    );
    assert.equal(events.length, 0);
    assert.equal(h.p.isConversationDirty("a"), true);
    await h.p.flushAll();
    assert.equal(h.values.has("conversation:a"), true);
});

test("sidebar may clear conversations only; minimal embed cannot clear", async () => {
    const h = harness();
    await h.init();
    const gate = h.load("@/lib/storage/gate");
    gate.setPersistenceGate(
        (key) => key === "conversations:index" || key.startsWith("conversation:"),
    );
    let stopped = 0;
    await assert.rejects(
        h.p.clearStorage("all", () => {
            stopped++;
        }),
    );
    assert.equal(stopped, 0);
    await h.p.clearStorage("conversations", () => {
        stopped++;
    });
    assert.equal(stopped, 1);
    gate.setPersistenceGate(() => false);
    await assert.rejects(
        h.p.clearStorage("conversations", () => {
            stopped++;
        }),
    );
    assert.equal(stopped, 1);
});

const idle = () => ({ liveIds: new Set(), busyIds: new Set() });
test("remote conversation reset adopts only conversation epoch and preserves pending settings", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    h.p.scheduleJson("settings", () => ({ value: 2 }));
    await h.backend.clearConversations(await h.backend.readSnapshot([]));
    const result = await h.p.reconcileConversations(idle);
    assert.equal(result.resetConversations, true);
    assert.deepEqual(result.index, []);
    await h.p.flushAll();
    assert.equal(JSON.parse(h.values.get("settings")).value, 2);
    await h.p.createImportedConversation(meta("b"), body("b"));
});

test("remote reset preserves dirty drafts and leaves preference writes enabled", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    h.p.scheduleConversationWrite("a", () => body("a"));
    await h.backend.clearConversations(await h.backend.readSnapshot([]));
    const result = await h.p.reconcileConversations(idle);
    assert.equal(result.blocked, true);
    assert.equal(result.index[0].id, "a");
    assert.equal(h.p.persistenceProblems.getState().problems[0].code, "STALE_CONVERSATION_EPOCH");
    await h.p.writeJsonNow("settings", { value: 3 });
    await assert.rejects(h.p.flushAll(), { code: "STALE_CONVERSATION_EPOCH" });
    assert.equal(JSON.parse(h.values.get("settings")).value, 3);
});

test("remote database reset never upgrades old page write context", async () => {
    const h = harness();
    await h.init();
    h.reset();
    assert.equal((await h.p.reconcileConversations(idle)).blocked, true);
    await assert.rejects(h.p.writeJsonNow("settings", { value: 4 }), { code: "STALE_DB_EPOCH" });
});

test("remote revision refresh protects busy editors and does not rebroadcast", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    const events = [];
    h.load("@/lib/storage/events").onStorageCommit((e) => events.push(e));
    h.values.set("conversation-state:a", JSON.stringify({ revision: 2, deleted: false }));
    const result = await h.p.reconcileConversations(() => ({
        liveIds: new Set(["a"]),
        busyIds: new Set(["a"]),
    }));
    assert.deepEqual(result.changed, []);
    assert.equal(h.p.persistenceProblems.getState().problems[0].code, "REVISION_CONFLICT");
    assert.equal(events.length, 0);
});

test("sync buffers boot hints, deduplicates messages and never echoes remote changes", async () => {
    const h = harness();
    const { createStorageSync } = h.load("@/lib/storage/sync");
    const posted = [];
    const channel = { postMessage: (m) => posted.push(m), close() {} };
    let reads = 0;
    const sync = createStorageSync({
        channelFactory: () => channel,
        reconcile: async () => {
            reads++;
        },
        onError: (e) => {
            throw e;
        },
    });
    const message = {
        version: 1,
        sender: "remote",
        sequence: 1,
        change: { kind: "kv", key: "settings", dbEpoch: "db-1" },
    };
    channel.onmessage({ data: message });
    assert.equal(reads, 0);
    await sync.activate();
    assert.equal(reads, 1);
    assert.equal(posted.length, 0);
    channel.onmessage({ data: message });
    h.load("@/lib/storage/events").emitStorageCommit(message.change);
    assert.equal(posted.length, 1);
    sync.dispose();
    h.load("@/lib/storage/events").emitStorageCommit(message.change);
    assert.equal(posted.length, 1);
});

test("sync works without BroadcastChannel and reports reconciliation failures", async () => {
    const h = harness();
    let errors = 0;
    const sync = h.load("@/lib/storage/sync").createStorageSync({
        channelFactory: () => {
            throw Error("unavailable");
        },
        reconcile: async () => {
            throw Error("read failed");
        },
        onError: () => {
            errors++;
        },
    });
    await sync.activate();
    assert.equal(errors, 1);
    sync.dispose();
});

test("a late editor snapshot cannot downgrade an already accepted revision", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    const old = await h.p.readConversationForEditor("a");
    h.values.set("conversation-state:a", JSON.stringify({ revision: 2, deleted: false }));
    assert.equal(h.p.acceptConversationRead("a", await h.p.readConversationForEditor("a")), true);
    assert.equal(h.p.acceptConversationRead("a", old), false);
});

test("focus and pageshow reconnect and reconcile after pagehide", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const oldWindow = globalThis.window,
        oldDocument = globalThis.document;
    globalThis.window = new EventTarget();
    globalThis.document = new EventTarget();
    let connects = 0,
        closes = 0,
        reads = 0;
    const h = harness();
    const sync = h.load("@/lib/storage/sync").createStorageSync({
        channelFactory: () => {
            connects++;
            return {
                close() {
                    closes++;
                },
                postMessage() {},
            };
        },
        reconcile: async () => {
            reads++;
        },
        onError: (e) => {
            throw e;
        },
    });
    try {
        await sync.activate();
        assert.equal(reads, 1);
        window.dispatchEvent(new Event("pagehide"));
        assert.equal(closes, 1);
        window.dispatchEvent(new Event("pageshow"));
        window.dispatchEvent(new Event("focus"));
        t.mock.timers.tick(50);
        await new Promise(setImmediate);
        assert.equal(connects, 2);
        assert.equal(reads, 2);
        sync.dispose();
        window.dispatchEvent(new Event("focus"));
        t.mock.timers.tick(50);
        assert.equal(reads, 2);
    } finally {
        sync.dispose();
        globalThis.window = oldWindow;
        globalThis.document = oldDocument;
    }
});

test("lifecycle flush registration is idempotent and pagehide drains pending writes", async () => {
    const oldWindow = globalThis.window,
        oldDocument = globalThis.document;
    globalThis.window = new EventTarget();
    globalThis.document = new EventTarget();
    const h = harness();
    await h.init();
    const cleanup = h.p.registerLifecycleFlush();
    try {
        assert.equal(cleanup, h.p.registerLifecycleFlush());
        h.p.scheduleJson("settings", () => ({ value: 5 }));
        window.dispatchEvent(new Event("pagehide"));
        await new Promise(setImmediate);
        assert.equal(h.log.filter((e) => e[0] === "set").length, 1);
        cleanup();
        h.p.scheduleJson("settings", () => ({ value: 6 }));
        window.dispatchEvent(new Event("pagehide"));
        await new Promise(setImmediate);
        assert.equal(h.log.filter((e) => e[0] === "set").length, 1);
        await h.p.flushAll();
    } finally {
        cleanup();
        globalThis.window = oldWindow;
        globalThis.document = oldDocument;
    }
});

test("theme persistence failure keeps the committed theme; recovery is explicit", async () => {
    const h = harness();
    await h.init();
    const theme = h.load("@/lib/stores/theme");
    await theme.hydrateTheme();
    await theme.setTheme("dark");
    h.backend.beforeSet = async () => {
        throw h.fault("QUOTA_EXCEEDED");
    };
    await assert.rejects(theme.setTheme("light"), { code: "QUOTA_EXCEEDED" });
    assert.equal(theme.themeStore.getState().theme, "dark");
    assert.equal(h.values.get("theme"), "dark");
    h.backend.beforeSet = null;
    await theme.setTheme("light");
    assert.equal(theme.themeStore.getState().theme, "light");
});

test("remote theme refresh reads formal data without writing or broadcasting", async () => {
    const h = harness();
    await h.init();
    h.values.set("theme", "dark");
    const events = [];
    h.load("@/lib/storage/events").onStorageCommit((e) => events.push(e));
    const theme = h.load("@/lib/stores/theme");
    await theme.hydrateTheme();
    h.values.set("theme", "light");
    await theme.hydrateTheme();
    assert.equal(theme.themeStore.getState().theme, "light");
    assert.equal(events.length, 0);
    assert.equal(h.log.length, 0);
});

test("unavailable boot cache cannot fail a successful theme, locale or skin write", async () => {
    const old = globalThis.window;
    globalThis.window = {
        get localStorage() {
            throw Error("denied");
        },
    };
    try {
        const h = harness();
        await h.init();
        await h.load("@/lib/stores/theme").setTheme("dark");
        await h.p.writeJsonNow("settings", { skin: "flat" });
        await h.p.writeRawNow("locale", "zh");
        assert.equal(h.values.get("theme"), "dark");
        assert.equal(h.values.get("locale"), "zh");
    } finally {
        globalThis.window = old;
    }
});

test("usage calibration is cached and receipts update only final record sizes", async () => {
    const h = harness();
    await h.init();
    h.values.set("settings", "abc");
    let scans = 0;
    const keys = h.backend.keys;
    h.backend.keys = async (prefix) => {
        scans++;
        return keys(prefix);
    };
    const usage = h.load("@/lib/storage/usage");
    const first = await usage.estimateUsage();
    assert.equal(first.logicalBytes, 22);
    await usage.estimateUsage();
    assert.equal(scans, 1);
    usage.recordSizes([{ key: "settings", previousSize: 22, currentSize: 30 }]);
    assert.equal((await usage.estimateUsage()).logicalBytes, 30);
    assert.equal(scans, 1);
    usage.invalidateUsage();
    await usage.estimateUsage();
    assert.equal(scans, 2);
});

test("two tab controllers synchronize theme through formal reads without echo writes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const a = harness(),
        b = harness();
    await a.init();
    await b.init();
    b.backend.get = (key) => a.backend.get(key);
    const ta = a.load("@/lib/stores/theme"),
        tb = b.load("@/lib/stores/theme");
    const channels = [];
    let broadcasts = 0;
    const factory = () => {
        const c = {
            postMessage(data) {
                broadcasts++;
                for (const other of channels) if (other !== c) other.onmessage?.({ data });
            },
            close() {},
        };
        channels.push(c);
        return c;
    };
    let refreshed = Promise.resolve();
    const sa = a.load("@/lib/storage/sync").createStorageSync({
        channelFactory: factory,
        reconcile: async () => {},
        onError: (e) => {
            throw e;
        },
    });
    const sb = b.load("@/lib/storage/sync").createStorageSync({
        channelFactory: factory,
        reconcile: async () => {},
        onThemeHint: () => {
            refreshed = tb.hydrateTheme();
        },
        onError: (e) => {
            throw e;
        },
    });
    try {
        await sa.activate();
        await sb.activate();
        await ta.setTheme("dark");
        t.mock.timers.tick(50);
        await refreshed;
        assert.equal(tb.themeStore.getState().theme, "dark");
        assert.equal(b.log.length, 0);
        assert.equal(broadcasts, 1);
    } finally {
        sa.dispose();
        sb.dispose();
    }
});

test("clear retires live IDs even when they have not entered the draft table", async () => {
    const h = harness();
    await h.init();
    await h.p.clearStorage("conversations", () => ["fresh"]);
    h.p.stageConversationMeta(meta("fresh"));
    h.p.scheduleConversationWrite("fresh", () => body("fresh"));
    await h.p.flushAll();
    assert.equal(h.values.has("conversation:fresh"), false);
});

test("theme hydration never fills an absent snapshot by overwriting a newer theme", async () => {
    const h = harness();
    await h.p.beginStorageHydration();
    h.values.set("theme", "dark");
    await h.load("@/lib/stores/theme").hydrateTheme();
    assert.equal(h.values.get("theme"), "dark");
    assert.equal(h.log.length, 0);
    await h.p.finishStorageHydration();
    await h.load("@/lib/stores/theme").hydrateTheme();
    assert.equal(h.load("@/lib/stores/theme").themeStore.getState().theme, "dark");
});

test("import retains compaction and remaps its anchor on ID collision", async () => {
    const h = harness();
    await h.init();
    await h.p.createImportedConversation(meta("a"), body("a"));
    const io = h.load("@/lib/storage/io"),
        transfer = h.load("@/lib/transfer");
    const parsed = io.parseImport(
        JSON.stringify({
            format: "hyoai-export",
            version: 1,
            exportedAt: 0,
            conversations: [
                {
                    ...meta("a"),
                    ...body("a"),
                    compaction: { summary: "keep", anchorId: "root", createdAt: 1 },
                },
            ],
        }),
    );
    assert.equal(parsed.ok, true);
    await transfer.applyImport(parsed.data);
    const id = h.log.filter((entry) => entry[0] === "commit").at(-1)[1];
    assert.notEqual(id, "a");
    const read = await h.p.readConversationForEditor(id);
    assert.equal(read.data.compaction.summary, "keep");
    assert.equal(read.data.compaction.anchorId, read.data.rootId);
});

test("saving one conflict copy leaves other local drafts and conflict choices intact", async () => {
    const h = harness();
    await h.init();
    for (const id of ["a", "b"]) {
        await h.p.createImportedConversation(meta(id), body(id));
        h.p.scheduleConversationWrite(id, () => body(id));
    }
    h.reset();
    await h.p.reconcileConversations(idle);
    await h.p.saveConflictCopy("a");
    assert.equal(h.p.isConversationDirty("b"), true);
    assert.ok(
        h.p.persistenceProblems
            .getState()
            .problems.some((problem) => problem.key === "conversation:b"),
    );
    assert.ok(
        h.p.persistenceProblems
            .getState()
            .problems.some((problem) => problem.key === "conversation:a"),
    );
});

test("message clipboard fallback still selects and copies text when the modern API fails", async () => {
    const oldDocument = globalThis.document,
        navDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const calls = [];
    const textarea = {
        style: {},
        setAttribute() {},
        focus() {
            calls.push("focus");
        },
        select() {
            calls.push("select");
        },
        setSelectionRange(a, b) {
            calls.push([a, b]);
        },
        remove() {
            calls.push("remove");
        },
    };
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            clipboard: {
                writeText: async () => {
                    throw Error("denied");
                },
            },
        },
    });
    globalThis.document = {
        createElement: () => textarea,
        body: {
            appendChild() {
                calls.push("append");
            },
        },
        execCommand: (command) => {
            assert.equal(command, "copy");
            return true;
        },
    };
    try {
        await harness().load("@/lib/clipboard").copyText("你好");
        assert.equal(textarea.value, "你好");
        assert.deepEqual(calls, ["append", "focus", "select", [0, 2], "remove"]);
    } finally {
        globalThis.document = oldDocument;
        if (navDescriptor) Object.defineProperty(globalThis, "navigator", navDescriptor);
        else delete globalThis.navigator;
    }
});

test("storage estimation failure does not leak rejection from fire-and-forget refresh", async () => {
    const h = harness();
    h.backend.keys = async () => {
        throw Error("connection unavailable");
    };
    const original = console.warn;
    console.warn = () => {};
    try {
        const store = h.load("@/lib/stores/storage");
        await store.refreshStorage();
        assert.equal(store.storageStore.getState().usage, null);
    } finally {
        console.warn = original;
    }
});
