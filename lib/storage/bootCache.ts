/** These are rendering hints only. Never consult legacy application keys. */
export function cacheBootValue(kind: "skin" | "locale", value: string | null): void {
    try {
        if (value === null) window.localStorage.removeItem(`hyoai:boot:${kind}`);
        else window.localStorage.setItem(`hyoai:boot:${kind}`, value);
    } catch {}
}
