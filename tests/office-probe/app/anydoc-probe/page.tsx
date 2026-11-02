"use client";

import { useEffect, useState } from "react";

import { readAudioAttachment, readTextAttachment } from "@/lib/files";
import { downscaleImage } from "@/lib/image";
import { readOfficeAttachment } from "@/lib/office/parser";
import { officeErrorMessageKey, OfficeParseError } from "@/lib/office/types";
import { pdfToImageAttachments, pdfToTextAttachment } from "@/lib/pdf";

async function runMedia(): Promise<string> {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const imageBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("PNG creation failed"))),
            "image/png",
        ),
    );
    const image = await downscaleImage(
        new File([imageBlob], "image.png", { type: "image/png" }),
        128,
    );
    const audio = await readAudioAttachment(
        new File(["audio"], "audio.wav", { type: "audio/wav" }),
    );
    const text = await readTextAttachment(
        new File(["a,b\n1,2"], "table.csv", { type: "text/csv" }),
    );
    const response = await fetch("fixtures/text.pdf");
    if (!response.ok) throw new Error("PDF fixture unavailable");
    const pdf = new File([await response.arrayBuffer()], "text.pdf", { type: "application/pdf" });
    const pdfText = await pdfToTextAttachment(pdf);
    const pdfImages = await pdfToImageAttachments(pdf, 128);
    if (
        image.kind !== "image" ||
        !image.dataUri ||
        audio.kind !== "audio" ||
        !audio.dataUri ||
        text.kind !== "text" ||
        text.content !== "a,b\n1,2" ||
        pdfText.kind !== "pdf" ||
        !pdfText.content?.trim() ||
        pdfImages.length === 0 ||
        pdfImages.some((page) => page.kind !== "image" || !page.dataUri)
    )
        throw new Error("Existing attachment processing failed");
    return JSON.stringify({
        status: "PASS",
        image: image.kind,
        audio: audio.kind,
        text: text.kind,
        pdf: pdfText.kind,
        pdfImagePages: pdfImages.length,
    });
}

async function runErrors(): Promise<string> {
    const cases = [
        ["encrypted--errors.odt", "encrypted"],
        ["truncated--errors.docx", "malformed"],
        ["zipbomb--errors.docx", "resourceLimit"],
    ];
    const results: Record<string, string> = {};
    for (const [name, code] of cases) {
        const response = await fetch(`fixtures/${name}`);
        if (!response.ok) throw new Error(`Fixture unavailable: ${name}`);
        try {
            await readOfficeAttachment(new File([await response.arrayBuffer()], name));
            throw new Error(`Unexpectedly accepted ${name}`);
        } catch (error) {
            if (!(error instanceof OfficeParseError) || error.code !== code) throw error;
            results[code] = officeErrorMessageKey(error);
        }
    }
    return JSON.stringify({ errors: results, status: "PASS" });
}

async function runFormats(): Promise<string> {
    const cases: [string, string][] = [
        ["text.doc", "DOC"],
        ["handmade-rich.docx", "docx"],
        ["handmade-rich.docx", "docm"],
        ["handmade-sparsenotes.ppt", "ppt"],
        ["handmade-sparsenotes.ppt", "pps"],
        ["handmade-sparsenotes.ppt", "pot"],
        ["pres.pptx", "pptx"],
        ["pres.pptx", "pptm"],
        ["pres.pptx", "ppsx"],
        ["pres.pptx", "ppsm"],
        ["sheet.xls", "xls"],
        ["sheet.xlsx", "xlsx"],
        ["sheet.xlsx", "xlsm"],
        ["handmade-sheet.xlsb", "xlsb"],
        ["text.odt", "odt"],
        ["sheet.ods", "ods"],
        ["pres.odp", "odp"],
        ["text.rtf", "rtf"],
        ["handmade-rich.docx", "xls"],
    ];
    const results: Record<string, string> = {};
    for (const [source, extension] of cases) {
        const response = await fetch(`fixtures/${source}`);
        if (!response.ok) throw new Error(`Fixture unavailable: ${source}`);
        const file = new File([await response.arrayBuffer()], `sample.${extension}`, { type: "" });
        const attachment = await readOfficeAttachment(file);
        if (
            !attachment.content?.trim() ||
            attachment.mimeType !== "" ||
            attachment.name !== file.name
        )
            throw new Error(`Unexpected result: ${source} as ${extension}`);
        results[`${source}:${extension}`] = attachment.content;
    }
    for (const source of ["text.pdf", "book.epub"]) {
        const response = await fetch(`fixtures/${source}`);
        try {
            await readOfficeAttachment(new File([await response.arrayBuffer()], "disguised.docx"));
            throw new Error(`Unexpectedly accepted ${source}`);
        } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "unsupported")
                throw error;
        }
    }
    if (results["handmade-rich.docx:xls"] !== results["handmade-rich.docx:docx"])
        throw new Error("Content detection did not take precedence");
    return JSON.stringify({
        formats: Object.keys(results),
        excluded: ["pdf", "epub"],
        status: "PASS",
    });
}

export default function AnyDocProbe() {
    const [result, setResult] = useState("Loading");
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const run = params.has("media")
            ? runMedia()
            : params.has("errors")
              ? runErrors()
              : params.has("formats")
                ? runFormats()
                : fetch("sample.docx")
                      .then((response) => response.blob())
                      .then((blob) =>
                          readOfficeAttachment(
                              new File([blob], "sample.docx", { type: blob.type }),
                          ),
                      )
                      .then((attachment) => JSON.stringify({ markdown: attachment.content }));
        run.then(setResult).catch((error) => setResult(String(error)));
    }, []);
    return <pre id="result">{result}</pre>;
}
