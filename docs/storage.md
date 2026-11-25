# Browser storage

## Primary application data

HYOAI stores its application key/value records in the `hyoai-global` IndexedDB
database, in the `kv` object store. Existing persistence call sites keep the
same asynchronous adapter interface, so conversation, model, project, settings
and compare data continue to use the current schema and codecs.

The Project Documents feature keeps its existing, separate `lc-documents`
database. It is not overwritten by the global storage change.

## First-run migration

On first open, the adapter copies every existing `lc:*` localStorage entry
into IndexedDB in one read/write transaction. The migration marker is committed
in that same transaction, so an interrupted migration is retried atomically.
The original localStorage entries are retained as a rollback backup and are
not read again after the marker is set. An explicit Clear all action removes
both the IndexedDB records and that legacy backup.

The migration does not import data from the older standalone `hyoai` database
used by the previous custom IndexedDB branch. That database is left untouched;
migrating its different schema and conversation revision model is a separate
operation.

## Compatibility and synchronization

The skin and animation preference keys are mirrored to localStorage only for
the pre-paint script. IndexedDB remains authoritative for application state.
Same-origin tabs announce committed key changes over BroadcastChannel, with a
small localStorage signal as a fallback where BroadcastChannel is unavailable.
The embed persistence gate still applies to ordinary writes.

The storage meter uses `navigator.storage.estimate()` for origin-wide usage and
quota, and reports a separate logical size breakdown for HYOAI conversations.
