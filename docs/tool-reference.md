# CLI reference

`cab`, `chrome-ai-bridge`, and `ask-ai` expose the same native browser workflow. Resolve the v3 executable once and use it for every command; the examples use `cab` as shorthand. A checkout wrapper must not accidentally switch to a globally installed v2 `cab`. Run that executable with `--help` for its exact syntax. Normal commands return structured work/state information; `prompt` prints the prepared prompt as raw text.

## Prepare a request

```bash
cab prepare PROVIDER \
  --project NAME \
  --repo URL \
  --visibility public|private \
  --prompt-file PATH
```

`PROVIDER` is `chatgpt`, `gemini`, or `both`. A positional prompt can replace `--prompt-file`. Aliases `cab PROVIDER ...` and `cab ask PROVIDER ...` prepare the same workflow; they do not synchronously send a browser message.

| Option                         | Meaning                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `--project NAME`               | Required stable project identity shared across caller sessions.                            |
| `--repo URL`                   | Required GitHub repository URL.                                                            |
| `--visibility public\|private` | Explicit repository visibility determines prompt policy.                                   |
| `--prompt-file PATH`           | UTF-8 task text; use for multiline instructions and code.                                  |
| `--root PATH`                  | Root for selected source context.                                                          |
| `--context PATH[:START:END]`   | Repeatable source file or 1-based inclusive excerpt; required for private Gemini requests. |
| `--base BRANCH`                | Requested ChatGPT PR base branch, verified at completion.                                  |
| `--request-id KEY`             | Identify the same preparation request across retries of the CLI call.                      |
| `--new-chat`                   | Explicitly start a fresh provider conversation instead of the saved one.                   |
| `--handoff-file PATH`          | With `--new-chat`: progress and premises from the earlier conversation.                    |

Preparation persists the prompt and reserves the project/provider lane. `both` reserves both lanes together and creates separate provider runs. Selected private source goes only to Gemini's prompt. The returned browser instructions tell the caller whether to open a new page or reuse a saved URL.

## Execute and record browser progress

| Command                                                                 | When to use                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cab prompt RUN`                                                        | Read the exact prompt to enter into the browser.                                                                    |
| `cab ready RUN --url OBSERVED --mode LABEL [--tab HANDLE] [--new-page]` | After opening/resuming and inspecting the required selected mode. `--new-page` is mandatory for a new conversation. |
| `cab begin-send RUN`                                                    | Immediately before the single browser click that submits the prompt. Writes the durable send-attempt marker.        |
| `cab sent RUN --url CANONICAL_CHAT`                                     | After the new user message is accepted and the service's conversation URL is visible.                               |
| `cab complete RUN --answer-file PATH --pr URL`                          | ChatGPT: save final answer after GitHub verifies the actual PR.                                                     |
| `cab complete RUN --answer-file PATH`                                   | Gemini: save the final chat answer.                                                                                 |

These commands record observed browser events; they do not open pages or click buttons. The calling agent performs browser actions with the tools available in its session. Do not pre-record success or fabricate a mode label, tab handle, chat URL, or PR.

Before `ready`, confirm that temporary-chat/history-off mode is disabled and the conversation can be saved. For ChatGPT, the selected mode must be Pro. For Gemini, select the Carbon model and 思考レベル 高, and record both, such as `Carbon, 思考レベル: 高`. A bare `High` does not identify the mode.

`complete` verifies a ChatGPT PR against real GitHub metadata and records head/base information. Private verification needs locally authenticated `gh` or `GH_TOKEN` / `GITHUB_TOKEN`; this is separate from ChatGPT's GitHub connector. A failed verification leaves the run available for completion retry without resubmitting the prompt.

## Inspect, recover, or stop pre-send work

```bash
cab status
cab status RUN
cab resume RUN
cab block RUN --reason "Observed blocker"
cab reconcile-not-sent RUN --url OBSERVED_URL --reason "Positive evidence of non-submission"
cab fail RUN --answer-file answer.md --reason "Final provider failure"
cab cancel RUN
cab doctor
```

`status` without a run lists stored work. `resume` returns the persisted phase and next-step instructions without modifying or sending anything. `block` adds a reason while preserving the phase and evidence. `cancel` is available only before a send attempt. Neither elapsed time nor a repeated CLI invocation resets a conversation.

Phases are `prepared`, `ready`, `sending`, `submitted`, `completed`, `canceled`, and `failed`. A blocker is metadata, not a separate phase. If phase is `sending`, inspect the existing page before any further action: the external click may have succeeded even if its tool call failed.

`reconcile-not-sent` is available only in `sending` and requires an observed URL and positive evidence that no submission occurred. It returns the run to `ready` and records the recovery; it does not authorize another click. Recheck readiness and call `begin-send` separately. A timeout or missing answer alone is insufficient evidence.

`fail` is available only in `submitted`, for a final provider failure or missing-capability response. It saves the answer and reason, marks `failed`, preserves the conversation URL, and releases the lane for a corrective follow-up. Use `block` for a temporary interruption while the same task can still continue. Failed output is never reported as completed.

`doctor` (also available as `health`) checks local setup. Its JSON retains `daemonRequired: false` for CLI compatibility; CAB has no daemon. It cannot attest to an active agent's browser tools, login state, or current provider mode.

## Adopt an existing conversation

```bash
cab import-session PROVIDER \
  --project NAME \
  --repo URL \
  --visibility public|private \
  --url EXISTING_CONVERSATION_URL
```

Use a single provider, `chatgpt` or `gemini`, and an observed conversation URL. This explicit migration binds the URL to the project/repository; it does not import old daemon configuration, agent IDs, or TTL policies. Inspect the live conversation before adopting it.

## State location

CAB uses `CAB_STATE_DIR`, otherwise `$XDG_STATE_HOME/chrome-ai-bridge`, otherwise `~/.local/state/chrome-ai-bridge`. Files have owner-only permissions and are retained without automatic expiration. Use the same directory for agents that should share project conversations.
