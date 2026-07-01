# 275 ChatGPT Reuse Pro Preservation

## Task
Preserve ChatGPT conversation URL reuse while enforcing the configured Pro model before sending. A reused `/c/<id>` URL must not be navigated away to `chatgpt.com/?model=...`; Pro must be verified in place or the request must fail closed.

## Changes
- Added ChatGPT conversation ID normalization and same-`/c/<id>` comparison before model enforcement.
- Added `preserveConversation` to `ensureChatGPTPreferredModel()`.
- Preserved reused conversations in place instead of navigating to `CHATGPT_CONFIG.DEFAULT_URL`.
- Kept Pro enforcement fail-closed: if Pro cannot be verified or selected, throw `MODEL_UNAVAILABLE` with `selectedPro=false` before send.
- Expanded picker selection to a priority list: Pro Extended, Pro Standard, GPT-5.5 Pro, GPT-5 Pro, then other Pro labels.
- Added fork logging when a preserved conversation ends on a different `/c/<id>`.
- Updated `docs/SPEC.md` with the reuse-time model enforcement contract.

## Live Verification

### Baseline
Default lane saved ChatGPT URL before verification:

```text
https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
```

### Run 1
Command:

```bash
CAB_SESSION_ID=default CAI_CAB_REQUEST_TIMEOUT_SEC=1800 skills/ask-ai/scripts/ask-ai chatgpt "Reuse validation first after preserve fix: answer exactly cdx-chatgpt-reuse-one"
```

Result:

```text
cdx-chatgpt-reuse-one
```

Grounding log excerpts:

```text
[ChatGPT] Reusing saved conversation in place: https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
[ChatGPT] Preserving reused conversation while verifying gpt-5-pro in place: https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
[ChatGPT] Pro model active (slug): プロファイルメニューを開く accounts-profile-button
[ChatGPT] Response extracted: cdx-chatgpt-reuse-one...
```

Saved URL after run 1:

```text
https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
```

### Run 2
Command:

```bash
CAB_SESSION_ID=default CAI_CAB_REQUEST_TIMEOUT_SEC=1800 skills/ask-ai/scripts/ask-ai chatgpt "Reuse validation second after preserve fix: answer exactly cdx-chatgpt-reuse-two"
```

Result:

```text
cdx-chatgpt-reuse-two
```

Grounding log excerpts:

```text
[ChatGPT] Reusing saved conversation in place: https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
[ChatGPT] Preserving reused conversation while verifying gpt-5-pro in place: https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
[ChatGPT] Pro model active (slug): プロファイルメニューを開く accounts-profile-button
[ChatGPT] Response extracted: cdx-chatgpt-reuse-two...
```

Saved URL after run 2:

```text
https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
```

### Run 3 (latest build after source-aware Pro log patch)
Command:

```bash
scripts/cab stop || true
CAB_SESSION_ID=default CAI_CAB_REQUEST_TIMEOUT_SEC=1800 skills/ask-ai/scripts/ask-ai chatgpt "Final reuse validation after source-aware Pro log patch: answer exactly cdx-chatgpt-reuse-three"
```

Result:

```text
cdx-chatgpt-reuse-three
```

Grounding log excerpts:

```text
[ChatGPT] Reusing saved conversation in place: https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
[ChatGPT] Preserving reused conversation while verifying gpt-5-pro in place: https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
[ChatGPT] Pro model active (slug): gpt-5-5-pro
[ChatGPT] Response extracted: cdx-chatgpt-reuse-three...
```

Saved URL after run 3:

```text
https://chatgpt.com/c/6a454868-5980-83ea-adda-884beff49207
```

## ChatGPT vs Gemini Cross-Check Resolution
The live runs support the ChatGPT-side hypothesis: an existing `/c/<id>` conversation can be reused without navigating to a new model URL, and Pro can be verified in place for a Pro-born thread. The picker did not need to be opened in this verified path because the current conversation already exposed a Pro-positive model state.

## Notes
- An earlier pre-fix verification hit a false `MODEL_UNAVAILABLE` because unavailable text was detected from unrelated page text containing `上限`. The warning detection is now line-scoped to lines that include both Pro and an unavailable/limit term.
- The displayed Pro label in the first two live logs included a profile-button label even though the source was `slug`; the implementation was adjusted afterward to report labels according to the Pro source. Run 3 confirms the latest build logs `gpt-5-5-pro`.
- No fork warning appeared during the three-run verification.
- Out-of-scope candidates remain: lower-model fallback detection and same-conversation parallel-send mutex.

## Static Verification

```text
npm run check-format -> pass
npm test -> pass
npm run build:noext -> pass
```
