import init, {
    formatFromBytes,
    formatFromExtension,
    toMarkdownBytes,
} from "@firecrawl/anydoc-wasm";
import type { ConvertErrorCode, Format } from "@firecrawl/anydoc-wasm";

import type { OfficeErrorData, ParseRequest, ParseResponse } from "./types";

const officeFormats = new Set<Format>([
    "doc",
    "docx",
    "odt",
    "ppt",
    "pptx",
    "rtf",
    "xlsx",
    "ods",
    "odp",
]);
const errorCodes = new Set<ConvertErrorCode>([
    "unsupported",
    "malformed",
    "encrypted",
    "resourceLimit",
    "missingPart",
    "needsOcr",
]);
let initialization: ReturnType<typeof init> | undefined;

function serializeError(error: unknown): OfficeErrorData {
    const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    return {
        code: errorCodes.has(value.code as ConvertErrorCode)
            ? (value.code as ConvertErrorCode)
            : "worker",
        message: typeof value.message === "string" ? value.message : String(error),
        ...(Array.isArray(value.pages) &&
        value.pages.every((page: unknown) => typeof page === "number")
            ? { pages: value.pages as number[] }
            : {}),
        ...(typeof value.pageCount === "number" ? { pageCount: value.pageCount } : {}),
    };
}

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
    const { id, bytes, extension } = event.data;
    let response: ParseResponse;
    try {
        initialization ??= init();
        await initialization;
        const input = new Uint8Array(bytes);
        const format = formatFromBytes(input) ?? formatFromExtension(extension);
        if (!format || !officeFormats.has(format)) {
            response = {
                id,
                error: { code: "unsupported", message: "Unsupported document format" },
            };
        } else {
            response = { id, markdown: toMarkdownBytes(input, format) };
        }
    } catch (error) {
        response = { id, error: serializeError(error) };
    }
    self.postMessage(response);
};
