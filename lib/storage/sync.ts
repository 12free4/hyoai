import { onStorageCommit, type StorageCommit } from "@/lib/storage/events";

const CHANNEL = "hyoai:storage:v1";
interface Message {
    version: 1;
    sender: string;
    sequence: number;
    change: StorageCommit;
}
function string(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
export function parseStorageMessage(value: unknown): Message | null {
    if (!value || typeof value !== "object") return null;
    const message = value as Partial<Message>;
    if (
        message.version !== 1 ||
        !string(message.sender) ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence! < 1
    )
        return null;
    const change = message.change;
    if (!change || typeof change !== "object") return null;
    if (change.kind === "kv") {
        if (!string(change.key) || !string(change.dbEpoch)) return null;
    } else {
        if (
            !change.epoch ||
            !string(change.epoch.dbEpoch) ||
            !string(change.epoch.conversationEpoch)
        )
            return null;
        if (change.kind === "reset") {
            if (change.scope !== "all" && change.scope !== "conversations") return null;
        } else if (change.kind === "conversation") {
            if (
                !string(change.id) ||
                !Number.isSafeInteger(change.revision) ||
                change.revision < 1 ||
                typeof change.deleted !== "boolean"
            )
                return null;
        } else return null;
    }
    return message as Message;
}

/** Broadcasts are hints, not data. Reconciliation always reads the database. */
export function createStorageSync(options: {
    reconcile: () => Promise<void>;
    onError: (error: unknown) => void;
    onThemeHint?: () => void;
    onRemoteChange?: () => void;
    channelFactory?: (name: string) => BroadcastChannel;
}) {
    const sender = crypto.randomUUID();
    let sequence = 0,
        ready = false,
        disposed = false,
        running = false,
        requested = false;
    let themeHint = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let channel: BroadcastChannel | null = null;
    const seen = new Map<string, number>();
    function request(): void {
        requested = true;
        if (!ready || disposed || running || timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            void drain();
        }, 50);
    }
    async function drain(): Promise<void> {
        if (disposed || !ready || running) return;
        running = true;
        try {
            while (requested && !disposed && ready) {
                requested = false;
                try {
                    if (themeHint) {
                        themeHint = false;
                        options.onThemeHint?.();
                    }
                    await options.reconcile();
                } catch (error) {
                    options.onError(error);
                }
            }
        } finally {
            running = false;
        }
    }
    function connect(): void {
        if (disposed || channel) return;
        try {
            channel = options.channelFactory
                ? options.channelFactory(CHANNEL)
                : new BroadcastChannel(CHANNEL);
            channel.onmessage = (event) => {
                if (disposed) return;
                const message = parseStorageMessage(event.data);
                if (
                    !message ||
                    message.sender === sender ||
                    message.sequence <= (seen.get(message.sender) ?? 0)
                )
                    return;
                options.onRemoteChange?.();
                seen.set(message.sender, message.sequence);
                if (seen.size > 256) seen.delete(seen.keys().next().value!);
                if (message.change.kind === "kv") {
                    if (message.change.key === "theme") themeHint = true;
                }
                request();
            };
            channel.onmessageerror = () => request();
        } catch {
            channel = null; /* Focus/pageshow reconciliation remains available. */
        }
    }
    connect();
    const unsubscribe = onStorageCommit((change) => {
        if (!channel) connect();
        try {
            channel?.postMessage({
                version: 1,
                sender,
                sequence: ++sequence,
                change,
            } satisfies Message);
        } catch {
            channel?.close();
            channel = null;
        }
        if (change.kind !== "kv") request();
    });
    const restore = () => {
        connect();
        themeHint = true;
        request();
    };
    const visible = () => {
        if (document.visibilityState === "visible") restore();
    };
    const hide = () => {
        channel?.close();
        channel = null;
    };
    if (typeof window !== "undefined") {
        window.addEventListener("focus", restore);
        window.addEventListener("pageshow", restore);
        window.addEventListener("pagehide", hide);
        document.addEventListener("visibilitychange", visible);
    }
    return {
        request,
        async activate(): Promise<void> {
            ready = true;
            requested = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            await drain();
        },
        pause(): void {
            ready = false;
        },
        dispose(): void {
            disposed = true;
            unsubscribe();
            if (timer !== null) clearTimeout(timer);
            channel?.close();
            channel = null;
            if (typeof window !== "undefined") {
                window.removeEventListener("focus", restore);
                window.removeEventListener("pageshow", restore);
                window.removeEventListener("pagehide", hide);
                document.removeEventListener("visibilitychange", visible);
            }
        },
    };
}
