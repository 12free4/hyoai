import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = fs.readFileSync("node_modules/next-themes/dist/index.mjs", "utf8");
test("next-themes applies defaults without any localStorage access", () => {
    assert.ok(!source.includes('window.addEventListener("storage"'));
    assert.ok(!source.includes("localStorage"));
    const match = source.match(/var M=(.*?);var b=/s);
    assert.ok(match, "review patch if the distributed script changes");
    const classes = new Set();
    const context = {
        document: {
            documentElement: {
                classList: {
                    remove(...v) {
                        v.forEach((x) => classes.delete(x));
                    },
                    add(v) {
                        classes.add(v);
                    },
                },
                style: {},
            },
        },
        window: { matchMedia: () => ({ matches: true }) },
    };
    Object.defineProperty(context, "localStorage", {
        get() {
            throw Error("blocked");
        },
    });
    const script = vm.runInNewContext(`(${match[1]})`, context);
    script("class", "unused", "system", null, ["light", "dark"], null, true, true);
    assert.ok(classes.has("dark"));
});
test("next-themes runtime switches theme even when the boot cache write throws", () => {
    const match = source.match(/f=t\.useCallback\((o=>\{.*?\}),\[c\]\)/s);
    assert.ok(match);
    let applied;
    const context = {
        c: "system",
        n: (value) => {
            applied = value;
        },
        localStorage: {
            setItem() {
                throw Error("quota");
            },
        },
    };
    const setter = vm.runInNewContext(`(${match[1]})`, context);
    setter("dark");
    assert.equal(applied, "dark");
});
