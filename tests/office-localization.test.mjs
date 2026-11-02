import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTranslator } from "use-intl/core";

const keys = [
    "officeProcessed",
    "officeErrorUnsupported",
    "officeErrorEncrypted",
    "officeErrorMalformed",
    "officeErrorResourceLimit",
    "officeErrorMissingPart",
    "officeErrorNeedsOcr",
    "officeErrorInputLimit",
    "officeErrorOutputLimit",
    "officeErrorEmpty",
    "officeErrorGeneric",
];
for (const locale of ["en", "fr", "zh"]) {
    test(`${locale} provides all Office messages with a filename`, () => {
        const messages = JSON.parse(
            readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"),
        );
        const t = createTranslator({ locale, messages, namespace: "composer" });
        for (const key of keys) {
            assert.equal(typeof messages.composer[key], "string", key);
            assert.ok(t(key, { name: "sample.docx" }).includes("sample.docx"), key);
        }
        for (const key of ["attachOffice", "processingDocument"]) assert.ok(t(key).length > 0, key);
    });
}
