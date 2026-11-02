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
    const networkRequests = [];
    ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.method === "Network.requestWillBeSent")
            networkRequests.push(message.params.request);
    });
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
    await command("Network.enable", {});
    const locale = process.argv[2] || "en";
    await command("Page.navigate", {
        url: `http://127.0.0.1:4117/anydoc-probe/ui/?embed=1&lang=${locale}`,
    });
    const expression = String.raw`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        for (let n = 0; n < 100 && !document.querySelector('#composer-probe input[accept*=".docx"]'); n++) await wait(100);
        const composer = document.querySelector('#composer-probe');
        const editor = document.querySelector('#editor-probe');
        check(composer && editor, 'UI did not load');
        const lang = new URL(location.href).searchParams.get('lang');
        const expected = {
            en: { menu: 'Office documents', processing: 'Processing document', success: 'Document processed', malformed: 'malformed or damaged' },
            fr: { menu: 'Documents Office', processing: 'Traitement du document', success: 'Document traité', malformed: 'invalide ou endommagé' },
            zh: { menu: 'Office 文档', processing: '正在解析文档', success: '文档解析完成', malformed: '文档格式错误或已损坏' },
        }[lang];
        const menuTrigger = composer.querySelector('button:has(svg.lucide-plus)');
        menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        await wait(100);
        check([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.includes(expected.menu)), 'Office menu translation missing');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(50);
        const officeInput = composer.querySelector('input[accept*=".docx"]');
        check(officeInput?.multiple, 'Office picker missing or not multiple');
        const blob = await (await fetch('/anydoc-probe/sample.docx')).blob();
        const makeFile = name => {
            const file = new File([blob], name, { type: '' });
            const read = file.arrayBuffer.bind(file);
            file.arrayBuffer = async () => { await wait(700); return read(); };
            return file;
        };
        const transfer = new DataTransfer();
        transfer.items.add(makeFile('first.docx')); transfer.items.add(makeFile('second.docx'));
        officeInput.files = transfer.files;
        officeInput.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(80);
        const send = composer.querySelector('button:has(svg.lucide-arrow-up)');
        check(composer.querySelector('[role="status"]')?.textContent.includes('2'), 'processing count missing');
        check(composer.querySelector('[role="status"]')?.textContent.includes(expected.processing), 'processing translation incorrect');
        check(send?.disabled, 'send enabled while processing');
        for (let n = 0; n < 100 && composer.querySelector('[role="status"]'); n++) await wait(100);
        check(composer.textContent.includes('first.docx') && composer.textContent.includes('second.docx'), 'multiple selection failed');
        check([...document.querySelectorAll('[data-sonner-toast][data-type="success"]')].some(toast => toast.textContent.includes(expected.success)), 'success translation missing');
        check(!send.disabled, 'send remains disabled');
        composer.querySelector('button:has(svg.lucide-x)').click();
        await wait(50);
        check(!composer.textContent.includes('first.docx') && composer.textContent.includes('second.docx'), 'remove failed');
        send.click(); await wait(50);
        check(JSON.parse(document.querySelector('#submitted').textContent)[0].name === 'second.docx', 'composer submit failed');
        const drop = new DataTransfer(); drop.items.add(makeFile('drop.docx'));
        editor.firstElementChild.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drop }));
        await wait(80);
        const save = [...editor.querySelectorAll('button')].find(button => button.textContent === 'Save');
        check(editor.querySelector('[role="status"]') && save.disabled, 'editor processing guard failed');
        for (let n = 0; n < 100 && editor.querySelector('[role="status"]'); n++) await wait(100);
        check(editor.textContent.includes('drop.docx'), 'editor drop failed');
        const paste = new DataTransfer(); paste.items.add(makeFile('paste.docx'));
        editor.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: paste }));
        await wait(80); check(save.disabled, 'editor paste did not block submit');
        for (let n = 0; n < 100 && editor.querySelector('[role="status"]'); n++) await wait(100);
        check(editor.textContent.includes('paste.docx'), 'editor paste failed');
        editor.querySelector('button:has(svg.lucide-x)').click(); await wait(50);
        save.click(); await wait(50);
        const saved = JSON.parse(document.querySelector('#submitted').textContent);
        check(saved.length === 1 && saved[0].name === 'paste.docx', 'editor save/remove failed');
        const editorInput = editor.querySelector('input[accept*=".docx"]');
        check(editorInput?.multiple, 'editor Office picker missing');
        const mixed = new DataTransfer();
        mixed.items.add(new File(['invalid'], 'bad.docx'));
        mixed.items.add(makeFile('good.docx'));
        editorInput.files = mixed.files;
        editorInput.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(80);
        for (let n = 0; n < 100 && editor.querySelector('[role="status"]'); n++) await wait(100);
        check(editor.textContent.includes('good.docx') && !editor.textContent.includes('bad.docx'), 'failed file blocked another file');
        check([...document.querySelectorAll('[data-sonner-toast][data-type="error"]')].some(toast => toast.textContent.includes(expected.malformed) && toast.textContent.includes('bad.docx')), 'localized document error not reported');
        return 'PASS: multiple selection, processing guards, remove, submit, drop, paste, editor save, failure isolation';
    })()`;
    const result = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    ws.close();
    if (result.exceptionDetails)
        throw new Error(
            result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        );
    if (networkRequests.some((request) => request.method !== "GET" && request.method !== "HEAD"))
        throw new Error("Unexpected non-read network request during attachment processing");
    console.log(result.result.value);
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
