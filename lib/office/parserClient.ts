import { OfficeParseError } from "./types";
import type { ParseResponse } from "./types";

type Task = {
    id: number;
    file: File;
    extension: string;
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
};
let worker: Worker | undefined;
let active: Task | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const queue: Task[] = [];
let nextId = 0;

function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
}

function failWorker(message: string): void {
    clearTimer();
    if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
    }
    worker = undefined;
    const error = new OfficeParseError({ code: "worker", message });
    active?.reject(error);
    active = undefined;
    void startNext();
}

async function startNext(): Promise<void> {
    if (active || queue.length === 0) return;
    const task = queue.shift()!;
    active = task;
    let bytes: ArrayBuffer;
    try {
        bytes = await task.file.arrayBuffer();
    } catch (error) {
        if (active !== task) return;
        task.reject(
            new OfficeParseError({
                code: "worker",
                message: `Could not read document: ${String(error)}`,
            }),
        );
        active = undefined;
        void startNext();
        return;
    }
    if (active !== task) return;
    try {
        if (!worker) {
            worker = new Worker(new URL("./parser.worker.ts", import.meta.url));
            worker.onmessage = (event: MessageEvent<ParseResponse>) => {
                if (
                    !active ||
                    !event.data ||
                    event.data.id !== active.id ||
                    !("error" in event.data || typeof event.data.markdown === "string")
                ) {
                    failWorker("Unexpected document worker response");
                    return;
                }
                if ("error" in event.data && event.data.error.code === "worker") {
                    failWorker(event.data.error.message);
                    return;
                }
                clearTimer();
                const completed = active;
                active = undefined;
                if ("error" in event.data) completed.reject(new OfficeParseError(event.data.error));
                else completed.resolve(event.data.markdown);
                void startNext();
            };
            worker.onerror = (event) => failWorker(event.message || "Document worker failed");
            worker.onmessageerror = () => failWorker("Could not read document worker response");
        }
        timer = setTimeout(() => failWorker("Document worker did not respond"), 120_000);
        worker.postMessage({ id: task.id, bytes, extension: task.extension }, [bytes]);
    } catch (error) {
        failWorker(error instanceof Error ? error.message : String(error));
    }
}

export function parseOfficeFile(file: File, extension: string): Promise<string> {
    return new Promise((resolve, reject) => {
        queue.push({ id: ++nextId, file, extension, resolve, reject });
        void startNext();
    });
}
