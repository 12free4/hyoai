"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useStore } from "@/hooks/useStore";
import { flushAll, persistenceProblems, saveConflictCopy } from "@/lib/storage/persistence";
import { STORAGE_KEYS } from "@/types/storage";

/** Failed writes stay in memory until retry, explicit copy or reload. */
export function StorageConflictDialog() {
    const t = useTranslations("storage");
    const problems = useStore(persistenceProblems, (s) => s.problems);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [copySaved, setCopySaved] = useState(false);
    const problem = problems.find((problem) => problem.key === selected) ?? problems[0];
    if (!problem) return null;
    const id = problem.key.startsWith(STORAGE_KEYS.conversationPrefix)
        ? problem.key.slice(STORAGE_KEYS.conversationPrefix.length)
        : null;
    const conflict = [
        "REVISION_CONFLICT",
        "ID_COLLISION",
        "STALE_DB_EPOCH",
        "STALE_CONVERSATION_EPOCH",
    ].includes(problem.code);
    const run = async (copy: boolean) => {
        setBusy(true);
        setError(null);
        setCopySaved(false);
        try {
            if (copy && id) {
                await saveConflictCopy(id);
                setCopySaved(true);
                // Keep all conflicts visible until the user explicitly reloads.
            } else await flushAll();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="storage-problem-title"
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6"
        >
            <div className="max-w-lg space-y-4 rounded-lg bg-background p-6 text-foreground shadow-xl">
                <h2 id="storage-problem-title" className="font-semibold">
                    {t(conflict ? "conflict" : "saveFailed")}
                </h2>
                <p>{t("unsaved")}</p>
                {problems.length > 1 && (
                    <select
                        aria-label={t("conflict")}
                        value={problem.key}
                        onChange={(event) => {
                            setSelected(event.target.value);
                            setCopySaved(false);
                        }}
                    >
                        {problems.map((problem) => (
                            <option key={problem.key} value={problem.key}>
                                {problem.key}
                            </option>
                        ))}
                    </select>
                )}
                <p className="text-sm">{problem.message}</p>
                <p className="text-sm">{t("reloadWarning")}</p>
                {error && <p role="alert">{error}</p>}
                {copySaved && <p role="status">{t("copySaved")}</p>}
                <div className="flex flex-wrap gap-3">
                    {!conflict && (
                        <button disabled={busy} onClick={() => void run(false)}>
                            {t("retry")}
                        </button>
                    )}
                    {id && conflict && (
                        <button disabled={busy} onClick={() => void run(true)}>
                            {t("copyReload")}
                        </button>
                    )}
                    <button disabled={busy} onClick={() => window.location.reload()}>
                        {t("reload")}
                    </button>
                </div>
            </div>
        </div>
    );
}
