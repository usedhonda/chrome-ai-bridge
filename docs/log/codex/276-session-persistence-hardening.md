# 276 Session Persistence Hardening

## Task
Implement two post-ChatGPT-reuse hardening fixes:

1. Prevent `sessions.json` lost updates and torn reads inside one daemon process.
2. Prevent non-conversation ChatGPT URLs from being persisted as reusable session URLs.

## Fix A: Atomic Session Writes and In-Process Lock

Commit: `ad86b57 fix: serialize session persistence writes`

Changes:

- `saveRawSessions()` now writes to a unique temp file and replaces `sessions.json` with same-filesystem `fs.rename()`.
- Added a module-level promise-chain lock for session mutations.
- Public `loadSessions()` serializes migration writes.
- The load-modify-write entry points now run under the same in-process lock:
  - `getAgentSession()`
  - `saveAgentSession()`
  - `clearAgentSession()`
  - `dropAgentSessionUrl()`
  - `cleanupStaleSessions()`

Rationale:

- `target=both` can save ChatGPT and Gemini concurrently.
- Cleanup also reads and writes sessions independently.
- Atomic replacement prevents partial/torn `sessions.json` reads; the in-process lock prevents same-daemon lost updates.

## Fix B: ChatGPT `/c/<id>` Persistence Guard

Commit: `96513f8 fix: persist only chatgpt conversation urls`

Changes:

- `askChatGPTFastInternal()` only saves the ChatGPT session URL when `isChatGPTConversationUrl(finalUrl)` is true.
- `askChatGPTViaDriver()` applies the same guard.
- `docs/SPEC.md` now states that only ChatGPT conversation URLs (`/c/<id>`) are persisted as reusable session URLs.

Rationale:

- `chatgpt.com/`, `chatgpt.com/?model=...`, `/auth`, and other non-conversation pages cannot support conversation continuation.
- Persisting those URLs would poison reuse and can overwrite a valid saved conversation URL.

## Verification

Commands:

```text
npm run check-format -> pass
npm run typecheck -> pass
npm test -> pass
npm run build:noext -> pass
intent-guard check -> pass
```

## Test Scenario Note

`scripts/test-scenarios.json` was not changed. The current harness executes one prompt per scenario and has no assertion for "same lane, two consecutive ChatGPT prompts, same saved `/c/<id>` URL". Adding a JSON-only scenario would not verify the requested regression. A proper follow-up should add harness support for pre/post session URL capture and same-URL assertions.

## Scope Notes

- Gemini save-site guards were left unchanged because Fix B's Task Intent is ChatGPT saved URL hardening, and the delegation explicitly allowed staying ChatGPT-only if scope was ambiguous.
- Deferred/non-problem triage items were not touched: lane mutex, fast-chat splitting, tabId persistence, network capture timing.
