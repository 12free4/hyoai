import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import ts from "typescript";

const cache = new Map();
function load(name) {
    if (name === "@/lib/i18n")
        return {
            getTranslator:
                () =>
                (key, args = {}) =>
                    `${key} ${JSON.stringify(args)}`,
        };
    if (name === "@/lib/id") return { newId: () => "id" };
    if (cache.has(name)) return cache.get(name);
    const source = fs.readFileSync(new URL(`../${name.slice(2)}.ts`, import.meta.url), "utf8");
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports = {};
    cache.set(name, exports);
    new Function("require", "exports", js)(load, exports);
    return exports;
}
const { buildApiMessages } = load("@/lib/conversation");
const {
    corpusForChunking,
    estimateMessagesTokens,
    planInputChunking,
    buildChapterMessages,
    buildSynthesisMessages,
} = load("@/lib/chunking");
const office = {
    id: "file",
    kind: "text",
    name: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    content: "# Report\n\nHello **world**.",
};
const node = (attachments) => ({
    id: "user",
    role: "user",
    parent: "root",
    children: [],
    content: "Summarize",
    attachments,
    createdAt: 1,
});

test("Office becomes labeled text in the existing API protocol alongside media", () => {
    const image = {
        id: "i",
        kind: "image",
        mimeType: "image/png",
        dataUri: "data:image/png;base64,AAAA",
    };
    const audio = {
        id: "a",
        kind: "audio",
        mimeType: "audio/wav",
        dataUri: "data:audio/wav;base64,BBBB",
    };
    const pdf = {
        id: "p",
        kind: "pdf",
        name: "file.pdf",
        mimeType: "application/pdf",
        content: "PDF text",
    };
    const text = {
        id: "t",
        kind: "text",
        name: "file.txt",
        mimeType: "text/plain",
        content: "plain",
    };
    const messages = buildApiMessages([node([office, image, audio, pdf, text])], "");
    assert.deepEqual(messages[0].content, [
        { type: "text", text: `File: report.docx\n\n${office.content}` },
        { type: "text", text: "File: file.pdf\n\nPDF text" },
        { type: "text", text: "File: file.txt\n\nplain" },
        { type: "text", text: "Summarize" },
        { type: "image_url", image_url: { url: image.dataUri } },
        { type: "input_audio", input_audio: { data: "BBBB", format: "wav" } },
    ]);
    assert.ok(estimateMessagesTokens(messages) > 0);
});

test("long Office text participates in chunk planning, chapter analysis and synthesis", () => {
    const document = {
        ...office,
        content: "A detailed paragraph about this document.\n\n".repeat(500),
    };
    const corpus = corpusForChunking("Summarize", [document]);
    assert.ok(corpus.startsWith("File: report.docx\n\n"));
    const plan = planInputChunking({
        text: "Summarize",
        attachments: [document],
        contextTokens: 2048,
        safetyFraction: 0.8,
        strategy: "mapreduce",
        reservedOutputTokens: 256,
    });
    assert.ok(plan && plan.chunks.length > 1);
    assert.equal(plan.instruction, "Summarize");
    const chapter = buildChapterMessages({
        strategy: "mapreduce",
        instruction: plan.instruction,
        chunk: plan.chunks[0],
        index: 0,
        total: plan.chunks.length,
        runningSummary: "",
    });
    assert.ok(chapter[1].content.includes(plan.chunks[0]));
    const synthesis = buildSynthesisMessages(plan.instruction, ["analysis one", "analysis two"]);
    assert.ok(
        synthesis[1].content.includes("analysis one") &&
            synthesis[1].content.includes("analysis two"),
    );
});
