import { IndexedDBStorageError } from "@/lib/storage/indexeddbAdapter";
import { buildExport, remapConversationIds } from "@/lib/storage/io";
import { toLlamaCppExport } from "@/lib/storage/llamacpp";
import {
    createImportedConversation,
    flushAll,
    readConversationForEditor,
} from "@/lib/storage/persistence";
import { conversationsStore, upsertMeta } from "@/lib/stores/conversations";
import { settingsStore, updateSettings } from "@/lib/stores/settings";
import { refreshStorage } from "@/lib/stores/storage";
import type { Conversation } from "@/types/chat";
import type { ExportFile } from "@/types/storage";

/**
 * Assemble the full Conversation shape (meta plus data) of one stored
 * conversation.
 *
 * @param id - Conversation id
 * @returns null when the meta or payload is missing
 */
async function loadFullConversation(id: string): Promise<Conversation | null> {
    const read = await readConversationForEditor(id);
    return read ? { ...read.metadata, ...read.data, id } : null;
}

/**
 * Build an export file for a single conversation.
 *
 * @param id - Conversation id
 */
export async function exportOneConversation(id: string): Promise<ExportFile | null> {
    await flushAll();
    const conversation = await loadFullConversation(id);
    if (!conversation) return null;
    return buildExport({ conversations: [conversation] });
}

/**
 * Load the full shape of several conversations, skipping unreadable ones.
 *
 * @param ids - Conversation ids to load
 */
async function loadFullConversations(ids: string[]): Promise<Conversation[]> {
    await flushAll();
    const conversations: Conversation[] = [];
    for (const id of ids) {
        const conversation = await loadFullConversation(id);
        if (conversation) conversations.push(conversation);
    }
    return conversations;
}

/**
 * Build an export file with the given conversations and, optionally, the
 * settings.
 *
 * @param ids - Conversation ids to include
 * @param options - What to include beyond conversations
 */
export async function exportConversations(
    ids: string[],
    options: { includeSettings: boolean },
): Promise<ExportFile> {
    return buildExport({
        conversations: await loadFullConversations(ids),
        settings: options.includeSettings ? settingsStore.getState().settings : undefined,
    });
}

/**
 * Build a llama.cpp webui compatible export of the given conversations,
 * importable from its Settings data section.
 *
 * @param ids - Conversation ids to include
 */
export async function exportConversationsLlamaCpp(ids: string[]): Promise<unknown[]> {
    return toLlamaCppExport(await loadFullConversations(ids));
}

/**
 * Build an export file with all conversations and, optionally, the settings.
 *
 * @param options - What to include beyond conversations
 */
export async function exportEverything(options: { includeSettings: boolean }): Promise<ExportFile> {
    const ids = conversationsStore.getState().index.map((meta) => meta.id);
    return exportConversations(ids, options);
}

/**
 * Apply a validated import file: conversations are id-remapped on collision
 * and written to storage, settings are replaced when present.
 *
 * @param file - Parsed and validated export file
 * @returns Counts of imported entities
 */
export async function applyImport(
    file: ExportFile,
): Promise<{ conversations: number; settings: boolean }> {
    let importedConversations = 0;
    try {
        if (file.conversations) {
            const existingIds = new Set(conversationsStore.getState().index.map((m) => m.id));
            for (const incoming of file.conversations) {
                let conversation = remapConversationIds(incoming, existingIds);
                let saved = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const { rootId, currNode, nodes, compaction, ...meta } = conversation;
                    try {
                        await createImportedConversation(meta, {
                            id: conversation.id,
                            rootId,
                            currNode,
                            nodes,
                            compaction,
                        });
                        upsertMeta(meta, false);
                        existingIds.add(conversation.id);
                        importedConversations++;
                        saved = true;
                        break;
                    } catch (error) {
                        if (
                            !(error instanceof IndexedDBStorageError) ||
                            error.code !== "ID_COLLISION"
                        )
                            throw error;
                        existingIds.add(conversation.id);
                        conversation = remapConversationIds(conversation, existingIds);
                    }
                }
                if (!saved) throw new Error("Could not allocate a conversation id");
            }
        }

        if (file.settings) {
            updateSettings(file.settings);
        }

        await flushAll();
        void refreshStorage();
        return {
            conversations: importedConversations,
            settings: Boolean(file.settings),
        };
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
            importedConversations,
        });
    }
}

/**
 * Trigger a browser download of a JSON payload.
 *
 * @param filename - Suggested file name
 * @param data - JSON-serializable value
 */
export function downloadJson(filename: string, data: unknown): void {
    if (typeof document === "undefined") return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}
