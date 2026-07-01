# 270 - Relay Timeout Bounded Retry

Date: 2026-07-01

## Task

NIT 3: add bounded retry with backoff for transient `RELAY_REQUEST_TIMEOUT` without duplicating existing connection retry or changing extension code.

## Implementation

Changed `src/fast-cdp/cdp-client.ts`:

- retries only `RELAY_REQUEST_TIMEOUT`;
- retries only safe CDP methods such as `Runtime.evaluate`, `Page.navigate`, `Page.enable`, `Network.getResponseBody`;
- excludes `Input.*` methods to avoid duplicated typing/clicking;
- max attempts: 3;
- backoff: 250ms, then 500ms.

This keeps existing connection-level retry intact and adds a narrow command-level retry for transient relay stalls.

## Verification

Commands:

```bash
npm run check-format
npm test
```

Both passed.

Fake relay proof:

```text
retryableCalls=3
retryableResult={"ok":true,"method":"Runtime.evaluate"}
inputError=RELAY_REQUEST_TIMEOUT
inputCalls=1
```

Result:

- retryable read/evaluate method retried and succeeded on the third attempt;
- non-retryable input method did not retry.
