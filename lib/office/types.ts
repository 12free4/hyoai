import type { ConvertErrorCode } from "@firecrawl/anydoc-wasm";

export type OfficeErrorCode = ConvertErrorCode | "inputLimit" | "outputLimit" | "empty" | "worker";

export interface OfficeErrorData {
    code: OfficeErrorCode;
    message: string;
    pages?: number[];
    pageCount?: number;
}

export class OfficeParseError extends Error {
    readonly code: OfficeErrorCode;
    readonly pages?: number[];
    readonly pageCount?: number;

    constructor(data: OfficeErrorData) {
        super(data.message);
        this.name = "OfficeParseError";
        this.code = data.code;
        this.pages = data.pages;
        this.pageCount = data.pageCount;
    }
}

export function officeErrorMessageKey(error: unknown) {
    if (!(error instanceof OfficeParseError)) return "officeErrorGeneric" as const;
    switch (error.code) {
        case "unsupported":
            return "officeErrorUnsupported" as const;
        case "malformed":
            return "officeErrorMalformed" as const;
        case "encrypted":
            return "officeErrorEncrypted" as const;
        case "resourceLimit":
            return "officeErrorResourceLimit" as const;
        case "missingPart":
            return "officeErrorMissingPart" as const;
        case "needsOcr":
            return "officeErrorNeedsOcr" as const;
        case "inputLimit":
            return "officeErrorInputLimit" as const;
        case "outputLimit":
            return "officeErrorOutputLimit" as const;
        case "empty":
            return "officeErrorEmpty" as const;
        case "worker":
            return "officeErrorGeneric" as const;
    }
}

export interface ParseRequest {
    id: number;
    bytes: ArrayBuffer;
    extension: string;
}

export type ParseResponse =
    { id: number; markdown: string } | { id: number; error: OfficeErrorData };
