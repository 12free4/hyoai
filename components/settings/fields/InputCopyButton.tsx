"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { InputGroupButton } from "@/components/ui/input-group";
import { copyText } from "@/lib/clipboard";

/**
 * Copy-to-clipboard icon button meant to sit inside an input's trailing addon,
 * flashing a check for a moment as confirmation. Disabled while the value is
 * empty.
 *
 * @param value - Text copied to the clipboard
 * @param label - Accessible label for the button
 */
export function InputCopyButton({ value, label }: { value: string; label: string }) {
    const t = useTranslations("common");
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        if (!value) return;
        try {
            await copyText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
            toast.error(t("copyFailed"));
        }
    };

    return (
        <InputGroupButton
            size="icon-xs"
            aria-label={label}
            disabled={!value}
            onClick={() => void handleCopy()}
        >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </InputGroupButton>
    );
}
