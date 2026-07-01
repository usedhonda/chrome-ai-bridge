# 268 - Session URL GC LRU Bound

Date: 2026-07-01

## Task

NIT 1: prevent unbounded `sessions.json` URL accumulation without breaking the core requirement that chat URLs persist for continued discussion.

## Implementation

Changed `cleanupStaleSessions()` in `src/fast-cdp/session-manager.ts`:

- stale URL entries no longer get `lastAccess` refreshed during cleanup;
- stale URL entries keep their URL and only drop volatile `tabId`;
- stale empty entries are still deleted;
- when `agents` exceeds `config.maxAgents`, only TTL-expired inactive entries are deleted by LRU order;
- recent active lanes such as `cdx` and `cc-oc2b` are not evicted even if the file remains temporarily over `maxAgents`.

This preserves continued discussion URLs for active lanes while still bounding old inactive entries.

## Verification

Commands:

```bash
npm run check-format
npm test
```

Both passed.

Synthetic GC verification used a temp workdir with:

- recent `cdx` URL;
- recent `cc-oc2b` URL;
- stale URL entries;
- stale empty entry;
- `CAI_SESSION_TTL_MINUTES=1`;
- `CAI_MAX_AGENTS=2`.

Readback:

```text
changed=5
keys=cc-oc2b,cdx
cdxUrl=https://gemini.google.com/app/cdx
ccUrl=https://gemini.google.com/app/cc
staleOld=false
staleNewer=false
staleEmpty=false
```

Result: active lane URLs were preserved and stale inactive entries were removed.
