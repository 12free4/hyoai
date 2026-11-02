import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["storage/indexeddbAdapter", "storage/indexeddbSchema", "storage/indexeddb", "id"];
const modules = files
    .map((name) => {
        const source = fs.readFileSync(path.join(root, "lib", `${name}.ts`), "utf8");
        const js = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        return `${JSON.stringify(`@/lib/${name}`)}: function(require, module, exports) {\n${js}\n}`;
    })
    .join(",\n");
const test = String.raw`
const modules = { MODULES };
const cache = {};
function require(name) { if (!cache[name]) { const module = { exports: {} }; cache[name] = module; modules[name](require, module, module.exports); } return cache[name].exports; }
const { IndexedDBStorage } = require("@/lib/storage/indexeddb");
const assert = (v, m) => { if (!v) throw new Error(m); };
async function rejects(fn, code) { try { await fn(); } catch (e) { assert(e.code === code, 'expected ' + code + ', got ' + e.code); return; } throw new Error('expected ' + code); }
async function run() {
 Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
 const name = 'hyoai-test-' + require("@/lib/id").newId(); const a = new IndexedDBStorage(name); const b = new IndexedDBStorage(name);
 const first = await a.readSnapshot([]); assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first.dbEpoch) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first.conversationEpoch) && first.dbEpoch !== first.conversationEpoch, "initial epochs"); const ctx = { dbEpoch: first.dbEpoch, conversationEpoch: first.conversationEpoch };
 const receipt = await a.set('settings', 'one', ctx); assert(receipt.previousSize === 0 && receipt.currentSize === 22, 'write receipt');
 await rejects(() => a.set('meta', 'x', ctx), 'DATABASE_ERROR');
 await a.set('abc', '1', ctx); await a.set('abcd', '2', ctx); await a.set('ab￿tail', '3', ctx);
 assert((await a.keys('ab')).length === 3, 'prefix cursor');
 const meta = id => ({ id, title: id, pinned: false, createdAt: 1, lastModified: 1 });
 const create = (id, context = ctx) => ({ kind: 'create', id, expectedRevision: null, metadata: meta(id), value: id, context });
 const attachment = {id:'file',kind:'text',name:'report.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',content:'# Report\n\n**Hello**'};
 const tree = {id:'office',rootId:'root',currNode:'first',nodes:{root:{id:'root',role:'root',content:'',parent:null,children:['first','edit'],createdAt:1},first:{id:'first',role:'user',content:'original',parent:'root',children:[],attachments:[attachment],createdAt:1},edit:{id:'edit',role:'user',content:'edited',parent:'root',children:[],attachments:[],createdAt:2}}};
 await a.commitConversation({kind:'create',id:'office',expectedRevision:null,metadata:meta('office'),value:JSON.stringify(tree),context:ctx});
 const reopened = new IndexedDBStorage(name);
 let restored = JSON.parse((await reopened.readSnapshot(['conversation:office'])).values.get('conversation:office'));
 assert(restored.nodes.first.attachments[0].content === attachment.content && restored.nodes.first.attachments[0].name === attachment.name, 'Office attachment restored after reopening database');
 restored.currNode = 'edit';
 await reopened.commitConversation({kind:'update',id:'office',expectedRevision:1,value:JSON.stringify(restored),context:ctx});
 restored = JSON.parse((await b.readSnapshot(['conversation:office'])).values.get('conversation:office'));
 assert(restored.currNode === 'edit' && restored.nodes.edit.attachments.length === 0 && restored.nodes.first.attachments[0].content === attachment.content, 'Office attachment and edited branch persisted');
 reopened.close();
 const [c1,c2] = await Promise.all([a.commitConversation(create('1')), b.commitConversation(create('2'))]);
 assert(c1.revision === 1 && c2.revision === 1, 'create revision');
 const snap = await a.readSnapshot(['conversation:1','conversation-state:1','conversations:index','conversation:1','missing']);
 assert(snap.values.size === 4 && snap.values.get('missing') === null && JSON.parse(snap.values.get('conversations:index')).length === 3, 'snapshot');
 assert(snap.values.get('conversation:1') === '1' && JSON.parse(snap.values.get('conversation-state:1')).revision === 1, 'body and revision');
 await rejects(() => b.commitConversation(create('1')), 'ID_COLLISION');
 const updated = await a.commitConversation({kind:'update',id:'1',expectedRevision:1,value:'new',context:ctx});
 assert(updated.revision === 2 && new Set(updated.changes.map(x => x.key)).size === updated.changes.length, 'revision and receipt uniqueness');
 await rejects(() => b.commitConversation({kind:'update',id:'1',expectedRevision:1,value:'old',context:ctx}), 'REVISION_CONFLICT');
 await a.deleteConversation({id:'1',expectedRevision:2,context:ctx});
 await rejects(() => b.commitConversation(create('1')), 'ID_COLLISION');
 const reset = await a.clearConversations(ctx); assert(reset.epoch.dbEpoch === ctx.dbEpoch && reset.epoch.conversationEpoch !== ctx.conversationEpoch, 'conversation reset');
 await rejects(() => b.commitConversation(create('3')), 'STALE_CONVERSATION_EPOCH');
 await b.set('settings','two',ctx); assert(await a.get('settings') === 'two', 'setting survives conversation reset');
 const newCtx = reset.epoch; await b.commitConversation(create('3',newCtx));
 const resetAll = await a.clearAll(newCtx); assert(resetAll.epoch.dbEpoch !== ctx.dbEpoch, 'database reset');
 await rejects(() => b.set('settings','old',ctx), 'STALE_DB_EPOCH');
 await rejects(() => b.commitConversation(create('4',newCtx)), 'STALE_DB_EPOCH');
 assert((await b.readSnapshot(['settings','conversation:3'])).values.get('settings') === null, 'clear all');
 await a.commitConversation({kind:'create',id:'office',expectedRevision:null,metadata:meta('office'),value:JSON.stringify(tree),context:resetAll.epoch});
 window.name = name;
 a.close(); b.close(); return 'PASS';
}
run();
`.replace("MODULES", modules);
async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hyoai-idb-"));
    const chrome =
        process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const proc = spawn(
        chrome,
        [
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--remote-debugging-port=0",
            `--user-data-dir=${temp}`,
            "about:blank",
        ],
        { stdio: "ignore" },
    );
    try {
        let port;
        for (let i = 0; i < 100; i++) {
            try {
                port = fs
                    .readFileSync(path.join(temp, "DevToolsActivePort"), "utf8")
                    .split("\n")[0];
                break;
            } catch {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        if (!port) throw new Error("Chrome debugging port unavailable");
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const ws = new WebSocket(
            pages.find((page) => page.type === "page" && page.url === "about:blank")
                .webSocketDebuggerUrl,
        );
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });
        const command = (id, method, params) =>
            new Promise((resolve, reject) => {
                const onMessage = (event) => {
                    const msg = JSON.parse(event.data);
                    if (msg.id !== id) return;
                    ws.removeEventListener("message", onMessage);
                    if (msg.error) reject(new Error(msg.error.message));
                    else resolve(msg.result);
                };
                ws.addEventListener("message", onMessage);
                ws.send(JSON.stringify({ id, method, params }));
            });
        fs.writeFileSync(path.join(temp, "test.html"), "<html></html>");
        await command(1, "Page.navigate", {
            url: "file:///" + path.join(temp, "test.html").replace(/\\/g, "/"),
        });
        await new Promise((r) => setTimeout(r, 500));
        const result = await command(2, "Runtime.evaluate", {
            expression: test,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails)
            throw new Error(
                result.exceptionDetails.exception?.description || result.exceptionDetails.text,
            );
        if (result.result.value !== "PASS") throw new Error(JSON.stringify(result));
        await command(3, "Page.reload", {});
        await new Promise((r) => setTimeout(r, 500));
        const reload = await command(4, "Runtime.evaluate", {
            expression: `(async () => {
                const db = await new Promise((resolve, reject) => { const r = indexedDB.open(window.name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
                const raw = await new Promise((resolve, reject) => { const r = db.transaction('kv').objectStore('kv').get('conversation:office'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
                db.close();
                const doc = JSON.parse(raw);
                return doc.nodes.first.attachments[0].name === 'report.docx' && doc.nodes.first.attachments[0].content === '# Report\\n\\n**Hello**';
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        ws.close();
        if (reload.exceptionDetails || reload.result.value !== true)
            throw new Error(
                `Office attachment not restored after reload: ${JSON.stringify(reload)}`,
            );
        console.log("IndexedDB browser smoke tests passed in Chrome.");
    } finally {
        if (proc.exitCode === null && proc.signalCode === null) {
            const exited = new Promise((resolve) => proc.once("exit", resolve));
            proc.kill();
            await exited;
        }
        try {
            fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
            console.warn(`Could not remove temporary Chrome profile ${temp}:`, error.message);
        }
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
