import type { ChatInstance } from "@/lib/chat/instance";

const instances = new Set<ChatInstance>();
const listeners = new Set<() => void>();
function changed(): void {
    for (const listener of listeners) listener();
}
export function liveChatInstances(): ChatInstance[] {
    return [...instances];
}
export function registerChatInstance(instance: ChatInstance): () => void {
    instances.add(instance);
    let busy = instance.isStorageBusy();
    const unsubscribe = instance.store.subscribe(() => {
        const next = instance.isStorageBusy();
        if (next !== busy) {
            busy = next;
            changed();
        }
    });
    changed();
    return () => {
        unsubscribe();
        instances.delete(instance);
        changed();
    };
}
export function onChatAvailabilityChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
