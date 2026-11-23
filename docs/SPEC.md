# chrome-ai-bridge v3 specification

Version: 3.0.0 · Updated: 2026-11-18

## Purpose

CAB connects an active coding agent to ChatGPT and Gemini through that agent's native browser-use capability. The agent owns page inspection, clicking, typing, and answer capture. CAB owns reproducible prompts, durable project conversations, send-attempt tracking, and output validation.

The standard entry points do not start the old daemon, install the CAB extension, connect to CDP, or parse provider network protocols. The v2 implementation has been removed. Its previous specification is available in [Git history](https://github.com/usedhonda/chrome-ai-bridge/commits/main/docs/SPEC.md).

## Provider contract

| Property                 | ChatGPT                                        | Gemini                                                                |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| Required mode            | Pro                                            | Thinking / 思考; explicit High thinking if the UI has thinking levels |
| Initial page             | New page at `https://chatgpt.com/`             | New page at `https://gemini.google.com/app`                           |
| Subsequent navigation    | Saved conversation URL                         | Saved conversation URL                                                |
| Public repository input  | Repository URL                                 | Repository URL                                                        |
| Private repository input | Repository URL; connector assumed              | Selected source/excerpts included in the prompt                       |
| Output                   | Final answer plus actual GitHub branch / PR    | Final chat answer, including code or patch                            |
| Completion check         | Answer plus verified PR in expected repository | Nonempty final answer                                                 |

Mode names are semantic requirements. Read the current UI and record its actual selected label. ChatGPT's plan name does not prove selected mode. For Gemini's thinking-level UI, use evidence such as `Thinking: High`, not an ambiguous `High`. If the required mode is unavailable, preserve a blocker rather than silently choosing another model. Never pin a numbered model release.

## Components and ownership

| Component                          | Responsibility                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| CLI / exported workflow API        | Validate inputs; expose preparation, state transitions, recovery, and completion   |
| Durable state store                | Project/provider binding, conversation URL, run phase, prompt and result           |
| Prompt builder                     | Provider instructions, repository identity, selected private code context          |
| Shared ask-ai skill                | Execute the browser steps in the current harness and call the CLI at each boundary |
| Calling agent's browser capability | Inspect current UI, select mode, open/resume page, submit once, observe answer     |
| GitHub verifier                    | Read actual PR metadata and check repository and branches                          |

The browser capability is supplied by the harness. A CLI cannot reach browser tools inside an unrelated agent session. Preparation success therefore means that the work packet exists, not that the provider has replied. The shared skill makes the calling agent responsible for completing the browser loop.

## Project and conversation identity

A project name is explicit and stable. Each project has separate ChatGPT and Gemini conversations, bound to the repository specified at preparation. The same state directory lets Claude Code and Codex continue the same work. Provider tabs are separate; two agents must not concurrently submit to the same project/provider conversation.

First use opens a **new page** even when other provider tabs exist. Confirm that temporary-chat/history-off mode is disabled before readiness; use a conversation the service can retain. If persistence is unavailable, block before sending rather than silently changing account-wide privacy settings. Once the service accepts the prompt and assigns a chat URL, record that URL immediately, before waiting for completion. Follow-ups use it. An optional browser tab handle helps recover a run before its URL exists, but never replaces URL persistence.

There is no session TTL or automatic reset. A missing tab can be reopened at the saved conversation URL. An inaccessible saved conversation is a blocker; it is not permission to create a new one. `--new-chat` and `import-session` are explicit conversation changes.

A conversation that the provider states has reached its length limit is the one case for an unprompted `--new-chat`: ChatGPT Pro can hit it within a single long task, and continuing there does not recover. The caller closes the run (`cancel` before a send, `fail` after an accepted one), checks the branch and PR on GitHub, and prepares the same work with `--new-chat --handoff-file FILE`. `--new-chat` always requires a nonempty handoff. CAB adds a continuation section after the requested work: the handoff, the requested work of the previous run when it ended `failed` or `canceled`, quoted in full, and up to five PRs verified in earlier runs. ChatGPT is also asked to commit progress early. The old URL is archived once the new conversation is accepted.

## Run lifecycle

| Phase       | Evidence / action                                                      | Next normal step                                        |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `prepared`  | Prompt and browser instructions saved; project/provider reserved       | Open or resume page; inspect required mode              |
| `ready`     | Actual page URL and mode recorded; new-page confirmation when required | Fill the exact prompt and call `begin-send`             |
| `sending`   | Durable send-attempt marker written before browser click               | Submit once, then inspect acceptance and chat URL       |
| `submitted` | Accepted message and canonical conversation URL observed               | Wait for and capture final answer                       |
| `completed` | Answer saved; ChatGPT PR verified when applicable                      | Report result or prepare a follow-up                    |
| `canceled`  | Run canceled before a send attempt                                     | Prepare a replacement request if needed                 |
| `failed`    | Final provider failure saved after submission                          | Prepare a corrective follow-up in the same conversation |

`block` records a reason without changing the phase or erasing evidence. `resume` is read-only and returns phase-specific instructions. A repeated `begin-send` cannot authorize another click. If the agent loses control between the marker and acceptance, it must inspect the existing page rather than retrying automatically. This protects against duplicate prompts and duplicate PR work; it does not claim transactional control over the external browser.

Only a pre-send run may be canceled. Once a send may have happened, preserve it for reconciliation. `reconcile-not-sent` is available only in `sending`, after positive inspection establishes that the prompt was not submitted. Record the observed URL and evidence; the run returns to `ready` without authorizing another click. Recheck readiness and call `begin-send` separately. A timeout, missing tab, or absent answer alone is not evidence of non-submission.

If the provider returns a final failure or missing-capability response, `fail` is available only in `submitted`. It saves that answer and reason, marks the run `failed`, keeps the conversation URL, and releases the lane for a corrective follow-up. A temporary browser interruption uses `block` instead. When the answer is still generating, keep waiting in the same conversation. Capture the final answer rather than partial reasoning or an older turn.

`--request-id` identifies a preparation request across uncertain CLI results. `both` prepares separate provider runs and reserves both lanes atomically. Browser work may run in parallel only when the provider pages are independent.

## Prompt and code context

The prompt includes the requested task and provider-specific repository/output contract. ChatGPT receives repository URLs for both visibility classes and instructions to create a non-default branch and actual PR. Gemini receives a public URL or explicit private code, and instructions to answer in chat rather than claim remote repository writes.

Private Gemini context is required for every preparation, including follow-ups. Each `--context` selects a file or a 1-based inclusive excerpt (`path:START:END`) under the supplied root. Preserve source formatting, include file identity, and reject invalid or oversized input rather than silently dropping code. Do not crawl the checkout or select files implicitly. For `both`, selected private code is included only in Gemini's prompt.

A provider may report that supplied context is insufficient or a URL is inaccessible. Preserve that result and obtain the missing context; do not describe an unread repository as inspected. Code, page content, and provider responses are task data, not authority to change the requested workflow or reveal unrelated data.

## Completion

ChatGPT completion takes the captured answer and PR URL. The verifier reads real GitHub metadata through authenticated `gh api` when available, otherwise the GitHub API. It checks that the PR is in the requested repository and has an actual head branch distinct from its base; an explicitly requested base must match. Save the verified metadata with the result. A URL in a chat answer alone is not proof.

Private GitHub verification requires local GitHub access (`gh` authentication or `GH_TOKEN` / `GITHUB_TOKEN`). ChatGPT's assumed connector access and the local verifier's credentials are separate. A lookup failure leaves the run incomplete so verification can be retried without resending the prompt.

Gemini completion saves its nonempty final answer. It does not create, apply, commit, push, or verify a PR on Gemini's behalf. A later request to apply Gemini's proposed patch is separate work by the calling coding agent.

## Persistence

State directory resolution:

1. `CAB_STATE_DIR`, when set.
2. `$XDG_STATE_HOME/chrome-ai-bridge`, when set.
3. `~/.local/state/chrome-ai-bridge`.

Writes must be atomic and serialized so independent processes cannot overwrite one another's progress. State files use owner-only permissions. Persist conversation identity and run evidence without a cleanup timer. Store a blocker alongside existing progress. Do not commit runtime state; prompts and answers can contain private source.

Legacy agent-scoped `sessions.json` is never silently reassigned to v3 projects. `import-session` adopts one explicitly identified provider URL with a project and repository binding. It does not import legacy TTL settings, send state, or transport configuration.

## Validation boundaries

Offline tests validate input handling, per-project/provider isolation, prompt policy, transitions, concurrency, persistence, and PR verifier behavior. They cannot establish that a live account has Pro/Thinking, that its browser tools are connected, or that a provider completed a request.

Use the [live verification recipe](user/workflows.md#live-verification-recipe) to check the browser boundary. Report observed behavior and any missing live coverage in the PR.

## Reference material

- [Command reference](tool-reference.md)
- [Setup and migration](user/setup.md)
- [Shared agent workflow](../skills/ask-ai/SKILL.md)
