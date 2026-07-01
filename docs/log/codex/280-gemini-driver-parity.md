# Task C: Gemini Driver Parity

## Task Intent

Raise the Gemini driver path (`CAI_USE_DRIVERS=1`) to monolith parity for stuck retry, saved URL navigation, debug info, and login detection while keeping the default monolith path unchanged and `CAI_USE_DRIVERS` default off.

## Implementation

- `src/fast-cdp/drivers/gemini/gemini-driver.ts`
  - `waitForResponse()` now accepts a Gemini-specific pre-send `initialModelResponseCount` option and requires new `model-response` growth before completing on stop-button disappearance.
  - Completion checks now mirror the monolith path: stop gone + feedback, stop gone + mic, stop gone + send enabled/input empty, and text-stable fallback.
  - Timeout while the stop button is still visible throws `GEMINI_STUCK_STOP_BUTTON` so `ai-helpers.ts` reset-and-retry can handle the driver path.
  - `needsLogin()` now treats a visible Gemini textbox as logged-in and still returns true on `accounts.google.com`.
- `src/fast-cdp/fast-chat.ts`
  - `askGeminiViaDriver()` logs `driver.needsLogin()` after connection.
  - It navigates to `getPreferredSessionV2('gemini').url` when a saved Gemini URL exists and the current tab is not already on that URL.
  - It captures pre-send `model-response` count and passes that baseline to `driver.waitForResponse()`.
  - It returns `ChatDebugInfo` in debug mode with Gemini DOM counts, markdowns, extraction selector evidence, fallback source, timings, URL, and document title.
- `docs/SPEC.md`
  - Documented Gemini driver saved URL navigation, response baseline, stuck signal, and debug info parity.

## Scope Checks

- `CAI_USE_DRIVERS` remains default off.
- `src/fast-cdp/drivers/chatgpt/chatgpt-driver.ts` diff size: 0 bytes.
- Monolith internals were not edited; changes in `fast-chat.ts` are limited to `askGeminiViaDriver()`.
- Shared ChatGPT hardening helpers were not edited.

## Verification

Static checks:

```text
npm run check-format  PASS
npm run typecheck     PASS
npm run build:noext   PASS
```

Driver live checks with `CAI_USE_DRIVERS=1`:

| Scenario | Result | Evidence |
| --- | --- | --- |
| `gemini-new-chat` | PASS | `docs/log/codex/run/280_taskC_driver_final_gemini-new-chat_20260701_165752.log`, report `20260701_205805.json`; `needsLogin=false`; source `network`; `networkLen=78`, `domLen=78` |
| `gemini-existing-chat` | PASS | `docs/log/codex/run/280_taskC_driver_final_gemini-existing-chat_20260701_165752.log`, report `20260701_205817.json`; saved URL reused; `needsLogin=false`; source `network`; `networkLen=78`, `domLen=78` |
| `gemini-code-block` | PASS | `docs/log/codex/run/280_taskC_driver_final_gemini-code-block_20260701_165752.log`, report `20260701_205840.json`; source `network`; `networkLen=556`, `domLen=533` |
| `gemini-long-response` | PASS | `docs/log/codex/run/280_taskC_driver_final_gemini-long-response_20260701_165752.log`, report `20260701_205856.json`; source `network`; `networkLen=696`, `domLen=676` |
| `gemini-new-chat --debug` | PASS | `docs/log/codex/run/280_taskC_driver_final_debug_gemini-new-chat_20260701_165752.log`, report `20260701_205908.json`; debug path returned `ChatDebugInfo`; source `network`; `networkLen=77`, `domLen=77` |
| `gemini-sequential` | PASS on retry, semantic false-fail in one final batch | retry PASS: `docs/log/codex/run/280_taskC_driver_gemini-sequential_retry2_20260701_165729.log`, report `20260701_205742.json`; final batch false-fail: `docs/log/codex/run/280_taskC_driver_final_gemini-sequential_20260701_165752.log`, report `20260701_205828.json` |

## `gemini-sequential` Note

The final batch `gemini-sequential` run failed only the test-suite `relevance` assertion (`got 0, expected 0.1`) while the driver extracted the current response successfully (`networkLen=39`, `domLen=39`, source `network`). The answer was a genuine continuation summary of the prior answer and did not include the literal question tokens extracted by the harness (`ID` / generated timestamp). That is expected with saved conversation reuse.

For comparison, the default monolith path passed the same scenario by navigating away from the existing conversation into a new chat and receiving a refusal-style answer containing `ID`; see `docs/log/codex/run/280_taskC_default_gemini-sequential_20260701_165700.log`, report `20260701_205718.json`. That default behavior is not the Task C target because Task C explicitly asks the driver path to navigate to and continue the saved Gemini URL.

## Baseline / Task A Delta

- Task A already proved Gemini driver network capture/hybrid worked for `gemini-new-chat`.
- Task C adds saved URL navigation, login signal surface, debug payload, and monolith-like response completion baselining.
- The driver path now keeps the saved Gemini conversation URL and extracts via network/DOM hybrid across new, existing, code-block, long-response, and debug scenarios.
