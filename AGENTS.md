# Chrome AI Bridge

## Start here

Read `docs/SPEC.md` before changing the workflow. The active design is v3: the calling agent operates ChatGPT or Gemini with its available browser capability; CAB persists project conversations, constructs prompts, and validates results.

Read the latest relevant work log under `docs/log/claude/` when resuming repository work. Record task start, meaningful milestones, blockers, and completion in a task log there. Use the client-local date/time and keep logs factual. Explicit user instructions take precedence over this guide.

## Product requirements

- A new project gets a new page per provider. Save the actual conversation URL as soon as it appears and reuse it on future requests.
- Keep project identity stable across agent restarts and Claude Code / Codex. Never use a process ID as durable conversation identity.
- ChatGPT uses **Pro**. Assume its GitHub connection can read public and private repository URLs. Request a branch and actual PR; verify the PR against GitHub before completion.
- Gemini uses **Thinking / 思考**, or explicit **High thinking** when the UI presents thinking levels. Public repositories are supplied by URL. Private requests include selected code in the prompt, including on follow-ups. Its output is the chat answer.
- Record the observed mode label. A subscription badge, a bare `High`, or an unobserved default is not evidence. Do not hard-code numbered models or downgrade silently.
- Preserve the run and URL when work is blocked. Never automatically resend an uncertain submission, erase state, or create a replacement conversation.
- The one exception: when the provider states that a conversation reached its length limit, close that run and continue in a new conversation with `--new-chat` and a self-contained prompt (goal, scope, constraints, GitHub-confirmed progress; optionally `--handoff-file`). CAB adds the unfinished request and verified PRs to that prompt.

## Native browser workflow

Use the shared `skills/ask-ai/SKILL.md` for provider requests. Resolve its bundled wrapper to an absolute path once and use that same executable for every lifecycle command; do not accidentally invoke an older global `cab`. `cab`, `chrome-ai-bridge`, and `ask-ai` expose the same workflow. `prepare` saves a task packet; the calling agent must execute its browser steps before reporting a result.

The lifecycle is `prepare`, browser inspection and `ready`, `begin-send`, one browser submission, `sent`, then `complete`. `begin-send` is the durable send-attempt marker and must run immediately before clicking Send. A blocked run preserves its last phase. Use `resume` to inspect recovery instructions. Use `reconcile-not-sent` only after positive observation that a `sending` prompt was not submitted, then recheck readiness before another send attempt. Use `fail` only for a submitted request with a final provider failure; retain its answer and mark `failed`, not completed.

Before recording readiness, confirm that temporary-chat/history-off mode is disabled and that the conversation can be saved. If account settings prevent persistence, record the blocker; do not silently change account-wide privacy settings.

Use only browser capabilities advertised by the active harness. Claude's Chrome integration, Codex's desktop Browser, and configured browser MCPs have different APIs. Do not invent tool names, turn on browser permissions in repository settings, or start a new browser profile to replace the user's signed-in session.

## Code and compatibility boundaries

- CAB never drives a browser itself: no daemon, custom Chrome extension, CDP driver, or provider network parser. Do not reintroduce one as a fallback when a native browser capability is missing.
- Keep runtime dependencies at zero; use `node:` built-ins.
- Keep provider policy, durable state transitions, and browser instructions independently understandable.
- Do not include prompts, private source, answers, credentials, or real conversation URLs in committed fixtures or work logs.
- Update the shared skill and user docs whenever the command contract changes. The skill is repository-owned and its changes belong in the same PR; this does not install or edit a personal skill.

## Verification

```bash
npm test            # typecheck + build + node:test (tests run via type stripping)
npm run typecheck
npm run check-format
npm run docs
```

Use focused tests for meaningful workflow risks: project isolation, continuation after restart, uncertain sends, private Gemini context, and PR validation. Offline tests are not evidence that a live provider UI behaved as expected.

Follow `docs/user/workflows.md` for an authorized live check. Record the browser/harness, observed model label, conversation URL persistence, and actual PR verification. Distinguish offline checks from live provider validation in the PR. Do not claim a live test passed without observing it.

## Delivery

Use a feature branch and a PR. Explain the user-visible behavior, migration, validation performed, and remaining limitations. Preserve unrelated work. Do not publish to npm, tag a release, or merge unless requested. Local development uses the checkout's CLI and does not require npm publication.
