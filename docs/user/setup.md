# Setup and migration

## Requirements

- Node.js 22.18 or newer.
- Claude Code or Codex with an available browser-use capability.
- A browser session signed in to ChatGPT and/or Gemini, with the requested mode available and saved conversations enabled. Temporary-chat/history-off mode cannot provide the required durable conversation.
- ChatGPT's GitHub connection for both public and private repository work.
- For private PR verification, local GitHub access through authenticated `gh`, `GH_TOKEN`, or `GITHUB_TOKEN`.

CAB has no Chrome extension or daemon of its own. A harness's own browser integration may use its own standard extension.

## Run from this checkout

```bash
npm ci
npm run build
node scripts/cli.mjs doctor
node scripts/cli.mjs --help
```

`./scripts/cab` and `./skills/ask-ai/scripts/ask-ai` are equivalent entry points. Resolve an absolute path once and use that same executable throughout the run, including readiness and completion. The docs use `cab` as shorthand for it. Do not switch to an older globally installed `cab`. A package installation exposes `cab`, `chrome-ai-bridge`, and `ask-ai` on `PATH`.

`doctor` checks local workflow setup; it cannot inspect browser tools inside an active agent session or prove that ChatGPT/Gemini is signed in. Ask the active agent to inspect its actual browser capability as well.

## Claude Code

Use Claude Code's [official Chrome integration](https://code.claude.com/docs/en/chrome). Enable it with:

```bash
claude --chrome
```

Use `/chrome` to inspect connection status, select the browser, or reconnect. It uses Claude in Chrome and requires a direct Anthropic account signed in through `/login`. Keep using the browser profile where ChatGPT and Gemini are signed in.

Do not set repository environment variables to force-enable browser integration. Anthropic explicitly documents that a project cannot enable Claude in Chrome for the user. Follow the harness's normal setup and site permissions.

## Codex

In the desktop app, use the available Browser or connected Chrome integration. The built-in browser uses its own profile; use the [browser extension](https://learn.chatgpt.com/docs/chrome-extension) when the task needs the user's existing signed-in Chrome tabs. [Official Browser documentation](https://learn.chatgpt.com/docs/browser) distinguishes these surfaces and states that the built-in Browser is not available in Codex CLI or IDE extension.

For Codex CLI or IDE, configure a browser MCP. One supported option is [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp):

```bash
codex mcp add playwright -- npx -y @playwright/mcp@latest --extension
```

Extension mode requires the standard [Playwright extension](https://github.com/microsoft/playwright/tree/main/packages/extension) and connects to existing browser sessions. Starting Playwright in its default separate profile does not inherit the user's signed-in Chrome session. The configured MCP must run on a machine that can access the selected browser.

See the [official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) for configuration and connection status. CAB does not require a particular MCP server name or copy Claude-specific tool names into Codex instructions.

## Make the shared skill discoverable

The canonical skill is `skills/ask-ai/` in this repository. The same directory can be used by both agents. Replace the example checkout path with the absolute path on your machine:

```bash
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/chrome-ai-bridge/skills/ask-ai ~/.claude/skills/ask-ai
```

```bash
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/chrome-ai-bridge/skills/ask-ai ~/.agents/skills/ask-ai
```

If a destination already exists, inspect it before changing it. Do not overwrite a different personal skill. Both [Claude Code](https://code.claude.com/docs/en/skills) and [Codex](https://learn.chatgpt.com/docs/build-skills) document symlinked skill directories. Repository-scoped alternatives are `.claude/skills/ask-ai` and `.agents/skills/ask-ai` in the project where the agent runs.

After the skill is available, ask the agent to use `ask-ai` for the repository task. The agent must execute the browser workflow and record its result; merely showing a generated prompt does not complete the task.

## Share durable conversations across agents

Choose the same stable project name and state directory in both harnesses. Defaults are:

| Setting                        | State location                     |
| ------------------------------ | ---------------------------------- |
| `CAB_STATE_DIR` set            | The specified directory            |
| Otherwise `XDG_STATE_HOME` set | `$XDG_STATE_HOME/chrome-ai-bridge` |
| Otherwise                      | `~/.local/state/chrome-ai-bridge`  |

For an explicit shared location on one machine:

```bash
export CAB_STATE_DIR=/absolute/path/to/cab-state
```

Run state contains prompts, selected code, answers, and conversation URLs. Keep it outside tracked repository files. Browser cookies and authentication are managed by the browser integration, not by CAB's state directory. Sharing CAB state alone does not sign another browser into either service.

## Migrate from v2

1. Build v3 and make sure your calling agent has browser tools.
2. Inspect each existing conversation you want to retain and identify its project and repository.
3. Import that conversation explicitly:

```bash
cab import-session chatgpt \
  --project my-project \
  --repo https://github.com/owner/repository \
  --visibility private \
  --url https://chatgpt.com/c/OBSERVED_CONVERSATION_ID
```

For Gemini, use `gemini` and its observed `https://gemini.google.com/app/...` conversation URL. The next request still verifies the required mode. Old `x-cab-session` IDs, environment-based agent IDs, and session TTLs do not define v3 projects.

Normal commands no longer auto-start a daemon or return provider answers through REST. Update integrations to follow the [CLI lifecycle](../tool-reference.md). The v2 implementation has been removed. Disable old auto-start entries only after identifying the relevant process/configuration; a v3 invocation does not remove them.

## First verification

Run `cab doctor`, then follow the [live verification recipe](workflows.md#live-verification-recipe) using an actual authorized task. Keep the new conversation URL, observed mode label, and final PR or answer in the run state. Offline build/tests and live browser verification are separate checks.

Integration documentation was checked on 2026-11-18. Availability can vary by harness, account, organization, and rollout; inspect the capabilities supplied by the session you are using.
