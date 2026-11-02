/**
 * Error thrown when a storage write fails because the backend quota is exhausted.
 * Carries the offending key so callers can surface which payload did not fit.
 */
export class StorageQuotaError extends Error {
    key?: string;

    /**
     * Create a quota error for a failed storage write.
     *
     * @param message - Human readable description of the failure
     * @param key - Storage key whose write exceeded the quota
     */
    constructor(message: string, key?: string) {
        super(message);
        this.name = "StorageQuotaError";
        this.key = key;
    }
}

/** Formal writes require epoch context and return transaction receipts. */
export type { IndexedDBStorageAdapter as StorageAdapter } from "@/lib/storage/indexeddbAdapter";

/**
 * Reversible string transform applied between the persistence layer and the
 * storage adapter, used to compress large payloads transparently.
 */
export interface Codec {
    /**
     * Transform a plain string into its stored representation.
     *
     * @param value - Plain string to encode
     */
    encode(value: string): string;

    /**
     * Transform a stored representation back into the plain string.
     *
     * @param value - Stored string to decode
     */
    decode(value: string): string;
}
