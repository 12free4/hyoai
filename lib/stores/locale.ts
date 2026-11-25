import { createStore } from "@/lib/store";
import type { Locale } from "@/types/settings";

const DEFAULT_LOCALE: Locale = "zh";

interface LocaleState {
    locale: Locale;
}

export const localeStore = createStore<LocaleState>({ locale: DEFAULT_LOCALE });

/**
 * Fix the interface language to Simplified Chinese.
 *
 * The locale is deliberately not persisted: browser language, old preferences,
 * embed URLs and host messages must not switch the application back to English
 * or French.
 */
export async function hydrateLocale(): Promise<void> {
    if (typeof document === "undefined") return;
    localeStore.setState({ locale: DEFAULT_LOCALE });
    document.documentElement.lang = "zh-CN";
}

/**
 * Retained for internal callers that explicitly select the sole supported locale.
 */
export function setLocale(_locale: Locale): void {
    localeStore.setState({ locale: DEFAULT_LOCALE });
    if (typeof document !== "undefined") document.documentElement.lang = "zh-CN";
}
