import { IndexedDBStorage } from "@/lib/storage/indexeddb";

/** Shared connection to the independent IndexedDB database. */
export const indexedDBStorage = new IndexedDBStorage();
