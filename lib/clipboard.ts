/**
 * Copy text from a user-initiated browser interaction.
 *
 * The Clipboard API is preferred, but it may be unavailable on HTTP origins,
 * denied by permissions, or absent in older browsers. In those cases use the
 * legacy DOM copy command while preserving the previously focused element.
 *
 * @param text - Text to put on the system clipboard
 */
export async function copyText(text: string): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // Permissions and secure-context failures fall through to execCommand.
        }
    }

    if (typeof document === "undefined" || !document.body) {
        throw new Error("Clipboard access is unavailable in this environment");
    }

    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");
    textarea.tabIndex = -1;
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";

    let copied = false;
    try {
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        copied = typeof document.execCommand === "function" && document.execCommand("copy");
    } catch {
        copied = false;
    } finally {
        textarea.remove();
        active?.focus({ preventScroll: true });
    }

    if (!copied) throw new Error("Failed to copy text to the clipboard");
}
