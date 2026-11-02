import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/clipboard.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function setup(clipboard, copyResult = true) {
    const calls = [];
    const textarea = {
        style: {},
        setAttribute() {},
        focus() {},
        select() {
            calls.push("select");
        },
        setSelectionRange() {},
        remove() {
            calls.push("remove");
        },
    };
    const exports = {};
    vm.runInNewContext(js, {
        exports,
        navigator: { clipboard },
        document: {
            createElement: () => textarea,
            body: {
                appendChild() {
                    calls.push("append");
                },
            },
            execCommand: () => copyResult,
        },
    });
    return { copyText: exports.copyText, calls, textarea };
}

test("uses the modern clipboard API when available", async () => {
    const writes = [];
    const { copyText, calls } = setup({ writeText: async (text) => writes.push(text) });
    await copyText("hello");
    assert.deepEqual(writes, ["hello"]);
    assert.deepEqual(calls, []);
});

test("copies using the fallback when the clipboard API is absent", async () => {
    const { copyText, calls, textarea } = setup(undefined);
    await copyText("你好");
    assert.equal(textarea.value, "你好");
    assert.deepEqual(calls, ["append", "select", "remove"]);
});

test("reports failure and removes the temporary input when fallback fails", async () => {
    const { copyText, calls } = setup(undefined, false);
    await assert.rejects(copyText("hello"), /Failed to copy text to the clipboard/);
    assert.deepEqual(calls, ["append", "select", "remove"]);
});
