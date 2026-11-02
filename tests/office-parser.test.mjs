import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

function setup() {
    const cache = {};
    const workers = [];
    class WorkerMock {
        constructor() {
            this.messages = [];
            workers.push(this);
        }
        postMessage(message, transfer) {
            this.messages.push(message);
            assert.equal(transfer[0], message.bytes);
        }
        terminate() {
            this.terminated = true;
        }
        reply(message) {
            this.onmessage({ data: message });
        }
    }
    const context = vm.createContext({
        Worker: WorkerMock,
        URL,
        TextEncoder,
        setTimeout,
        clearTimeout,
        console,
    });
    function load(name) {
        if (name === "@/lib/id") return { newId: () => "test-id" };
        if (cache[name]) return cache[name];
        const file = name.replace("./", "");
        let source = fs.readFileSync(new URL(`../lib/office/${file}.ts`, import.meta.url), "utf8");
        source = source.replaceAll("import.meta.url", '"file:///test.js"');
        const js = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        const loadedModule = { exports: {} };
        cache[name] = loadedModule.exports;
        vm.runInContext(`(function(require,module,exports){${js}\n})`, context)(
            load,
            loadedModule,
            loadedModule.exports,
        );
        return loadedModule.exports;
    }
    return { parser: load("parser"), client: load("parserClient"), workers };
}
const file = (name, size = 5) => ({
    name,
    size,
    type: "",
    arrayBuffer: async () => new ArrayBuffer(size),
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("queues documents in call order and keeps processing after a conversion error", async () => {
    const { parser, workers } = setup();
    const first = parser.readOfficeAttachment(file("ONE.DOCX"));
    const second = parser.readOfficeAttachment(file("two.docx"));
    await tick();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].messages.length, 1);
    workers[0].reply({
        id: workers[0].messages[0].id,
        error: { code: "encrypted", message: "locked", pages: [2], pageCount: 3 },
    });
    await assert.rejects(
        first,
        (error) => error.code === "encrypted" && error.pages[0] === 2 && error.pageCount === 3,
    );
    await tick();
    assert.equal(workers[0].messages.length, 2);
    workers[0].reply({ id: workers[0].messages[1].id, markdown: "hello" });
    const attachment = await second;
    assert.equal(attachment.kind, "text");
    assert.equal(attachment.name, "two.docx");
    assert.equal(attachment.mimeType, "");
    assert.equal(attachment.content, "hello");
});

test("worker failure rejects only the active file and queued work uses a new worker", async () => {
    const { parser, workers } = setup();
    const first = parser.readOfficeAttachment(file("one.docx"));
    const second = parser.readOfficeAttachment(file("two.docx"));
    const firstFailure = assert.rejects(first, (error) => error.code === "worker");
    await tick();
    workers[0].onerror({ message: "crashed" });
    await firstFailure;
    assert.equal(workers[0].terminated, true);
    await tick();
    workers[1].reply({ id: workers[1].messages[0].id, markdown: "queued" });
    assert.equal((await second).content, "queued");
    const third = parser.readOfficeAttachment(file("three.docx"));
    await tick();
    workers[1].reply({ id: workers[1].messages[1].id, markdown: "recovered" });
    assert.equal((await third).content, "recovered");
});

test("rejects unsupported, oversized, empty and oversized UTF-8 output", async () => {
    const { parser, workers } = setup();
    await assert.rejects(
        parser.readOfficeAttachment(file("test.csv")),
        (error) => error.code === "unsupported",
    );
    await assert.rejects(
        parser.readOfficeAttachment(file("large.docx", parser.MAX_OFFICE_INPUT_BYTES + 1)),
        (error) => error.code === "inputLimit",
    );
    const empty = parser.readOfficeAttachment(file("empty.docx"));
    await tick();
    workers[0].reply({ id: workers[0].messages[0].id, markdown: " \n\u200b\u200d" });
    await assert.rejects(empty, (error) => error.code === "empty");
    const large = parser.readOfficeAttachment(file("large.docx"));
    await tick();
    workers[0].reply({
        id: workers[0].messages[1].id,
        markdown: "中".repeat(Math.ceil(parser.MAX_OFFICE_MARKDOWN_BYTES / 3)),
    });
    await assert.rejects(large, (error) => error.code === "outputLimit");
});

test("accepts exact size limits and returns only attachment metadata and Markdown", async () => {
    const { parser, workers } = setup();
    let reads = 0;
    const document = {
        name: "limit.docx",
        size: parser.MAX_OFFICE_INPUT_BYTES,
        type: "application/test",
        arrayBuffer: async () => {
            reads++;
            return new ArrayBuffer(0);
        },
    };
    const request = parser.readOfficeAttachment(document);
    await tick();
    workers[0].reply({
        id: workers[0].messages[0].id,
        markdown: "a".repeat(parser.MAX_OFFICE_MARKDOWN_BYTES),
    });
    const attachment = await request;
    assert.equal(reads, 1);
    assert.deepEqual(Object.keys(attachment).sort(), ["content", "id", "kind", "mimeType", "name"]);
    assert.equal(attachment.content.length, parser.MAX_OFFICE_MARKDOWN_BYTES);
    assert.equal(attachment.mimeType, "application/test");
});

test("each error code maps to the intended translation key", () => {
    const { parser } = setup();
    const types = parser.OfficeParseError;
    const moduleSource = fs.readFileSync(
        new URL("../lib/office/types.ts", import.meta.url),
        "utf8",
    );
    const js = ts.transpileModule(moduleSource, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(`(function(exports){${js}\n})`, {})(exports);
    for (const [code, expected] of [
        ["encrypted", "officeErrorEncrypted"],
        ["malformed", "officeErrorMalformed"],
        ["resourceLimit", "officeErrorResourceLimit"],
        ["inputLimit", "officeErrorInputLimit"],
        ["outputLimit", "officeErrorOutputLimit"],
        ["missingPart", "officeErrorMissingPart"],
        ["needsOcr", "officeErrorNeedsOcr"],
        ["unsupported", "officeErrorUnsupported"],
        ["empty", "officeErrorEmpty"],
        ["worker", "officeErrorGeneric"],
    ]) {
        assert.equal(
            exports.officeErrorMessageKey(
                new exports.OfficeParseError({ code, message: "detail" }),
            ),
            expected,
        );
    }
    assert.equal(exports.officeErrorMessageKey(new Error("unexpected")), "officeErrorGeneric");
    assert.equal(typeof types, "function");
});
