import {
    activeInstance,
    defaultChat,
    releaseFromForeground,
    resetForegroundConversations,
    setActiveConversation,
    startNewForeground,
} from "@/lib/chat/foreground";
import type { ChatInstance } from "@/lib/chat/instance";
import { resetPaneConversations } from "@/lib/chat/panes";
import { liveChatInstances } from "@/lib/chat/registry";
import { withoutPersistence } from "@/lib/storage/gate";
import {
    clearStorage,
    deleteConversation as deleteConversationPayload,
    reconcileConversations,
} from "@/lib/storage/persistence";
import { conversationsStore, removeMeta } from "@/lib/stores/conversations";
import { refreshStorage } from "@/lib/stores/storage";

// The default chat instance is re-exported for the historic import sites.
export { defaultChat };

/**
 * Forward each historic free-function action to whichever instance is currently
 * in the foreground, so the many existing call sites keep working while the
 * active conversation can now move between several live instances. Each wrapper
 * is typed from its instance method, preserving the exact signature.
 */
export const sendMessage: ChatInstance["sendMessage"] = (...args) =>
    activeInstance().sendMessage(...args);
export const regenerate: ChatInstance["regenerate"] = (...args) =>
    activeInstance().regenerate(...args);
export const editUserMessage: ChatInstance["editUserMessage"] = (...args) =>
    activeInstance().editUserMessage(...args);
export const editAssistantMessage: ChatInstance["editAssistantMessage"] = (...args) =>
    activeInstance().editAssistantMessage(...args);
export const forkConversation: ChatInstance["forkConversation"] = (...args) =>
    activeInstance().forkConversation(...args);
export const setConversationSystemPrompt: ChatInstance["setConversationSystemPrompt"] = (...args) =>
    activeInstance().setConversationSystemPrompt(...args);
export const switchBranch: ChatInstance["switchBranch"] = (...args) =>
    activeInstance().switchBranch(...args);
export const deleteMessageBranch: ChatInstance["deleteMessageBranch"] = (...args) =>
    activeInstance().deleteMessageBranch(...args);
export const stopGeneration: ChatInstance["stopGeneration"] = (...args) =>
    activeInstance().stopGeneration(...args);

/**
 * Opening / starting a conversation goes through the foreground registry so the
 * previous conversation keeps generating in the background.
 */
export const openConversation = setActiveConversation;
export const startNewConversation = startNewForeground;

/**
 * Reflect a cross-tab conversation change on the active instance: reload the
 * open conversation from storage when it is the one that changed and idle.
 *
 * @param id - Conversation id another tab reported changed
 */
export function reloadActiveConversation(id: string): void {
    void activeInstance().reloadConversation(id);
}

/**
 * Open a conversation and scroll to a specific node, e.g. from a search result.
 * The node is revealed on the now-foreground instance once it has loaded.
 *
 * @param id - Conversation id
 * @param nodeId - Node to reveal once the conversation is active
 * @param term - Matched text to flash inside the node
 */
export async function openConversationAtNode(
    id: string,
    nodeId: string,
    term: string,
): Promise<void> {
    const ok = await setActiveConversation(id);
    if (ok) activeInstance().revealNode(nodeId, term);
}

/**
 * Delete a conversation from the index and storage. Its live instance, if any,
 * is aborted and dropped first so a trailing write cannot resurrect the key;
 * when it was the active one, the view resets to a fresh conversation.
 *
 * @param id - Conversation id
 */
export async function deleteConversationById(id: string): Promise<void> {
    for (const instance of liveChatInstances()) {
        if (instance.store.getState().conversationId === id) instance.stopGeneration();
    }
    await deleteConversationPayload(id);
    withoutPersistence(() => {
        releaseFromForeground(id);
        resetPaneConversations(id);
    });
    removeMeta(id);
    void refreshStorage();
}

export async function clearApplicationStorage(scope: "all" | "conversations"): Promise<void> {
    await clearStorage(scope, () => {
        const instances = liveChatInstances();
        const ids = instances
            .map((instance) => instance.store.getState().conversationId)
            .filter((id): id is string => id !== null);
        for (const instance of instances) instance.stopGeneration();
        return ids;
    });
    withoutPersistence(() => {
        resetPaneConversations();
        resetForegroundConversations();
    });
    conversationsStore.setState({ index: [], hydrated: true });
    void refreshStorage();
    if (scope === "all" && typeof window !== "undefined") {
        for (const key of ["hyoai:boot:skin", "hyoai:boot:locale"]) {
            try {
                window.localStorage.removeItem(key);
            } catch {}
        }
        window.location.reload();
    }
}

/** Returns whether a local commit raced the snapshot and needs another pass. */
export async function refreshStoredConversations(): Promise<boolean> {
    const result = await reconcileConversations(() => {
        const live = liveChatInstances();
        return {
            liveIds: new Set(
                live
                    .map((i) => i.store.getState().conversationId)
                    .filter((id): id is string => id !== null),
            ),
            busyIds: new Set(
                live
                    .filter((i) => i.isStorageBusy())
                    .map((i) => i.store.getState().conversationId)
                    .filter((id): id is string => id !== null),
            ),
        };
    });
    if (!result) return false;
    if (result.retry && result.blocked) return true;
    conversationsStore.setState({ index: result.index, hydrated: true });
    if (result.blocked) return result.retry;
    if (result.resetConversations)
        withoutPersistence(() => {
            resetPaneConversations();
            resetForegroundConversations();
        });
    else
        for (const id of result.removed)
            withoutPersistence(() => {
                releaseFromForeground(id);
                resetPaneConversations(id);
            });
    await Promise.all(
        liveChatInstances().map(async (instance) => {
            const id = instance.store.getState().conversationId;
            if (id && result.changed.includes(id)) await instance.reloadConversation(id);
        }),
    );
    void refreshStorage();
    return result.retry;
}
