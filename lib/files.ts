import { newId } from "@/lib/id";
import type { Attachment } from "@/types/chat";

import { isOfficeDocumentFile } from "./office/parser";

export { isOfficeDocumentFile, readOfficeAttachment } from "./office/parser";
export { officeErrorMessageKey } from "./office/types";

export const OFFICE_ACCEPT = [
    ".doc",
    ".docx",
    ".docm",
    ".ppt",
    ".pps",
    ".pot",
    ".pptx",
    ".pptm",
    ".ppsx",
    ".ppsm",
    ".xls",
    ".xlsx",
    ".xlsm",
    ".xlsb",
    ".odt",
    ".ods",
    ".odp",
    ".rtf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-word.document.macroenabled.12",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/rtf",
    "text/rtf",
].join(",");

/**
 * Maximum size of a text file that can be read into a text attachment.
 * Maximum size of an audio file that can be read into an inline audio attachment.
 * Audio file must be mp3 or wav, since the browser can only play those formats.
 */
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"]);

// Composer accept attribute of the audio file picker.
export const AUDIO_ACCEPT = ".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav";

/**
 * Whether a file is an audio format sendable as an input_audio part.
 *
 * @param file - Candidate file
 */
export function isAudioFile(file: File): boolean {
    return AUDIO_MIME_TYPES.has(file.type) || /\.(mp3|wav)$/i.test(file.name);
}

export function attachmentFileKind(file: File): "image" | "audio" | "pdf" | "office" | "text" {
    if (file.type.startsWith("image/")) return "image";
    if (isAudioFile(file)) return "audio";
    if (file.type === "application/pdf") return "pdf";
    if (isOfficeDocumentFile(file)) return "office";
    return "text";
}

/**
 * Read a file as a data URI.
 *
 * @param file - File to read
 */
function readAsDataUri(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error(`Failed to read "${file.name}"`));
        reader.readAsDataURL(file);
    });
}

/**
 * Read a plain-text file into a text attachment.
 * Binary content (NUL bytes) and oversized files are rejected, since the
 * payload ends up inline in browser storage and in the prompt.
 *
 * @param file - Text file picked, pasted or dropped by the user
 * @returns Text attachment holding the file content
 */
export async function readTextAttachment(file: File): Promise<Attachment> {
    if (file.size > MAX_TEXT_BYTES) {
        throw new Error(`"${file.name}" exceeds ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
    }
    const content = await file.text();
    if (content.includes("\u0000")) {
        throw new Error(`"${file.name}" is not a text file`);
    }
    return {
        id: newId(),
        kind: "text",
        mimeType: file.type || "text/plain",
        name: file.name,
        content,
    };
}

/**
 * Read an audio file into an inline audio attachment.
 *
 * @param file - mp3 or wav file picked by the user
 * @returns Audio attachment holding the data URI
 */
export async function readAudioAttachment(file: File): Promise<Attachment> {
    if (file.size > MAX_AUDIO_BYTES) {
        throw new Error(`"${file.name}" exceeds ${MAX_AUDIO_BYTES / 1024 / 1024} MB`);
    }
    const mimeType = file.type || (/\.mp3$/i.test(file.name) ? "audio/mpeg" : "audio/wav");
    return {
        id: newId(),
        kind: "audio",
        mimeType,
        name: file.name,
        dataUri: await readAsDataUri(file),
    };
}
