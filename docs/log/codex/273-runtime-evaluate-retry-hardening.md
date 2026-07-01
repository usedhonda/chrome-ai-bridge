# 273 - Runtime Evaluate Retry Hardening

Date: 2026-07-01

## Task

Hardening NIT3(b): remove `Runtime.evaluate` from the `RELAY_REQUEST_TIMEOUT` retry whitelist to avoid double-action risk from mutating evaluate snippets.

## Implementation

Changed `src/fast-cdp/cdp-client.ts`:

- removed `Runtime.evaluate` from `RETRYABLE_RELAY_TIMEOUT_METHODS`;
- kept bounded retry for non-mutating navigation/read/setup methods such as `Page.navigate`.

## Verification

Commands:

```bash
npm run check-format
npm test
```

Both passed.

Fake relay proof after rebuild:

```text
navCalls=3
navResult={"ok":true,"method":"Page.navigate"}
evalError=RELAY_REQUEST_TIMEOUT
evalCalls=1
```

Result:

- `Page.navigate` still retries with bounded backoff.
- `Runtime.evaluate` no longer retries after a relay timeout.

## Scope

- No `src/extension/**` changes.
- No session isolation changes.
- No deleted-chat detection changes in this substep.
