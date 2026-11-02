import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hyoai-anydoc-"));
const chrome = spawn(
    process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${temp}`,
        "about:blank",
    ],
    { stdio: "ignore" },
);
try {
    let port;
    for (let i = 0; i < 100; i++) {
        try {
            port = fs.readFileSync(path.join(temp, "DevToolsActivePort"), "utf8").split("\n")[0];
            break;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    if (!port) throw new Error("Chrome debugging port unavailable");
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const ws = new WebSocket(
        pages.find((page) => page.type === "page" && page.url === "about:blank")
            .webSocketDebuggerUrl,
    );
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let id = 0;
    const command = (method, params) =>
        new Promise((resolve, reject) => {
            const requestId = ++id;
            const listener = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.id !== requestId) return;
                ws.removeEventListener("message", listener);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            };
            ws.addEventListener("message", listener);
            ws.send(JSON.stringify({ id: requestId, method, params }));
        });
    await command("Page.navigate", {
        url: process.argv[2] || "http://127.0.0.1:4117/anydoc-probe/",
    });
    let value;
    for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const result = await command("Runtime.evaluate", {
            expression: "document.querySelector('#result')?.textContent",
            returnByValue: true,
        });
        value = result.result.value;
        if (value && value !== "Loading") break;
    }
    if (!value) {
        const diagnostic = await command("Runtime.evaluate", {
            expression: "document.body?.innerText",
            returnByValue: true,
        });
        console.error("Page did not show a result:", diagnostic.result.value);
    }
    ws.close();
    console.log(value);
    if (
        process.argv[2]?.includes("formats") ||
        process.argv[2]?.includes("errors") ||
        process.argv[2]?.includes("media")
    ) {
        if (JSON.parse(value).status !== "PASS") throw new Error("Format conversion failed");
    } else if (
        !value?.includes("AnyDoc compatibility test") ||
        !value.includes("bold text") ||
        !value.includes("Name")
    ) {
        throw new Error("DOCX conversion failed");
    }
} finally {
    if (chrome.exitCode === null && chrome.signalCode === null) {
        const exited = new Promise((resolve) => chrome.once("exit", resolve));
        chrome.kill();
        await exited;
    }
    try {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
}
