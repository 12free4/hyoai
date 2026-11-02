"use client";
import { useStore } from "@/hooks/useStore";
import { setTheme, themeStore } from "@/lib/stores/theme";
export function useTheme() {
    const theme = useStore(themeStore, (s) => s.theme);
    return {
        theme,
        setTheme: (value: string) => {
            void setTheme(value).catch(() => undefined);
        },
    };
}
