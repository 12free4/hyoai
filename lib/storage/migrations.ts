import { beginStorageHydration } from "@/lib/storage/persistence";
/** Initializes and validates the new IDB schema; never accesses historical storage. */
export async function runMigrations(): Promise<void> {
    await beginStorageHydration();
}
