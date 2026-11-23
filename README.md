# chrome-ai-bridge

[![npm](https://img.shields.io/npm/v/chrome-ai-bridge.svg)](https://npmjs.org/package/chrome-ai-bridge)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**v3: use ChatGPT and Gemini through your coding agent's browser tools, with durable project conversations.**

Claude Code or Codex operates the browser. `cab` prepares the provider-specific request, saves its progress and conversation URL, and checks the result. The normal workflow needs no chrome-ai-bridge extension, background daemon, CDP endpoint, or intercepted provider API.

## Provider behavior

| Provider | Required mode                                                          | Public repository       | Private repository                                      | Completed result                                                             |
| -------- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ChatGPT  | Pro                                                                    | Pass the repository URL | Pass the repository URL; GitHub connection is assumed   | Chat answer **and an actual branch / pull request**, verified against GitHub |
| Gemini   | Thinking / 思考; explicit High thinking if the UI uses thinking levels | Pass the repository URL | Include selected source files or excerpts in the prompt | Chat answer with code / patch and explanation                                |

A new project opens a new page for each provider. Once the service creates a conversation URL, CAB saves it immediately. Later requests reuse that conversation, including after an agent or terminal restart. Tab handles are optional hints; the saved URL is the durable identity. Conversations do not expire on a timer.

Mode selection is based on the visible UI, not a fixed model version. A Pro subscription badge is not proof that the ChatGPT conversation uses Pro. Gemini's `Thinking: High` is valid evidence when the UI exposes a thinking-level control; a bare `High` label is not.

## How it works

1. **Prepare:** CAB saves a run and builds the exact prompt and browser instructions.
2. **Operate:** the calling agent opens or resumes the correct page, selects the required mode, and sends the prompt with its available browser tools.
3. **Record:** the agent records readiness, the send attempt, and the observed conversation URL with CAB.
4. **Complete:** the agent captures the final answer; CAB verifies ChatGPT's PR or saves Gemini's chat result.

The bundled [ask-ai skill](skills/ask-ai/SKILL.md) tells the agent to carry out the whole sequence. A standalone `cab prepare` command returns a **work packet**, not an AI answer. CAB cannot call tools inside another agent's session; the active agent must execute the browser steps. It must continue until completion or a recorded, concrete blocker.

## Setup

Use Node.js 22.18 or newer. To run this branch from a checkout:

```bash
npm ci
npm run build
node scripts/cli.mjs --help
```

`node scripts/cli.mjs`, `scripts/cab`, and `skills/ask-ai/scripts/ask-ai` expose the same commands. After a package installation, use `cab`, `chrome-ai-bridge`, or `ask-ai`. Examples below use `cab` as shorthand: when running from a checkout, substitute the same absolute executable path or Node/script prefix throughout. Do not switch from a v3 checkout to an older global `cab` halfway through a run.

Enable a browser capability in your agent and sign in to the target services:

- **Claude Code:** use its Claude in Chrome integration (`claude --chrome` or `/chrome`).
- **Codex in the desktop app:** use the available Browser / connected Chrome capability.
- **Codex CLI or IDE:** configure a browser MCP, such as Playwright MCP. The app's built-in Browser is not supplied by the CLI.

These integrations have different tool names. The shared skill uses the browser tools advertised by the current session. See [setup](docs/user/setup.md) for skill installation and the official integration references.

## Start a project

Write the requested work to a UTF-8 text file, then prepare it:

```bash
cab prepare chatgpt \
  --project my-project \
  --repo https://github.com/owner/repository \
  --visibility private \
  --base main \
  --prompt-file task.txt
```

For Gemini with a private repository, select the relevant code explicitly:

```bash
cab prepare gemini \
  --project my-project \
  --repo https://github.com/owner/repository \
  --visibility private \
  --root /absolute/path/to/repository \
  --context src/service.ts \
  --context src/types.ts:20:100 \
  --prompt-file task.txt
```

`--project` is required and should stay stable across Claude Code and Codex. A repository name or a stable project path is suitable. Gemini private requests require code context on follow-ups too, so the prompt describes the current code rather than relying on an inaccessible URL or stale excerpts. Context is bounded and selected by the caller; CAB does not dump a repository automatically.

Use `both` to prepare separate ChatGPT and Gemini runs. Only Gemini's prompt receives the selected private code. Both provider lanes are reserved together, and their browser operations can proceed in parallel when each has its own tab.

Aliases are available:

```bash
cab chatgpt --project my-project --repo https://github.com/owner/repository --visibility public "Implement the requested change and open a PR."
cab ask gemini --project my-project --repo https://github.com/owner/repository --visibility public "Review the error handling and explain a patch."
```

## Agent execution lifecycle

Use the returned run ID in place of `RUN`. The following commands record browser actions; they do not perform those actions themselves.

```bash
cab prompt RUN
```

Read the exact prepared prompt. Open a new page if instructed, otherwise reopen the saved conversation URL. Confirm the conversation is saved: temporary-chat or history-off mode must not be active. Inspect the rendered page and select the required mode. Then record the actual URL, mode label, and optional tab handle:

```bash
cab ready RUN --url https://chatgpt.com/ --mode Pro --tab TAB_HANDLE --new-page
cab begin-send RUN
```

`--new-page` is required for a new conversation. After `begin-send` succeeds, click Send once with the native browser tool. Once the submitted message and canonical conversation URL are visible:

```bash
cab sent RUN --url https://chatgpt.com/c/OBSERVED_CONVERSATION_ID
```

Save the **final answer**, preserving code and formatting, to a UTF-8 file. Complete ChatGPT with the PR it actually created:

```bash
cab complete RUN --answer-file answer.md --pr https://github.com/owner/repository/pull/123
```

CAB checks the actual GitHub PR and records its head and base branch. The PR must belong to the expected repository; a plausible-looking link or a promise to create one does not count. Private PR verification needs local GitHub access through authenticated `gh`, `GH_TOKEN`, or `GITHUB_TOKEN`. This is separate from ChatGPT's GitHub connection.

Gemini completes with its chat answer:

```bash
cab complete RUN --answer-file answer.md
```

See [command reference](docs/tool-reference.md) and [workflows](docs/user/workflows.md) for recovery and follow-ups.

## Resume without duplicate sends

```bash
cab status
cab resume RUN
```

Resume is read-only. It reports the recorded phase and what the agent should inspect next. A repeated `begin-send` does not authorize a second submission. If the click may have succeeded, inspect the existing tab or saved conversation before doing anything else. Do not replace a slow Pro run with another model or another chat.

Record a blocker without discarding progress:

```bash
cab block RUN --reason "The selected browser session needs sign-in."
```

Use `cab cancel RUN` only before a send attempt. If inspection positively establishes that the prompt was **not** submitted, reconcile the `sending` run before checking readiness and trying again:

```bash
cab reconcile-not-sent RUN --url OBSERVED_URL --reason "Evidence that no submission occurred"
```

A timeout, missing tab, or missing answer is not that evidence. If the provider has instead returned a **final** blocker or failure after submission, retain its answer and release the lane for a corrective follow-up:

```bash
cab fail RUN --answer-file answer.md --reason "Provider's final failure"
```

This records `failed`, never a successful completion. Use `block` for temporary problems while the original request can still continue. Use `--new-chat` on a later prepare only when a fresh conversation is explicitly intended, or when the provider says the conversation reached its length limit. `--request-id` allows callers to identify the same preparation request when recovering from an uncertain CLI result.

## State and migration

State is stored under `CAB_STATE_DIR`, otherwise `$XDG_STATE_HOME/chrome-ai-bridge`, otherwise `~/.local/state/chrome-ai-bridge`. State files use owner-only permissions and contain prompts and answers as well as conversation URLs. Use the same state directory and project name when switching agents on one machine.

Existing v2 conversations can be adopted explicitly after inspecting the saved URL:

```bash
cab import-session chatgpt \
  --project my-project \
  --repo https://github.com/owner/repository \
  --visibility private \
  --url https://chatgpt.com/c/OBSERVED_CONVERSATION_ID
```

Old agent IDs, expiring sessions, and daemon configuration are not imported implicitly. The v2 extension/daemon implementation has been removed; it remains only in Git history.

## Development and verification

```bash
npm test
npm run typecheck
cab doctor
```

Offline tests exercise workflow state, prompt policy, and result validation. They cannot prove that a signed-in provider UI accepted a prompt or that an account exposes the requested model. Use the [live verification recipe](docs/user/workflows.md#live-verification-recipe) to check those boundaries and record what was actually observed.

## Documentation

- [Architecture and invariants](docs/SPEC.md)
- [Setup and migration](docs/user/setup.md)
- [Workflows and live verification](docs/user/workflows.md)
- [Command reference](docs/tool-reference.md)
- [Troubleshooting](docs/user/troubleshooting.md)

## Origin and license

This repository began as a fork of Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp). Since v3 it is an independent project with a different purpose: it no longer exposes Chrome DevTools, runs an MCP server, or shares runtime code with upstream. Only a few upstream development config files remain, and they keep their original Google LLC notices.

Apache-2.0. Earlier implementations and documentation remain available in Git history.
