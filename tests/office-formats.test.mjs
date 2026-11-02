import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { formatFromExtension, initSync } from "@firecrawl/anydoc-wasm";
import ts from "typescript";

initSync({
    module: readFileSync(
        new URL("../node_modules/@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm", import.meta.url),
    ),
});

test("installed AnyDoc maps every supported extension to its parser", () => {
    const formats = {
        doc: "doc",
        docx: "docx",
        docm: "docx",
        ppt: "ppt",
        pps: "ppt",
        pot: "ppt",
        pptx: "pptx",
        pptm: "pptx",
        ppsx: "pptx",
        ppsm: "pptx",
        xls: "xlsx",
        xlsx: "xlsx",
        xlsm: "xlsx",
        xlsb: "xlsx",
        odt: "odt",
        ods: "ods",
        odp: "odp",
        rtf: "rtf",
    };
    for (const [extension, format] of Object.entries(formats))
        assert.equal(formatFromExtension(extension), format, extension);
});

test("worker uses content first, falls back to extension, and rejects excluded content", async () => {
    let detected;
    let fallbackCalls = 0;
    const calls = [];
    const self = { postMessage: (message) => calls.push(message) };
    const api = {
        default: async () => {},
        formatFromBytes: () => detected,
        formatFromExtension: () => {
            fallbackCalls++;
            return "docx";
        },
        toMarkdownBytes: (_bytes, format) => `converted:${format}`,
    };
    const source = readFileSync(new URL("../lib/office/parser.worker.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(`(function(require,exports){${js}\n})`, { self, Uint8Array, Set, String })(
        () => api,
        {},
    );
    detected = "xlsx";
    await self.onmessage({ data: { id: 1, bytes: new ArrayBuffer(0), extension: "docx" } });
    assert.equal(calls[0].markdown, "converted:xlsx");
    assert.equal(fallbackCalls, 0);
    detected = undefined;
    await self.onmessage({ data: { id: 2, bytes: new ArrayBuffer(0), extension: "docx" } });
    assert.equal(calls[1].markdown, "converted:docx");
    assert.equal(fallbackCalls, 1);
    detected = "pdf";
    await self.onmessage({ data: { id: 3, bytes: new ArrayBuffer(0), extension: "docx" } });
    assert.equal(calls[2].error.code, "unsupported");
    assert.equal(fallbackCalls, 1);
});

test("worker preserves each AnyDoc error code, message and page metadata", async () => {
    let failure;
    let initializationCount = 0;
    const responses = [];
    const self = { postMessage: (message) => responses.push(message) };
    const api = {
        default: async () => {
            initializationCount++;
        },
        formatFromBytes: () => "docx",
        toMarkdownBytes: () => {
            throw failure;
        },
    };
    const source = readFileSync(new URL("../lib/office/parser.worker.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(`(function(require,exports){${js}\n})`, { self, Uint8Array, Set, String })(
        () => api,
        {},
    );
    for (const code of [
        "unsupported",
        "malformed",
        "encrypted",
        "resourceLimit",
        "missingPart",
        "needsOcr",
    ]) {
        failure = Object.assign(new Error(`detail ${code}`), { code, pages: [1, 3], pageCount: 4 });
        await self.onmessage({ data: { id: 1, bytes: new ArrayBuffer(0), extension: "docx" } });
        const error = responses.at(-1).error;
        assert.equal(error.code, code);
        assert.equal(error.message, `detail ${code}`);
        assert.deepEqual(Array.from(error.pages), [1, 3]);
        assert.equal(error.pageCount, 4);
    }
    assert.equal(initializationCount, 1);
});
