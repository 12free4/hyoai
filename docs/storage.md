# Browser persistence

HYOAI stores formal application data in the independent `hyoai` IndexedDB database, version 1, using one `kv` object store of string keys and string values. JSON and lz-string compression remain in use. Message attachments (images, PDFs and other files) remain inline in conversation bodies; no separate attachment store is introduced.

There is no migration. Historical `lc:*` and next-themes `theme` localStorage entries are never read, copied or deleted. A fresh installation starts with a fresh database. IndexedDB's `db.version` controls object-store upgrades; `dataSchemaVersion` describes stored application data.

## Rendering caches and themes

The only permitted localStorage keys are `hyoai:boot:skin` and `hyoai:boot:locale`. These supply first-paint hints. Skin and locale caches follow successful formal writes. After hydration, IndexedDB values govern the UI. Blocked cache access is best effort and cannot invalidate successful IndexedDB writes.

All theme controls call `lib/stores/theme.ts`. There is no theme localStorage cache. Until IndexedDB hydration completes, first paint uses the system theme. The coordinator serializes writes and remote reads. `ThemeBridge` is the sole caller of next-themes' original setter, and applies committed values in memory. Embed themes use forcedTheme without persisting preferences. Remote theme notifications read formal data without a new write or broadcast.

next-themes 0.4.6 and its ThemeProvider are retained. `scripts/patch-next-themes.mjs` patches both distributed entry points to remove all localStorage reads/writes and disable the internal storage event listener. Both initial rendering and runtime state remain in next-themes. The patch runs at postinstall, predev and prebuild, checks the installed version and expected code, and fails on an unknown distribution. Review the patch and tests before upgrading next-themes; do not bypass it when running with install scripts disabled.

## Consistency and reset behavior

Each formal write checks dbEpoch in its transaction. Conversation writes additionally check conversationEpoch and expected revision. The body, revision and epochs are read from one readonly snapshot; a snapshot is consistent but need not include concurrent later writes. Transactions resolve only after completion.

Successful commits publish BroadcastChannel hints. Receivers read IndexedDB rather than trusting message content. Focus/pageshow/visibility restoration reconciles missed notifications. Dirty or busy editors retain local content and report conflicts; no automatic merge occurs. Conversation-only clear advances conversationEpoch and leaves settings writes valid. Clear-all advances both epochs and rejects old-page writes.

Lifecycle flushing is best effort. A browser can terminate a page before an asynchronous write completes. IndexedDB can also be unavailable, evicted, or quota-limited; keep exports of important conversations. Errors retain pending content for explicit recovery.

## Space estimates

The progress bar uses `navigator.storage.estimate()` for the whole origin, including other storage used by that origin. HYOAI logical size sums `(key.length + value.length) * 2` for stored UTF-16 strings, including compressed records. Neither this logical measure nor per-conversation compressed body size is a physical disk size measurement.

Successful write/commit receipts update a cached per-key size map using final net changes. Startup calibrates the map; remote notifications and resets mark it dirty, and refreshes after 60 seconds recalibrate it. Repeated UI refreshes use the cache. Calibration uses a readonly snapshot and discards its result if a local mutation races it; concurrent remote changes may make this estimate temporarily stale until the next notification/calibration. Missing Storage API support yields unknown Origin quota while logical sizes remain available.

See [the validation checklist](../tests/README.md) for automated coverage and outstanding real-browser acceptance tests.
