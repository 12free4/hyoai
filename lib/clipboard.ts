/** Copy text during a browser interaction, falling back for older or insecure contexts. */
export async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // Try the legacy browser copy command below.
        }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";

    try {
        document.body.appendChild(textarea);
        textarea.focus();
		textarea.select();
		textarea.setSelectionRange(0, textarea.value.length);
        if (document.execCommand("copy")) return;
    } catch {
        // Report a consistent error for all fallback failures.
    } finally {
        textarea.remove();
    }

    throw new Error("Failed to copy text to the clipboard");
}
