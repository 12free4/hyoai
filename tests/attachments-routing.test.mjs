import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

function setup() {
    const state = [];
    let stateIndex = 0;
    const calls = [];
    const errors = [];
    const pending = [];
    const office = {
        isOfficeDocumentFile: (file) => /\.(docx|xlsx)$/i.test(file.name),
        readOfficeAttachment: (file) =>
            new Promise((resolve, reject) => pending.push({ file, resolve, reject })),
    };
    const modules = {
        "@/lib/id": { newId: () => "id" },
        "./office/parser": office,
        "./office/types": { officeErrorMessageKey: () => "officeErrorGeneric" },
        "next-intl": { useTranslations: () => (key, values) => `${key}:${values?.name}` },
        react: {
            useState: (initial) => {
                const index = stateIndex++;
                state[index] = initial;
                return [
                    initial,
                    (value) => {
                        state[index] = typeof value === "function" ? value(state[index]) : value;
                    },
                ];
            },
            useRef: (current) => ({ current }),
        },
        sonner: { toast: { error: (value) => errors.push(value), success: () => {} } },
        "@/hooks/useStore": {
            useStore: (_store, selector) =>
                selector({ settings: { imageMaxDimension: 100, pdfAsImage: false } }),
        },
        "@/lib/image": {
            downscaleImage: async (file) => {
                calls.push(`image:${file.name}`);
                return { id: file.name };
            },
        },
        "@/lib/pdf": {
            pdfToTextAttachment: async (file) => {
                calls.push(`pdf:${file.name}`);
                return { id: file.name };
            },
        },
        "@/lib/stores/settings": { settingsStore: {} },
    };
    function load(path) {
        const source = fs.readFileSync(new URL(`../${path}.ts`, import.meta.url), "utf8");
        const js = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        const exports = {};
        vm.runInNewContext(`(function(require,exports){${js}\n})`, { console, Error })(
            (name) => modules[name],
            exports,
        );
        return exports;
    }
    modules["@/lib/files"] = load("lib/files");
    const readText = modules["@/lib/files"].readTextAttachment;
    modules["@/lib/files"].readTextAttachment = async (file) => {
        calls.push(`text:${file.name}`);
        return readText(file);
    };
    modules["@/lib/files"].readAudioAttachment = async (file) => {
        calls.push(`audio:${file.name}`);
        return { id: file.name };
    };
    const controls = load("hooks/useAttachments").useAttachments({
        visionBlocked: false,
        audioBlocked: false,
    });
    return { controls, state, calls, errors, pending, files: modules["@/lib/files"] };
}
const file = (name, type = "") => ({ name, type, size: 1, text: async () => "plain" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("routes each file once in image, audio, PDF, Office, text priority", async () => {
    const { controls, pending, calls, files } = setup();
    const items = [
        file("image.docx", "image/png"),
        file("audio.docx", "audio/wav"),
        file("pdf.docx", "application/pdf"),
        file("Office.DOCX"),
        file("table.csv", "text/csv"),
    ];
    assert.deepEqual(items.map(files.attachmentFileKind), [
        "image",
        "audio",
        "pdf",
        "office",
        "text",
    ]);
    controls.routeFiles(items);
    await tick();
    assert.deepEqual(calls.sort(), [
        "audio:audio.docx",
        "image:image.docx",
        "pdf:pdf.docx",
        "text:table.csv",
    ]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].file.name, "Office.DOCX");
    pending[0].resolve({ id: "office" });
    await tick();
});

test("text picker redirects Office files, tracks pending work and continues after errors", async () => {
    const { controls, state, calls, errors, pending } = setup();
    const work = controls.addTextFiles([file("one.docx"), file("two.xlsx"), file("plain.txt")]);
    assert.equal(controls.isProcessingNow(), true);
    assert.equal(state[1], 2);
    await tick();
    assert.deepEqual(calls, ["text:plain.txt"]);
    assert.equal(pending[0].file.name, "one.docx");
    pending[0].reject(new Error("bad document"));
    await tick();
    assert.equal(state[1], 1);
    assert.equal(pending[1].file.name, "two.xlsx");
    pending[1].resolve({ id: "two", kind: "text", content: "markdown" });
    await work;
    assert.equal(controls.isProcessingNow(), false);
    assert.equal(state[1], 0);
    assert.equal(errors[0], "officeErrorGeneric:one.docx");
    assert.equal(state[0].length, 2);
});
