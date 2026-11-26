# Troubleshooting v3

Start with:

```bash
cab doctor
cab status
cab resume RUN
```

`doctor` checks local setup. The active coding agent must inspect the browser capability and signed-in page itself.

## A command returned instructions instead of an answer

`prepare`, including the `chatgpt` / `gemini` / `both` aliases, saves a work packet. The active agent must follow it using its browser tools, then call `ready`, `begin-send`, `sent`, and `complete`. Use the [shared ask-ai skill](../../skills/ask-ai/SKILL.md) so the agent carries out that sequence. Running the CLI in a terminal alone does not operate another agent's browser session.

## The checkout and global CLI behave differently

Use the absolute v3 wrapper or Node/script prefix you started with for every lifecycle command. A `cab` installed earlier on `PATH` may still be v2. Read the returned command prefix when available and do not switch executables between preparation and completion.

## The page is in temporary-chat or history-off mode

A durable project conversation needs a saved chat. Confirm that the task uses the provider's normal saved conversation mode before recording readiness. Do not submit while persistence is disabled. If account settings prevent this, record a blocker; do not silently change account-wide privacy settings.

## Browser tools are missing

For Claude Code, inspect `/chrome` or start with `claude --chrome` after setting up Claude in Chrome. For Codex desktop, inspect the Browser / Chrome integration available in that session. Codex CLI and IDE need a configured browser MCP; see [setup](setup.md).

Do not invent a tool name, fall back to a different automation path, or open a new browser profile as a substitute for the requested signed-in session. Record the specific missing capability with `cab block RUN --reason TEXT`.

## The page asks for sign-in

Keep the run and page. Use the harness's supported sign-in handoff, then inspect the page again. CAB state stores conversation identity, not authentication cookies. Switching agents or sharing its state directory does not sign a separate browser profile into the service.

## Pro or Neon cannot be confirmed

Inspect the conversation's model/mode selector. A ChatGPT Pro plan badge is not selected-mode evidence. For Gemini, select the Neon model and, under 思考レベル, 高. Record both, such as `Neon, 思考レベル: 高`.

Do not silently accept Fast, Auto, a lower mode, or a numbered model assumed to be equivalent. If account limits or access prevent the required mode, preserve a blocker in the same run. [Google's model guide](https://support.google.com/gemini/answer/18648722) documents that models, thinking controls, and automatic fallback can vary.

## The provider is still thinking

Wait in the existing conversation and check the current rendered state. Save the conversation URL as soon as it exists; do not wait until the answer is finished. Capture the final answer, not interim reasoning or the preceding turn. A long wait does not authorize a second submission or a fresh chat.

## A send call timed out or the agent restarted

Run `cab resume RUN`. If the phase is `sending`, the marker means a browser submission may already have happened. Inspect the original tab hint or saved URL for the exact new user message. If it was accepted, record `sent` with the observed conversation URL. If it is still uncertain, keep a blocker. A second `begin-send` cannot grant another send.

If inspection positively establishes that the prompt was **not submitted**, use `cab reconcile-not-sent RUN --url OBSERVED_URL --reason EVIDENCE`. It returns a `sending` run to `ready`; recheck the actual page and mode and call `begin-send` before another click. A timeout, missing tab, or missing answer does not establish non-submission.

If the phase is `submitted`, continue waiting or capture the existing final response. If it is `completed`, return the saved result. If a submitted task has a final provider failure, save the response with `cab fail RUN --answer-file answer.md --reason TEXT`; it becomes `failed` and a corrective follow-up can use the retained URL. This prevents recovery from creating a duplicate PR task.

## A new request is rejected because work is active

Another run owns that project/provider conversation. Inspect `status` and resume it. A pre-send request can be canceled if it is no longer wanted; a request that may have been sent must be reconciled. A final provider failure can be recorded with `fail` to permit corrective follow-up. Use separate project names for genuinely independent tasks, not to bypass an unresolved send.

## A saved tab no longer exists

Open the saved conversation URL in the signed-in browser. The tab handle is only a hint. If the conversation itself is unavailable, preserve the URL and record the error. `--new-chat` is an explicit decision to start over, not an automatic repair. The exception is a conversation the provider says has reached its length limit; see the workflow guide.

## Gemini rejects private repository preparation

A private URL alone is insufficient. Supply selected `--context` files or excerpts under `--root`, even for follow-ups. Verify paths and line ranges. If context exceeds the supported bounds, narrow it or split the task. Do not paste an entire checkout, secrets, or unrelated files to avoid choosing relevant code.

For `both`, the private context requirement comes from Gemini; only its prompt receives that selected code.

## ChatGPT returned an answer but no PR

The ChatGPT output contract requires an actual branch and PR. If ChatGPT is still carrying out the task, keep observing it. If its final answer reports a missing connector capability or another final failure, save that answer with `cab fail RUN --answer-file answer.md --reason TEXT`. The result is `failed`, and a corrective follow-up can use the same conversation. Use `block` for temporary interruptions. Do not call the task completed just because its prose sounds finished.

## A PR URL was rejected

Check that it is an actual PR in the requested repository, with an appropriate non-default head branch and the requested base when `--base` was supplied. `cab complete` reads GitHub metadata; a fabricated, inaccessible, unrelated, or mismatched link is not accepted.

For a private repository, authenticate local `gh` or supply `GH_TOKEN` / `GITHUB_TOKEN` through the environment. ChatGPT's GitHub connection does not automatically authenticate this local verifier. Do not place tokens in prompts or command-line URLs. Once access is fixed, retry **completion**, not the browser send.

## Claude Code and Codex open different conversations

Check that both callers use the same `CAB_STATE_DIR` (or the same default state directory), project name, repository, and provider. Then check browser account/profile identity. Import a known old URL explicitly with `import-session`; do not copy expiring v2 agent IDs into new state.

## Old instructions mention CDP, extension reloads, or `cab legacy`

Those belong to the removed v2 implementation. Uninstall any old CAB extension and remove old daemon auto-start entries after identifying them. Use the current [specification](../SPEC.md) and [command reference](../tool-reference.md).
