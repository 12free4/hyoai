# Storage validation

## Automated logic tests

Run `npm run test:storage`. These tests use a controlled in-memory backend and channel/event substitutes. They cover persistence scheduling, hydration, conflicts, reset ordering, embed permissions, commit notifications, page restoration, and lifecycle flushing. They do **not** validate browser IndexedDB transactions or native BroadcastChannel behavior.

Run `npm run check` for TypeScript, ESLint, and formatting.

## Browser validation still required

`npm run test:storage:browser` runs the existing native IndexedDB smoke harness. Browser startup/debugging is unavailable in the current execution environment; this suite has not been counted as passing. The smoke harness does not replace the following application-level checks.

Use disposable data in an isolated browser profile, with two same-origin application tabs:

1. Create different conversations concurrently; both indexes must converge without dropping either conversation.
2. Edit a conversation in A while B is idle; B must reload its persisted body and metadata. Repeat with foreground, background, and compare-pane instances.
3. Edit the same conversation in both tabs; preserve the local content and display a revision conflict. Explicit copy/reload must work without automatic merging or retry loops.
4. Clear conversations while a write is pending: test both transaction orderings. No old conversation can reappear. Settings writes in the other tab must remain valid.
5. Clear all data; subsequent writes from the old tab must fail with STALE_DB_EPOCH. A remote reset must not silently discard a dirty editor.
6. Clear from sidebar embed: conversations may be removed, preferences must survive. Minimal embed must not persist or clear data.
7. Suspend/restore a page and use back/forward cache: restore must re-read IndexedDB even when broadcasts were missed. Check focus fallback with BroadcastChannel unavailable.
8. Force a failed clear transaction; keep local content and allow explicit retry. Failed transactions must not broadcast success.
9. Exercise real transaction commit/abort, multiple database connections, versionchange/blocked, and connection recovery. Mock tests do not establish these guarantees.

Lifecycle flushing is best effort: browsers may terminate a page before its asynchronous IndexedDB transaction completes. Visibility/freeze/pagehide handlers reduce this window but cannot guarantee persistence after forced termination.

Additional real-browser checks for stage D:

- With two tabs open, change the theme in A; B must read IndexedDB and update without an echo write.
- Block localStorage entirely. Theme switches must still render and persist in IndexedDB without accessing localStorage.
- Modify/delete each of the two permitted boot caches externally. The running app must retain its formal theme; reload must reconcile all hints against IndexedDB.
- Seed old `lc:*` and `theme` keys with distinct values. They must remain untouched and must not affect the new app.
- Compare Origin estimates with HYOAI logical size, and check repeated UI refreshes do not rescan IndexedDB within the calibration interval.

The next-themes tests execute extracted distributed script/setter functions with a VM DOM substitute. They are not real React/browser compatibility tests.
