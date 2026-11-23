# Browser-use workflows

Use the same v3 executable for every command below. `cab` is shorthand for the installed v3 command or the absolute bundled wrapper / Node-script prefix resolved from your checkout. Keep that prefix when switching working directories.

## New project and first request

Choose a stable project name, target repository URL, visibility, and task. Put longer tasks in a UTF-8 file so quoting and code formatting survive unchanged:

```bash
cab prepare chatgpt \
  --project service-hardening \
  --repo https://github.com/owner/service \
  --visibility private \
  --base main \
  --prompt-file task.txt
```

Read the returned work packet and run ID. Use the active agent's browser tools to open a **new page** at the instructed provider URL. Do not repurpose another project's conversation. Confirm temporary-chat/history-off mode is disabled so the conversation can be saved. Inspect the page and choose ChatGPT Pro, then record the actual observed label:

```bash
cab ready RUN --url https://chatgpt.com/ --mode Pro --tab TAB_HANDLE --new-page
cab prompt RUN
```

Fill the composer with the exact prepared prompt and verify it is present. Immediately before clicking Send:

```bash
cab begin-send RUN
```

After this command succeeds, click Send once. Inspect the new user message and save the actual conversation URL as soon as it appears:

```bash
cab sent RUN --url https://chatgpt.com/c/OBSERVED_CONVERSATION_ID
```

Wait in that conversation. Preserve code and formatting when saving the final answer to `answer.md`. If ChatGPT returns its actual PR:

```bash
cab complete RUN --answer-file answer.md --pr https://github.com/owner/service/pull/123
```

Completion verifies the PR through GitHub. If ChatGPT has only promised a PR, keep the task open. If it returns a final failure such as missing connector access, save that response with `cab fail RUN --answer-file answer.md --reason TEXT` so a corrective follow-up can use the same conversation. Do not substitute an invented URL or count the explanation as the requested deliverable.

## Follow-up in the same conversation

Prepare another request using the same `--project` and provider after the preceding run is resolved. CAB returns the stored conversation URL. Open that URL if its tab has disappeared, inspect the page and required mode again, and follow the same readiness/send/result sequence. Do not include `--new-page` merely because you reopened an existing conversation in a new browser tab; it attests to a new conversation workflow.

Switching Claude Code to Codex does not require a new chat. Use the same state directory and project identity. The second harness still needs access to a browser signed in to the same service account.

Use `--new-chat` only when a fresh conversation is intended. It is not a recovery action for slow generation, a disconnected tool, or a lost tab handle.

## Conversation length limit

When ChatGPT states that the conversation reached its length limit, do not keep using it. Close the run (`cancel` before a send; `fail` with the visible text after an accepted one), check the working branch and PR on GitHub, and write a handoff file: the goal and the user's own observations, progress (branch, commits, PR, what was and was not verified), decisions and constraints, and the remaining work. Then prepare the same work again with a new request ID:

```bash
cab prepare chatgpt --project service-hardening --repo https://github.com/owner/service \
  --visibility private --prompt-file task.txt --new-chat --handoff-file handoff.md
```

CAB adds the handoff, the unfinished previous request in full, and earlier verified PRs to the new prompt. `--new-chat` without `--handoff-file` is rejected.

## Gemini with private code

Gemini has no GitHub connection in this workflow. Select the source necessary to answer the task and supply it on every request, including follow-ups:

```bash
cab prepare gemini \
  --project service-hardening \
  --repo https://github.com/owner/service \
  --visibility private \
  --root /absolute/path/to/service \
  --context src/retry.ts \
  --context src/config.ts:30:120 \
  --prompt-file task.txt
```

CAB builds a prompt containing the selected code. Ranges are 1-based and inclusive. Select enough definitions and call sites for the question; the bridge does not upload or crawl a private repository automatically. A rejected size limit means narrow the excerpt or split the task, not silently omit files.

Open a new Gemini page on first use or the saved URL on continuation. Confirm it is a saved, non-temporary conversation. Select Thinking / 思考. If the current UI exposes thinking levels instead, explicitly choose High thinking and record evidence identifying that control, for example:

