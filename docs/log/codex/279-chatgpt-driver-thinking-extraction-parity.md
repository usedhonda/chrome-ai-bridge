# 279 - ChatGPT Driver Thinking and Extraction Parity

Task: cab-29715633-01
Date: 2026-07-01

## Intent

Raise the ChatGPT driver path (`CAI_USE_DRIVERS=1`) wait/extract behavior to monolith parity for Thinking mode and normal responses while keeping the default monolith path unchanged and `CAI_USE_DRIVERS` default off.

Explicitly out of scope: Gemini driver, flag flip, monolith `*Internal` changes, shared hardening helper changes, reuse/Pro/fail-closed/fork/save guard changes.

## Root Gap From Task A

Task A proved network capture/hybrid wiring, but ChatGPT driver still failed `chatgpt-new-chat`:

- Task A driver log: `docs/log/codex/run/278_taskA_driver_final_20260701_162142.log`
- Failure: `minAnswerLength: got 10, expected 20`; `relevance: got 0, expected 0.2`
- Evidence: `[Driver] Answer source selected {"source":"dom","networkLen":0,"domLen":10}`

Cause confirmed in source: `ChatGPTDriver` had only the base `waitForResponse()` polling `isProcessing()` plus a shallow `.markdown` extraction. It lacked the monolith stop-button debounce, Thinking fallback, streaming-text capture, finalize wait, and multi-stage DOM/main/body extraction.

## Implementation

Changed only `src/fast-cdp/drivers/chatgpt/chatgpt-driver.ts` plus this log and `docs/SPEC.md`.

Implemented in ChatGPTDriver:
- Capture pre-send response baseline in `sendPrompt()` so wait logic can distinguish stale prior answers from the new turn.
- Override `waitForResponse()` with stop-button detection, stop-gone debounce (`>=3` polls), text-stability confirmation, Thinking fallback, and idle timeout.
- Capture `streamingText` when the stop button disappears, preserving text that can collapse or become hard to read later.
- Expand collapsed Thinking content inside the latest ChatGPT article only.
- Bring the page to front and wait for final rendered text before extraction.
- Extract through multiple tiers: non-thinking `.markdown`, `.result-thinking`, fallback markdown/prose/whitespace containers, content div paragraphs, generic paragraphs, article fallback, `<main>` fallback, and `body.innerText` fallback.
- Return streaming text when final DOM extraction is empty or header-only.

Preserved invariants:
- `CAI_USE_DRIVERS` default remains off.
- Monolith `askChatGPTFastInternal` / `askGeminiFastInternal` paths were not modified.
- `src/fast-cdp/drivers/gemini/gemini-driver.ts` was not modified.
- Shared hardening helpers and ViaDriver reuse/Pro/fail-closed/fork/save guard calls were not modified.

## Driver Validation: `CAI_USE_DRIVERS=1`

Raw logs are under `docs/log/codex/run/` with timestamp `20260701_163719`.

| Scenario | Result | DOM length | Evidence | Baseline / Task A delta |
| --- | --- | ---: | --- | --- |
| `chatgpt-new-chat` | PASS | 69 | `.markdown:not(.result-thinking)` | Task A driver FAIL `domLen=10` -> PASS `domLen=69`. Default baseline had content but failed timing (`maxTotalMs 137502 > 60000`). Driver now completes in the scenario threshold. |
| `chatgpt-thinking-mode` | PASS | 126 | `streaming-text` | Default baseline PASS. Driver now reaches parity for Thinking fallback and extraction. |
| `chatgpt-thinking-complex` | PASS | 371 | `streaming-text` | Default baseline PASS. Driver now reaches parity for deeper Thinking output. |
| `chatgpt-long-response` | PASS | 153 | `streaming-text` | Driver long response extraction no longer collapses to stale short text. |
| `chatgpt-markdown-extraction` | PASS | 160 | `streaming-text` | Driver markdown extraction returns full answer. |
| `chatgpt-code-block` | PASS | 214 | `streaming-text` | Driver code block extraction returns full answer. |
| `chatgpt-sequential` | PASS | 90 | `streaming-text` | Driver sequential reuse path remains functional. |

Command summary:

```text
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-new-chat           PASS
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-thinking-mode      PASS
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-thinking-complex   PASS
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-long-response      PASS
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-markdown-extraction PASS
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-code-block         PASS
CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-sequential         PASS
```

## Static Verification

- `npm run check-format`: PASS
- `npm run typecheck`: PASS
- `npm run build:noext`: PASS
- `npm test`: PASS

## Notes

The final-text wait still logs `articleIndex=-1` in this live DOM, but extraction succeeds through old assistant selectors and stored streaming text. This matches the Task B intent: answer correctness and Thinking-depth parity without changing monolith or Gemini driver behavior.
