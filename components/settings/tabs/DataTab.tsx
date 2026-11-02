"use client";

import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ExportDialog } from "@/components/settings/dialogs/ExportDialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useStore } from "@/hooks/useStore";
import { clearApplicationStorage } from "@/lib/actions";
import { formatBytes } from "@/lib/format";
import { canClearStorage } from "@/lib/storage/gate";
import { buildExport, parseImport } from "@/lib/storage/io";
import { parseLlamaCppExport } from "@/lib/storage/llamacpp";
import { storageOperationStore } from "@/lib/storage/persistence";
import { conversationsStore } from "@/lib/stores/conversations";
import { refreshStorage, STORAGE_WARN_RATIO, storageStore, usageRatio } from "@/lib/stores/storage";
import { uiStore } from "@/lib/stores/ui";
import { applyImport } from "@/lib/transfer";
import { cn } from "@/lib/utils";
import type { ExportFile } from "@/types/storage";

/**
 * Parse an imported file as a native export first, then as a llama.cpp
 * webui conversations export.
 *
 * @param text - Raw file content
 * @returns Importable export file, or the native-format error message
 */
function parseAnyImport(
    text: string,
): { ok: true; data: ExportFile } | { ok: false; error: string } {
    const native = parseImport(text);
    if (native.ok) return native;
    try {
        const conversations = parseLlamaCppExport(JSON.parse(text));
        if (conversations) {
            return { ok: true, data: buildExport({ conversations }) };
        }
    } catch {
        // not JSON at all; keep the native parser message
    }
    return native;
}

/**
 * Data management tab: selective JSON export (native or llama.cpp webui
 * format), import of both formats, a local storage meter with the full,
 * scrollable per-conversation breakdown and a confirmed clear-all action.
 */
export function DataTab() {
    const t = useTranslations("settings");
    const tc = useTranslations("common");
    const ts = useTranslations("sidebar");
    const locale = useLocale();
    const [exportOpen, setExportOpen] = useState(false);
    const [importing, setImporting] = useState(false);
    const [clearDialog, setClearDialog] = useState<"all" | "conversations" | null>(null);
    const clearing = useStore(storageOperationStore, (s) => s.clearing);
    const embed = useStore(uiStore, (s) => s.embed);
    const usage = useStore(storageStore, (state) => state.usage);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        void refreshStorage();
    }, []);

    const handleImport = async (file: File) => {
        if (importing) return;
        setImporting(true);
        try {
            const parsed = parseAnyImport(await file.text());
            if (!parsed.ok) {
                toast.error(t("data.importError", { error: parsed.error }));
                return;
            }
            const result = await applyImport(parsed.data);
            toast.success(t("data.importSuccess", { conversations: result.conversations }));
        } catch (error) {
            const count = (error as { importedConversations?: number })?.importedConversations ?? 0;
            toast.error(
                t("data.importPartial", {
                    count,
                    error: error instanceof Error ? error.message : String(error),
                }),
            );
        } finally {
            setImporting(false);
        }
    };

    const handleClear = async (scope: "all" | "conversations") => {
        if (clearing) return;
        try {
            await clearApplicationStorage(scope);
            setClearDialog(null);
            toast.success(t("data.clearSuccess"));
        } catch (error) {
            toast.error(
                t("data.clearFailed", {
                    error: error instanceof Error ? error.message : String(error),
                }),
            );
        }
    };

    const ratio = usageRatio(usage);
    const usedPercent = Math.min(100, ratio * 100);
    const nearFull = ratio >= STORAGE_WARN_RATIO;
    const titleOf = (id: string) =>
        conversationsStore.getState().index.find((meta) => meta.id === id)?.title || ts("untitled");

    return (
        <div className="space-y-5">
            <section className="space-y-3">
                <h3 className="text-sm font-medium">{t("data.exportTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("data.exportDescription")}</p>
                <Button type="button" variant="outline" onClick={() => setExportOpen(true)}>
                    <Download aria-hidden="true" />
                    {t("data.exportOpen")}
                </Button>
                <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
            </section>
            <Separator />
            <section className="space-y-3">
                <h3 className="text-sm font-medium">{t("data.importTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("data.importDescription")}</p>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handleImport(file);
                        event.target.value = "";
                    }}
                />
                <Button
                    type="button"
                    variant="outline"
                    disabled={importing}
                    onClick={() => fileInputRef.current?.click()}
                >
                    {importing ? (
                        <Loader2 aria-hidden="true" className="animate-spin" />
                    ) : (
                        <Upload aria-hidden="true" />
                    )}
                    {importing ? t("data.importing") : t("data.importFile")}
                </Button>
            </section>
            <Separator />
            <section className="space-y-3">
                <h3 className="text-sm font-medium">{t("data.storageTitle")}</h3>
                <Progress value={usedPercent} />
                {usage && (
                    <p className="text-xs text-muted-foreground">
                        {t("data.logicalUsage", {
                            size: formatBytes(usage.logicalBytes ?? 0, locale),
                        })}
                    </p>
                )}
                {usage && usage.quotaBytes > 0 && (
                    <p
                        className={cn(
                            "text-xs",
                            nearFull ? "text-destructive" : "text-muted-foreground",
                        )}
                    >
                        {t("data.storageUsage", {
                            used: formatBytes(usage.usedBytes, locale),
                            quota: formatBytes(usage.quotaBytes, locale),
                        })}
                        {nearFull && ` — ${t("data.storageNearFull")}`}
                    </p>
                )}
                {usage && usage.conversations.length > 0 && (
                    <ul className="max-h-40 space-y-1 overflow-y-auto pr-1 text-xs text-muted-foreground">
                        {usage.conversations.map((entry) => (
                            <li key={entry.id} className="flex justify-between gap-3">
                                <span className="truncate">{titleOf(entry.id)}</span>
                                <span className="shrink-0 tabular-nums">
                                    {formatBytes(entry.bytes, locale)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="text-xs text-muted-foreground">
                    {t(usage ? "data.storageHint" : "data.storagePending")}
                </p>
            </section>
            <Separator />
            <section className="flex flex-wrap gap-3">
                {(embed ? (["conversations"] as const) : (["conversations", "all"] as const)).map(
                    (scope) => (
                        <AlertDialog
                            key={scope}
                            open={clearDialog === scope}
                            onOpenChange={(open) => {
                                if (!clearing) setClearDialog(open ? scope : null);
                            }}
                        >
                            <AlertDialogTrigger asChild>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    disabled={
                                        Boolean(clearing) || importing || !canClearStorage(scope)
                                    }
                                >
                                    <Trash2 aria-hidden="true" />
                                    {t(
                                        scope === "all"
                                            ? "data.clearAll"
                                            : "data.clearConversations",
                                    )}
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>
                                        {t(
                                            scope === "all"
                                                ? "data.clearAllTitle"
                                                : "data.clearConversationsTitle",
                                        )}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                        {t(
                                            scope === "all"
                                                ? "data.clearAllDescription"
                                                : "data.clearConversationsDescription",
                                        )}
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel disabled={Boolean(clearing)}>
                                        {tc("cancel")}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                        variant="destructive"
                                        disabled={Boolean(clearing)}
                                        onClick={(event) => {
                                            event.preventDefault();
                                            void handleClear(scope);
                                        }}
                                    >
                                        {clearing ? (
                                            <Loader2 className="animate-spin" aria-hidden="true" />
                                        ) : null}
                                        {tc("delete")}
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    ),
                )}
            </section>
        </div>
    );
}
