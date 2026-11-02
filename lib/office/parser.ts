import { newId } from "@/lib/id";
import type { Attachment } from "@/types/chat";

import { parseOfficeFile } from "./parserClient";
import { OfficeParseError } from "./types";

export { OfficeParseError } from "./types";
export type { OfficeErrorCode } from "./types";
export const MAX_OFFICE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_OFFICE_MARKDOWN_BYTES = 4 * 1024 * 1024;
const officeExtensions = new Set([
    "doc",
    "docx",
    "docm",
    "ppt",
    "pps",
    "pot",
    "pptx",
    "pptm",
    "ppsx",
    "ppsm",
    "xls",
    "xlsx",
    "xlsm",
    "xlsb",
    "odt",
    "ods",
    "odp",
    "rtf",
]);

export function officeExtension(name: string): string {
    const index = name.lastIndexOf(".");
    return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

export function isOfficeDocumentFile(file: File): boolean {
    return officeExtensions.has(officeExtension(file.name));
}

export async function readOfficeAttachment(file: File): Promise<Attachment> {
    if (!isOfficeDocumentFile(file))
        throw new OfficeParseError({ code: "unsupported", message: "Unsupported document format" });
    if (file.size > MAX_OFFICE_INPUT_BYTES)
        throw new OfficeParseError({
            code: "inputLimit",
            message: "Document exceeds input size limit",
        });
    const markdown = await parseOfficeFile(file, officeExtension(file.name));
    if (!markdown.replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/gu, ""))
        throw new OfficeParseError({
            code: "empty",
            message: "Document contains no extracted text",
        });
    if (new TextEncoder().encode(markdown).byteLength > MAX_OFFICE_MARKDOWN_BYTES)
        throw new OfficeParseError({
            code: "outputLimit",
            message: "Document exceeds extracted text limit",
        });
    return { id: newId(), kind: "text", mimeType: file.type, name: file.name, content: markdown };
}
