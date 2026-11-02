let gate: ((key: string) => boolean) | null = null;
let suppressed = 0;
export function setPersistenceGate(value: ((key: string) => boolean) | null): void {
    gate = value;
}
export function isPersistenceAllowed(key: string): boolean {
    return suppressed === 0 && (gate === null || gate(key));
}

export function withoutPersistence(work: () => void): void {
    suppressed++;
    try {
        work();
    } finally {
        suppressed--;
    }
}

export function canClearStorage(scope: "all" | "conversations"): boolean {
    return (
        isPersistenceAllowed("conversations:index") &&
        isPersistenceAllowed("conversation:permission-check") &&
        (scope === "conversations" || isPersistenceAllowed("meta"))
    );
}
