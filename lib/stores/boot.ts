import { createStore } from "@/lib/store";
export const bootStore = createStore<{
    status: "loading" | "ready" | "error";
    error: string | null;
}>({ status: "loading", error: null });
