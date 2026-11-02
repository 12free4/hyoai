import { toast } from "sonner";

import { openConversation, refreshStoredConversations, startNewConversation } from "@/lib/actions";
import { onChatAvailabilityChange } from "@/lib/chat/registry";
import { getTranslator } from "@/lib/i18n";
import { setPersistenceGate } from "@/lib/storage/gate";
import { runMigrations } from "@/lib/storage/migrations";
import {
    cancelStorageHydration,
    finishStorageHydration,
    registerLifecycleFlush,
} from "@/lib/storage/persistence";
import { createStorageSync } from "@/lib/storage/sync";
import { invalidateUsage } from "@/lib/storage/usage";
import { bootStore } from "@/lib/stores/boot";
import { applyCompareUrlState, enableCompareUrlSync, hydrateCompare } from "@/lib/stores/compare";
import { hydrateConversations } from "@/lib/stores/conversations";
import { hydrateLocale, setLocale } from "@/lib/stores/locale";
import { initModels, modelsStore, setActiveModel } from "@/lib/stores/models";
import { hydrateSettings, setSkin, settingsStore, updateSettings } from "@/lib/stores/settings";
import { refreshStorage } from "@/lib/stores/storage";
import { hydrateTheme } from "@/lib/stores/theme";
import { setEmbed, uiStore } from "@/lib/stores/ui";
import { type EmbedConfig, getChatIdFromUrl, getCompareFromUrl } from "@/lib/url";
import type { AppSettings } from "@/types/settings";
import { STORAGE_KEYS } from "@/types/storage";

// React strict mode mounts effects twice; boot must run once.
let bootPromise: Promise<void> | null = null;
let storageSync: ReturnType<typeof createStorageSync> | null = null;
function prepareStorageSync(): ReturnType<typeof createStorageSync> {
    if (storageSync) return storageSync;
    let lastError: string | null = null;
    const sync = createStorageSync({
        reconcile: async () => {
            const retry = await refreshStoredConversations();
            lastError = null;
            if (retry) sync.request();
        },
        onRemoteChange: invalidateUsage,
        onThemeHint: () => {
            if (!uiStore.getState().embed)
                void hydrateTheme().catch((error) =>
                    console.warn("hyoai: theme refresh failed", error),
                );
        },
        onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("hyoai: storage synchronization failed", error);
            if (message !== lastError) toast.error(getTranslator("storage")("syncFailed"));
            lastError = message;
        },
    });
    onChatAvailabilityChange(sync.request);
    storageSync = sync;
    return sync;
}
function bootOnce(work: () => Promise<void>): Promise<void> {
    if (bootPromise) return bootPromise;
    bootStore.setState({ status: "loading", error: null });
    bootPromise = work()
        .then(() => {
            bootStore.setState({ status: "ready", error: null });
        })
        .catch((error) => {
            cancelStorageHydration();
            storageSync?.pause();
            bootPromise = null;
            bootStore.setState({
                status: "error",
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        });
    return bootPromise;
}

/**
 * Client boot sequence: migrations, store hydration from IndexedDB, the
 * config.json fetch for the server list, lifecycle flush listeners and the
 * conversation referenced by the URL, or a fresh one to land on.
 */
export function bootApp(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    return bootOnce(async () => {
        setPersistenceGate(null);
        const sync = prepareStorageSync();
        await runMigrations();
        await Promise.all([
            hydrateSettings(),
            hydrateTheme(),
            initModels(),
            hydrateConversations(),
            hydrateCompare(),
        ]);
        await hydrateLocale();
        await finishStorageHydration();
        registerLifecycleFlush();

        const compare = getCompareFromUrl();
        if (compare) applyCompareUrlState(compare);

        const urlChatId = getChatIdFromUrl();
        if (!urlChatId || !(await openConversation(urlChatId))) {
            startNewConversation();
        }

        enableCompareUrlSync();
        await sync.activate();
        void refreshStorage();
    });
}

/**
 * Boot sequence for the embeddable compact widget. A write gate keeps the
 * URL-driven configuration in the in-memory stores only, so it never overwrites
 * the host app's saved preferences (the same origin shares one IndexedDB).
 * The minimal widget drops every write and stays ephemeral; the sidebar variant
 * additionally admits conversation keys, then hydrates the conversation index
 * and opens the URL conversation or a fresh one so its sidebar has history. The
 * theme override uses next-themes forcedTheme without persisting preferences.
 *
 * @param config - Configuration parsed from the embed URL
 */
export function bootEmbed(config: EmbedConfig): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    return bootOnce(async () => {
        const sidebar = Boolean(config.sidebar);
        setEmbed(true, sidebar, Boolean(config.modelLock));
        setPersistenceGate(
            sidebar
                ? (key) =>
                      key === STORAGE_KEYS.conversationsIndex ||
                      key.startsWith(STORAGE_KEYS.conversationPrefix)
                : () => false,
        );

        const sync = sidebar ? prepareStorageSync() : null;
        await runMigrations();
        await initModels();

        if (config.locale) setLocale(config.locale);
        if (config.skin) setSkin(config.skin);

        const patch: Partial<AppSettings> = { sendOnEnterHint: config.sendOnEnterHint ?? false };
        if (config.sampling) {
            patch.sampling = { ...settingsStore.getState().settings.sampling, ...config.sampling };
        }
        if (config.compactInput !== undefined) {
            patch.display = {
                ...settingsStore.getState().settings.display,
                compactInput: config.compactInput,
            };
        }
        if (Object.keys(patch).length > 0) updateSettings(patch);

        if (
            config.modelEntryId &&
            modelsStore.getState().entries.some((entry) => entry.id === config.modelEntryId)
        ) {
            setActiveModel(config.modelEntryId, config.upstreamModel);
        }

        if (sidebar) {
            await hydrateConversations();
            await finishStorageHydration();

            const urlChatId = getChatIdFromUrl();
            if (!urlChatId || !(await openConversation(urlChatId))) startNewConversation();

            registerLifecycleFlush();
            await sync?.activate();
        } else {
            await finishStorageHydration();
        }
    });
}
