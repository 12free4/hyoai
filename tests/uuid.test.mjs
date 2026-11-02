import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/id.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function load(crypto) {
    const exports = {};
    vm.runInNewContext(js, { exports, crypto });
    return exports.newId;
}

test("uses native randomUUID when available", () => {
    let calls = 0;
    const newId = load({
        randomUUID() {
            calls++;
            return "native-result";
        },
        getRandomValues() {
            throw new Error("unexpected fallback");
        },
    });
    assert.equal(newId(), "native-result");
    assert.equal(calls, 1);
});

test("generates distinct RFC 4122 version 4 UUIDs with getRandomValues", () => {
    const newId = load({ getRandomValues: (bytes) => randomFillSync(bytes) });
    const ids = Array.from({ length: 1000 }, () => newId());
    for (const id of ids) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.equal(new Set(ids).size, ids.length);
});

test("fails explicitly without secure random APIs", () => {
    for (const crypto of [undefined, {}]) {
        assert.throws(load(crypto), /cryptographically secure random number generator/i);
    }
});
