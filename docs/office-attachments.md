# Office attachments

HYOAI converts Office documents to Markdown locally with
[`@firecrawl/anydoc-wasm`](https://github.com/firecrawl/anydoc) v0.2.5.

## Supported inputs

- Word: DOC, DOCX and macro-enabled DOCM
- PowerPoint: PPT, PPTX, PPS, PPSX, PPTM and PPSM
- Excel: XLS, XLSX, XLSM and XLSB
- OpenDocument: ODT, ODS and ODP
- Rich Text Format: RTF

Format detection uses the file contents first and the extension as a fallback.
The resulting Markdown is stored as an ordinary `kind: "text"` attachment, so
there is no change to the chat API's attachment schema.

## Processing and limits

- Parsing runs in a dedicated Web Worker; document conversion does not block the
  main UI thread.
- A single worker processes a queue of files sequentially.
- Input is limited to 20 MiB per document and extracted Markdown to 4 MiB.
- A worker that does not respond within 120 seconds is terminated and recreated.
- Parsing is local. The integration does not call Firecrawl's hosted Parse API,
  upload document contents, or perform OCR.
- Image-only or scanned documents that need OCR are reported as such and are not
  silently sent to an external service.

## Verification

The unit tests cover extension recognition and error-to-message mapping.
A release acceptance run should additionally parse real DOCX, XLSX, PPTX and
ODT samples in Chrome, check the production Worker/WASM asset path, and confirm
that parsing makes no document-content network requests.
