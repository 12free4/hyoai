# IndexedDB independent audit — 2026-11-02

Reviewed the current working tree against HEAD, including untracked storage, theme, synchronization and test modules. This was a fresh code review; automated substitute tests are not treated as native-browser validation.

## Confirmed findings fixed

| Severity | Finding and trigger                                                                                                                             | Fix                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | next-themes still read/wrote a third localStorage theme cache, contrary to the latest two-key allowance.                                        | Retain ThemeProvider but patch both 0.4.6 entry points to remove every localStorage read/write and storage listener. Only skin/locale caches remain. Theme first paint uses system until IndexedDB hydration. |
| P1       | Hydration seeing an absent theme unconditionally wrote a default; a newer concurrent theme could be overwritten.                                | Hydration is read-only; absence resolves to the runtime default.                                                                                                                                              |
| P1       | Local clear retired draft IDs but missed live IDs which had never persisted; a late producer could restage an old ID in the new epoch.          | Capture all live IDs before stopping runtimes and retire them during clear. Restore retirement state on failure.                                                                                              |
| P1       | Saving one conflict copy automatically reloaded the tab, discarding other unresolved conversations.                                             | Save without automatic reload, keep conflicts visible, permit selection and repeated snapshots, and require explicit reload.                                                                                  |
| P2       | Native import validation stripped compaction; the atomic importer omitted it from the body. Collision remapping did not remap its anchor.       | Preserve compaction through validation, body storage and anchor remapping.                                                                                                                                    |
| P2       | Usage UI always displayed the paused-statistics message; translated help still named localStorage and did not explain per-conversation figures. | Show unavailable only when no estimate is available; describe IndexedDB, logical compressed bodies and shared index overhead.                                                                                 |
| P2       | A later estimation failure could reject fire-and-forget refresh calls.                                                                          | Catch the failure, clear unavailable cached display data and log the error.                                                                                                                                   |

## Checks of requested boundaries

- Application localStorage access: `app/layout.tsx` reads only `hyoai:boot:skin`/`hyoai:boot:locale`; `lib/storage/bootCache.ts` writes/removes those two typed keys after successful formal writes; clear-all removes only those two keys. No business reads of historical `lc:*` or `theme` were found. Both installed patched next-themes entry points contain no localStorage access. Patch-script search/replace patterns are build-time source manipulation, not storage access.
- Native transactions resolve from `oncomplete`, reject from `onabort`, and abort when private work fails. Snapshot metadata and requested values share one readonly transaction. Private transaction work awaits IndexedDB requests, not fetches or caller callbacks.
- Conversation commits atomically update body/state/index with revision checks. Tombstones prevent create/import resurrection; import retries ID_COLLISION only. Reset transactions check epochs and advance the appropriate epochs. Ordinary settings writes check dbEpoch.
- The page queue serializes submissions, retains failed writes, and uses generation counters to keep older failures from replacing newer queued content. Clear waits for submitted work, suppresses new affected writes and retires runtime IDs.
- BroadcastChannel carries hints, not authoritative data. Validation, sender/sequence deduplication, coalesced reconciliation and no remote re-emission prevent echo loops. Focus/pageshow/visibility restoration re-reads storage. A hint can still be lost on termination or when the API is unavailable; a later restoration event is the fallback, not guaranteed immediate synchronization.
- Embed business writes go through the persistence gate. Sidebar permits conversations and conversation-only clear; minimal denies business persistence. Database creation/schema metadata is infrastructure initialization and can still occur when an embed opens the database. The gate is an application policy, not a security boundary against arbitrary same-origin scripts.
- Initialization uses one frozen snapshot plus an epoch completion check and a loading barrier. Body/revision/epoch reads are consistent; late view-switch and lower-revision reads are rejected. Later writes always recheck the formal epoch in the database.
- Formal persisted data paths are IndexedDB: preferences, locale, theme, model selection, config overrides, compare descriptors, conversation metadata/bodies and inline attachments. Runtime network-discovery caches and UI state remain in memory.
- Usage uses Storage API estimates for the entire Origin, and a receipt-updated UTF-16 logical-size map for HYOAI. Per-conversation sizes describe compressed bodies, excluding shared metadata. Calibration is cached, invalidated for resets/remote hints and refreshed after the interval; concurrent remote writes can make estimates temporarily stale.
- IndexedDB open/transaction errors reach the retryable boot/error flow. Quota errors remain classified and pending data is retained. Blocked upgrades reject explicitly and late rejected opens are closed/aborted; versionchange closes existing connections. Real-browser blocked/abort/eviction behavior remains unverified here.
- The original clipboard compatibility fix is functionally unchanged (its prior diff is formatting only); a substitute-DOM fallback regression test passes. Chinese messages remain, and Chinese/French keys match English. Updated storage/conflict labels are translated.

## Remaining reliability limits

- **P2:** Closing, crashing or forcibly terminating a page can lose pending debounce work or an uncommitted asynchronous transaction. Visibility/freeze/pagehide flush is best effort, not a durability guarantee. Transactions already reported successful have completed; this does not promise survival of browser eviction or disk failure.
- **P2:** No native-browser acceptance claim is made for multitab concurrency, blocked/versionchange, lifecycle suspension, quota or IndexedDB availability. The existing browser checklist remains outstanding.
- Theme pre-paint now deliberately follows system defaults; restoring a persisted explicit theme waits for IndexedDB, as required by the latest localStorage restriction.
- Preferences use last-writer-wins semantics across tabs; revision conflicts apply to conversations, not arbitrary KV preferences.
- next-themes remains pinned and requires its audited install/build patch. Unknown package distributions fail the patch rather than silently restoring forbidden storage access.

## Actual validation

- `npm run test:storage`: 39 passed (controlled backend/channel and VM/DOM substitutes).
- `npm run check`: TypeScript, ESLint and Prettier passed during the audit; rerun after final edits recorded in the conversation.
- Translation-key comparison: Chinese and French have no keys missing from English.
- `git diff --check`: passed.
- `npm run build`: attempted in the default environment and with approved escalation. Both failed in Turbopack CSS processing: the Node subprocess exited before the parent could connect. This review does not count the user's earlier manual build as validation of these new audit fixes.
- Native-browser suite not run/passed in this audit. No commit or push performed.
