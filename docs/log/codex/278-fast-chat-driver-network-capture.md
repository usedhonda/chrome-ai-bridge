# 278 - Fast Chat Driver Network Capture Baseline

Task: cab-29715596-01
Date: 2026-07-01

## Intent

Add network capture and hybrid network-vs-DOM answer selection to ChatGPT/Gemini ViaDriver paths while keeping `CAI_USE_DRIVERS` default off, preserving monolith paths and existing shared ChatGPT hardening helpers.

Explicitly out of scope: flipping `CAI_USE_DRIVERS`, editing `drivers/`, changing monolith internal paths, altering shared hardening helpers, Thinking depth parity, or extraction fallback parity.

## Step 0 Baseline: Default Path, `CAI_USE_DRIVERS` Off

Raw logs are under `docs/log/codex/run/`.

| Command | Raw log | Result | Notes |
| --- | --- | --- | --- |
| `npm run test:regression` | `278_taskA_baseline_20260701_155641.log` | PASS 7/7 | Report: `.local/chrome-ai-bridge/test-reports/20260701_200953.json` |
| `npm run test:suite -- --id=chatgpt-thinking-mode` | `278_taskA_baseline_20260701_155641.log` | PASS | Report: `20260701_201224.json` |
| `npm run test:suite -- --id=chatgpt-thinking-complex` | `278_taskA_baseline_20260701_155641.log` | PASS | Report: `20260701_201505.json` |
| `npm run test:suite -- --id=chatgpt-existing-chat` | `278_taskA_baseline_20260701_155641.log` | PASS | Report: `20260701_201732.json` |
| `npm run test:suite -- --id=gemini-existing-chat` | `278_taskA_baseline_20260701_155641.log` | PASS | Report: `20260701_201755.json` |
| `npm run test:suite -- --id=gemini-new-chat` | `278_taskA_baseline_20260701_155641.log` | FAIL | Timeout waiting for Gemini response; report: `20260701_201935.json` |
| `npm run test:suite -- --id=parallel-query` | `278_taskA_baseline_parallel_20260701_162550.log` | PASS | ChatGPT DOM source, Gemini DOM source; report: `20260701_202832.json` |
| `npm run test:suite -- --id=chatgpt-new-chat` | `278_taskA_baseline_chatgpt_new_20260701_162209.log` | FAIL | Content OK, but `maxTotalMs: got 137502, expected 60000`; report: `20260701_202430.json` |

Baseline observation: the default monolith path remains functional for regression and requested existing/thinking/parallel scenarios, but current live state already has two non-code blockers/noise points: `gemini-new-chat` timed out once, and `chatgpt-new-chat` exceeded the 60s scenario timing threshold because DOM extraction waited roughly 120s after generation completed.

## Step 1 Implementation

Changed only `src/fast-cdp/fast-chat.ts` ViaDriver wrappers plus `docs/SPEC.md` parity notes.

ChatGPT ViaDriver:
- Starts `NetworkInterceptor` immediately before `driver.sendPrompt()`.
- Stops capture after driver wait/extract, with catch cleanup on send/wait/extract failure.
- Selects network text when available and at least half of DOM length, otherwise keeps DOM text.
- Writes the selected hybrid answer to history and return value.

Gemini ViaDriver:
- Starts `NetworkInterceptor` immediately before `driver.sendPrompt()`.
- Stops capture after driver wait/extract, with catch cleanup on send/wait/extract failure.
- Normalizes network text with `normalizeGeminiResponse()` before hybrid selection.
- Writes the selected hybrid answer to history and return value.

Preserved invariants:
- `CAI_USE_DRIVERS` default remains off (`process.env.CAI_USE_DRIVERS === '1'`).
- Monolith `askChatGPTFastInternal` / `askGeminiFastInternal` paths were not modified.
- Shared ChatGPT hardening helpers in the 575-897 area were not removed, inlined, or changed.
- `drivers/` was not modified.

## Driver Validation: `CAI_USE_DRIVERS=1`

Raw final log: `docs/log/codex/run/278_taskA_driver_final_20260701_162142.log`.

| Command | Result | Baseline comparison |
| --- | --- | --- |
| `CAI_USE_DRIVERS=1 npm run test:suite -- --id=chatgpt-new-chat` | FAIL: `minAnswerLength: got 10, expected 20`; `relevance: got 0, expected 0.2` | Worse than default content result. Driver capture/hybrid ran, but network text was empty and driver DOM extraction returned the short stale text `OK`/10 chars after ~453ms. This points to Task B/C wait/extract parity, not network capture wiring. |
| `CAI_USE_DRIVERS=1 npm run test:suite -- --id=gemini-new-chat` | PASS | Improved against the observed default baseline run, which timed out. Driver selected network source with `networkLen=76`, `domLen=76`. |

Driver log evidence:
- ChatGPT: `[Driver] Network capture result {"frames":2,"textLength":0,"rawDataSize":91,...}` then `[Driver] Answer source selected {"source":"dom","networkLen":0,"domLen":10}`.
- Gemini: `[Driver] Network capture result {"frames":5,"textLength":76,"rawDataSize":75210,...}` then `[Driver] Answer source selected {"source":"network","networkLen":76,"domLen":76}`.

## Static Verification

- `npm run check-format`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS
- `npm run build:noext`: PASS

## Follow-up Boundary

Task A network capture/hybrid wiring is complete. The remaining ChatGPT ViaDriver live failure is a parity gap in driver response wait/extraction timing. That is explicitly outside Task A and belongs to the planned Thinking depth / extraction fallback work.
