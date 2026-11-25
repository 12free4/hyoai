import { describe, expect, it } from "vitest";

import { isOfficeDocumentFile, officeExtension } from "@/lib/office/parser";
import { officeErrorMessageKey, OfficeParseError } from "@/lib/office/types";
import { OFFICE_ACCEPT } from "@/lib/files";

const namedFile = (name: string) => ({ name }) as File;

describe("Office attachment recognition", () => {
    it("normalizes extensions without depending on MIME types", () => {
        expect(officeExtension("Quarterly.DOCX")).toBe("docx");
        expect(officeExtension("no-extension")).toBe("");
    });

    it("recognizes supported Office and OpenDocument extensions", () => {
        for (const name of [
            "letter.doc",
            "letter.docx",
            "letter.docm",
            "slides.pptx",
            "slides.pptm",
            "book.xls",
            "book.xlsx",
            "book.xlsb",
            "notes.odt",
            "sheet.ods",
            "deck.odp",
            "memo.rtf",
        ]) {
            expect(isOfficeDocumentFile(namedFile(name)), name).toBe(true);
        }
        expect(isOfficeDocumentFile(namedFile("photo.png"))).toBe(false);
        expect(isOfficeDocumentFile(namedFile("scan.pdf"))).toBe(false);
    });

    it("offers Office formats in the file picker", () => {
        expect(OFFICE_ACCEPT).toContain(".docx");
        expect(OFFICE_ACCEPT).toContain(".xlsx");
        expect(OFFICE_ACCEPT).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    });

    it("maps parser errors to localized composer messages", () => {
        expect(officeErrorMessageKey(new OfficeParseError({
            code: "encrypted",
            message: "encrypted",
        }))).toBe("officeErrorEncrypted");
        expect(officeErrorMessageKey(new Error("worker"))).toBe("officeErrorGeneric");
    });
});
