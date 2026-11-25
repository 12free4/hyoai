/**
 * Read cryptographically secure random bytes.
 * getRandomValues is available in insecure browser contexts even when randomUUID is not.
 */
function secureRandomBytes(length: number): Uint8Array {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
        throw new Error("A cryptographically secure random number generator is required");
    }
    return cryptoApi.getRandomValues(new Uint8Array(length));
}

/**
 * Generate an RFC 4122 UUID version 4. Use randomUUID when available and
 * construct the same format from getRandomValues otherwise.
 *
 * @returns A cryptographically random UUID v4
 */
export function newId(): string {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

    const bytes = secureRandomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Alphabet of tool call ids: letters and digits only, which every chat template accepts.
const CALL_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate an id for a tool call the server left unnamed: nine letters and
 * digits, the only shape some chat templates (Mistral) accept.
 *
 * @returns A 9-character alphanumeric id
 */
export function newCallId(): string {
    const bytes = secureRandomBytes(9);
    return Array.from(bytes, (byte) => CALL_ID_ALPHABET[byte % CALL_ID_ALPHABET.length]).join("");
}
