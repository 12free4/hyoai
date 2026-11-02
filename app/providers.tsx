"use client";

import { NextIntlClientProvider, useTranslations } from "next-intl";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { StorageConflictDialog } from "@/components/chat/view/StorageConflictDialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/hooks/useStore";
import { bootApp, bootEmbed } from "@/lib/boot";
import { onQuotaError } from "@/lib/storage/persistence";
import { bootStore } from "@/lib/stores/boot";
import { localeStore } from "@/lib/stores/locale";
import { themeStore } from "@/lib/stores/theme";
import { openSettings, uiStore } from "@/lib/stores/ui";
import { getEmbedConfig } from "@/lib/url";
import en from "@/messages/en.json";
import fr from "@/messages/fr.json";
import zh from "@/messages/zh.json";

const MESSAGES = { fr, en, zh } as const;

/**
 * Surfaces storage quota failures as a translated toast.
 */
function QuotaWatcher() {
    const t = useTranslations("errors");
    const td = useTranslations("settings.data");
    useEffect(
        () =>
            onQuotaError(() => {
                let id: number | string = 0;
                id = toast.error(
                    <>
                        {t("quotaExceeded")}
                        <button
                            type="button"
                            aria-label={td("storageManage")}
                            className="absolute inset-0 cursor-pointer"
                            onClick={() => {
                                openSettings("data");
                                toast.dismiss(id);
                            }}
                        />
                    </>,
                );
            }),
        [t, td],
    );
    return null;
}

/**
 * Client providers, retryable boot barrier, and the memory-only next-themes bridge.
 *
 * @param children - Application tree
 */
export function Providers({ children }: { children: React.ReactNode }) {
    const locale = useStore(localeStore, (state) => state.locale);
    const [embedConfig] = useState(() => getEmbedConfig());
    const status = useStore(bootStore, (s) => s.status);
    const themeOverride = useStore(uiStore, (s) => s.embedThemeOverride);

    useEffect(() => {
        if (embedConfig) void bootEmbed(embedConfig).catch(() => undefined);
        else void bootApp().catch(() => undefined);
    }, [embedConfig]);

    return (
        <ThemeProvider
            attribute="class"
            defaultTheme="system"
            forcedTheme={themeOverride ?? embedConfig?.theme}
        >
            <ThemeBridge />
            <NextIntlClientProvider
                locale={locale}
                messages={MESSAGES[locale]}
                timeZone="Europe/Paris"
            >
                <TooltipProvider delayDuration={300}>
                    {status === "ready" ? (
                        children
                    ) : (
                        <BootStatus
                            retry={() => {
                                void (embedConfig ? bootEmbed(embedConfig) : bootApp()).catch(
                                    () => undefined,
                                );
                            }}
                        />
                    )}
                </TooltipProvider>
                <StorageConflictDialog />
                <QuotaWatcher />
                <Toaster position="bottom-right" />
            </NextIntlClientProvider>
        </ThemeProvider>
    );
}

function BootStatus({ retry }: { retry: () => void }) {
    const t = useTranslations("storage");
    const state = useStore(bootStore, (s) => s);
    return (
        <div role="status" className="flex h-full flex-col items-center justify-center gap-4 p-6">
            <p>{t(state.status === "error" ? "bootFailed" : "loading")}</p>
            {state.error && <p>{state.error}</p>}
            {state.status === "error" && <button onClick={retry}>{t("retry")}</button>}
        </div>
    );
}

function ThemeBridge() {
    const { setTheme } = useTheme();
    const { theme, ready } = useStore(themeStore, (s) => s);

    const embed = useStore(uiStore, (s) => s.embed);
    useEffect(() => {
        if (ready && !embed) setTheme(theme);
    }, [theme, ready, embed, setTheme]);

    return null;
}
