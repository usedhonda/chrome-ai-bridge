# 267 - Session URL Isolation Header Forwarding Fix

Date: 2026-07-01

## Task

Fix the two-lane session URL isolation bug reported by CC:

- Expected: `cc-oc2b` and `cdx` persist as separate `sessions.json` agent keys with separate Gemini chat URLs.
- Observed by CC: runtime collapsed into one fallback `agent-<pid>-<timestamp>` key.

CC referenced `docs/log/claude/260701_session-url-BUG-handoff.md` at commit `3a1f8c9`, but that commit was not available in this worktree after `git fetch --all --prune`.

## Root Cause

The previous implementation created request-scoped handling in `src/main.ts` and `src/fast-cdp/agent-context.ts`, but the CLI request path did not forward the lane into HTTP.

Evidence:

- `skills/ask-ai/scripts/ask-ai` exported `CAB_SESSION_ID`.
- `src/main.ts` read `req.headers['x-cab-session']`.
- `scripts/cab` sent only `Content-Type: application/json` and did not include `x-cab-session`.

Therefore the daemon's `resolveRequestAgentId()` saw no header and used `default` fallback, so persistence could collapse away from `cc-oc2b` / `cdx`.

The AsyncLocalStorage path was not the root cause for the reproduced failure: after adding the missing header, `saveAgentSession()` persisted separate `cdx` and `cc-oc2b` entries in the same runtime path.

## Fix

Changed `scripts/cab` to:

- document `CAB_SESSION_ID`;
- resolve `local session_id="${CAB_SESSION_ID:-default}"`;
- send `-H "x-cab-session: ${session_id}"` on `/api/ask`.

## Verification

Static CLI header proof with a fake `curl`:

```text
x-cab-session: cdx
```

Checks:

```bash
npm run check-format
npm test
```

Both passed.

Live Gemini verification:

```bash
skills/ask-ai/scripts/ask-ai gemini "For routing validation, answer exactly: dead-beef-cdx-lane"
CAB_SESSION_ID=cc-oc2b skills/ask-ai/scripts/ask-ai gemini "For routing validation, answer exactly: c0ffee-cc-lane"
```

Outputs:

```text
dead-beef-cdx-lane
c0ffee-cc-lane
```

`sessions.json` readback via Node:

```text
keys=agent-70373-1782861891248,cdx,cc-oc2b
agent-70373-1782861891248 gemini=https://gemini.google.com/app/c01134e64daa8ce3
cdx gemini=https://gemini.google.com/app/bc3378c4ad488e2a
cc-oc2b gemini=https://gemini.google.com/app/f390ae8b088bb855
cc-oc2b=https://gemini.google.com/app/f390ae8b088bb855
cdx=https://gemini.google.com/app/bc3378c4ad488e2a
separate=true
```

Result: `cc-oc2b` and `cdx` are separate entries with separate Gemini URLs.

## Communication Protocol Note

`cc-oc2b` is not a valid `tproj-msg` alias in this workspace. Available target is `cab.cc`, so ACK and commit hashes were sent via `cab.cc`.