```bash
cab ready RUN --url https://gemini.google.com/app --mode 'Thinking: High' --tab TAB_HANDLE --new-page
cab begin-send RUN
```

A bare `High` is ambiguous and rejected. After the single browser submission, record the actual Gemini conversation URL with `sent`. Capture the final answer and complete without a PR:

```bash
cab sent RUN --url https://gemini.google.com/app/OBSERVED_CONVERSATION_ID
cab complete RUN --answer-file answer.md
```

Gemini's patch is an answer to review. This workflow does not apply or push it. If the user subsequently asks the calling agent to implement it, that is a separate repository change.

## Both providers

Use `cab prepare both` with the same project/repository options. For a private repository, include Gemini's selected code. Preparation reserves both provider lanes together and returns separate run IDs. ChatGPT receives the URL-based PR request; Gemini receives code context and a chat-output request.

Each run follows its own lifecycle and has its own saved chat URL. Parallel browser work is appropriate only when the tools keep the two provider pages independent. Summarize both outcomes independently: Gemini finishing does not mean ChatGPT's PR is complete.

## Recover a partially completed run

```bash
cab status RUN
cab resume RUN
```

Read the phase before acting:

| Phase       | Recovery                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`  | Open the required page and select mode.                                                                                                                                                         |
| `ready`     | Inspect the same page and prompt before beginning the send.                                                                                                                                     |
| `sending`   | Inspect the recorded tab/conversation. If accepted, record `sent`; if uncertain, preserve a blocker. If positively confirmed not sent, use `reconcile-not-sent` before a fresh readiness check. |
| `submitted` | Reopen the saved URL, wait for or capture the existing answer, then complete.                                                                                                                   |
| `completed` | Return the saved outcome; prepare a new run for a new request.                                                                                                                                  |
| `canceled`  | Prepare a replacement only if work is still required.                                                                                                                                           |
| `failed`    | Read the saved final provider failure; prepare a corrective follow-up using the retained conversation.                                                                                          |

`cab block RUN --reason TEXT` retains the phase, URL, and evidence. `resume` does not resend, reset, or clear the blocker by itself. Only pre-send work can be canceled with `cab cancel RUN`.

If a `sending` run is positively confirmed **not submitted**, record the evidence:

```bash
cab reconcile-not-sent RUN --url OBSERVED_URL --reason "Observed evidence that the prompt was not submitted"
```

This returns the run to `ready` without authorizing a send. Inspect the page and mode again, record readiness, and call `begin-send` separately before a new attempt. A timeout, missing tab, or absent answer is not enough to make this claim.

For a **final provider failure** after submission:

```bash
cab fail RUN --answer-file answer.md --reason "Provider's final failure or missing capability"
```

This saves the final answer and reason, marks `failed`, and frees the lane while preserving the URL. It is not completion and is not how to handle a still-running answer. A subsequent corrective request can continue the same conversation.

Use a stable `--request-id` when a caller may repeat the same prepare command after an uncertain CLI result. It identifies that same request; it does not authorize duplicate browser submissions.

## Live verification recipe

Run these checks in an agent session with authorized browser access. This is a recipe, not a claim that a particular environment has passed it.

1. **New conversation:** prepare a real scoped task under a fresh project name, open a new provider page, and record the selected mode and tab hint.
2. **Submission and persistence:** write `begin-send`, click once, and record the canonical URL while the answer is still running. Verify `status` retains it.
3. **Correct output:** for ChatGPT, inspect the returned PR and complete through actual GitHub verification; for Gemini, capture the final chat answer without claiming repository writes.
4. **Continuation:** restart the caller or switch harnesses, prepare a follow-up with the same project name and state directory, and verify the returned URL matches the first conversation.
5. **Private Gemini:** supply selected source in a private request and inspect the prepared prompt to confirm that the required code, paths, and formatting are present.
6. **Recovery boundary:** if a browser call fails after a real submission, resume that run and inspect the existing conversation. Confirm no automatic second send or replacement chat occurs.

Record the harness/browser, actual mode label, whether a new page was used, conversation URL persistence, output verification, and any limitations. Keep private task contents and personal chat URLs out of committed test fixtures. A failed or unavailable live prerequisite should be reported specifically; offline tests do not replace this observation.
