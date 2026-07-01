# 269 - Deleted Chat Detection

Date: 2026-07-01

## Task

NIT 2: replace deleted-chat detection based on weak navigation heuristics with a more robust signal so stale saved chat URLs are not reused forever.

## Implementation

Changed the existing-tab reuse path in `src/fast-cdp/fast-chat.ts`:

- after attaching to a saved conversation URL, read the current page load status through browser performance navigation data;
- treat HTTP `404` or `410` as a deleted-chat signal;
- also treat a provider-origin redirect away from the requested conversation URL to a non-conversation provider URL as a definitive stale-conversation signal;
- when detected, call `dropAgentSessionUrl()` and fall through to the existing new-tab creation path.

Changed `src/fast-cdp/session-manager.ts`:

- added `dropAgentSessionUrl(kind)` to remove a confirmed stale URL without changing active-lane isolation logic.

## Verification

Commands:

```bash
npm run check-format
npm test
```

Both passed.

## Notes

This keeps the implementation surgical:

- no `src/extension/**` changes;
- no new global mutable state;
- no change to AsyncLocalStorage session scoping;
- no change to answer extraction behavior.

The live deleted-chat case depends on provider-side 404/redirect behavior for a specific stale URL, so the committed verification is static/type/build plus code-path inspection. The next live run with a truly deleted saved URL should drop that URL and create/save a fresh chat URL.
