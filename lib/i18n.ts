import { type AbstractIntlMessages, createTranslator } from "next-intl";

import { getInstalledPlugins } from "@/lib/plugins/registry";
import { localeStore } from "@/lib/stores/locale";
import zh from "@/messages/zh.json";

const CORE_MESSAGES = { zh } as const;

/**
 * Build the Chinese core catalog and mount each installed plugin's Chinese
 * messages. A plugin without a Chinese catalog may expose its English strings
 * as a fallback; the application chrome itself remains Chinese-only.
 */
function catalogFor(): AbstractIntlMessages {
    const plugins: AbstractIntlMessages = {};
    for (const plugin of getInstalledPlugins()) {
        const catalog = plugin.messages?.zh ?? plugin.messages?.en;
        if (catalog) plugins[plugin.id] = catalog;
    }
    return { ...CORE_MESSAGES.zh, plugins };
}

export const MESSAGES: Record<"zh", AbstractIntlMessages> = {
    zh: catalogFor(),
};

/**
 * Build a translator for non-React modules that cannot call useTranslations.
 *
 * @param namespace - Top-level catalog namespace
 * @returns A translator backed by the Chinese catalog
 */
export function getTranslator<const Namespace extends keyof typeof zh>(namespace: Namespace) {
    return createTranslator({ locale: "zh", messages: CORE_MESSAGES.zh, namespace });
}

/**
 * Translate a full catalog key, including plugin keys.
 *
 * @param key - Dotted catalog key
 * @param values - Message placeholders
 * @returns The translated string, or null when the key is absent
 */
export function translateKey(key: string, values?: Record<string, string | number>): string | null {
    const { locale } = localeStore.getState();
    const t = createTranslator({ locale, messages: MESSAGES[locale] }) as unknown as {
        (key: string, values?: Record<string, string | number>): string;
        has(key: string): boolean;
    };
    return t.has(key) ? t(key, values) : null;
}
