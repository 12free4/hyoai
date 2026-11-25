import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import zh from "@/messages/zh.json";

/**
 * Flatten a nested message catalog into dotted key paths.
 */
function flatten(node: unknown, prefix = ""): string[] {
    if (typeof node !== "object" || node === null) return [prefix];
    return Object.entries(node).flatMap(([key, value]) =>
        flatten(value, prefix ? `${prefix}.${key}` : key),
    );
}

describe("Chinese message catalog", () => {
    const zhKeys = new Set(flatten(zh));
    const enKeys = new Set(flatten(en));

    it("contains every key in the upstream English source catalog", () => {
        expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([]);
    });

    it("does not contain obsolete keys absent from the upstream catalog", () => {
        expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([]);
    });
});
