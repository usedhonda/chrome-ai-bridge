# v3 design decisions

Version 3.0.0 switches the primary integration to caller-owned browser use. This document records the delivered design and its boundaries; see [SPEC.md](SPEC.md) for the contract.

## Why the responsibility moved

The previous implementation maintained a custom Chrome extension, daemon discovery, relay connections, provider DOM drivers, network-response parsers, and expiring agent sessions. Modern coding agents already provide browser interaction. Keeping a second provider automation stack made CAB responsible for interfaces its caller could inspect directly.

CAB now concentrates on the parts that need durable, deterministic behavior: project/provider identity, prompt composition, single-send progress, conversation URL persistence, and result verification. The calling agent adapts to the current UI using its own browser tools.

## Decisions

| Decision                                 | Result                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Stable project/provider keys             | Claude Code and Codex can continue the same saved conversation.                          |
| New page for first use                   | Unrelated open chats are not reused for a new project.                                   |
| Persist URL immediately after acceptance | Long Pro responses and caller restarts do not lose conversation identity.                |
| Explicit mode observation                | Pro / Thinking requirements survive numbered model changes without silently downgrading. |
| Durable marker before Send               | Recovery inspects an uncertain submission rather than automatically duplicating it.      |
| Separate provider output contracts       | ChatGPT completes with a verified PR; Gemini returns its chat answer.                    |
| Explicit private Gemini code context     | The request contains relevant code despite the missing GitHub connection.                |
| Explicit legacy path                     | Existing transport remains available for migration without running from normal commands. |

## Portability boundary

A shared skill plus CLI is portable; a hard-coded browser tool name is not. Claude Code's Chrome integration, Codex desktop browser use, and Codex CLI browser MCPs provide different surfaces. The shared skill uses the capabilities advertised by the current session. It records a concrete blocker if browser access is absent.

The standalone CLI prepares and persists work. It does not create a hidden agent, hold an API key for a second model, or invoke browser tools inside another running agent. The active caller performs the full lifecycle before returning the result.

## Migration and retained utilities

Normal `cab`, `chrome-ai-bridge`, and `ask-ai` commands use v3. Existing REST callers must move to preparation and progress/completion recording. Adopt selected old conversation URLs with `import-session`; do not infer ownership from legacy process-based agent IDs.

The old extension/CDP code remains behind explicit `cab legacy ...` usage. Its historical documentation is retained in Git history and labeled as such where still present. The dedicated Discord collector is a separate utility and remains outside the provider workflow redesign.

## Known boundaries

- Browser authentication, site permissions, model availability, and actual UI interaction belong to the chosen harness and account.
- CAB validates recorded workflow state, but cannot independently prove an agent clicked a particular visible mode; the caller must report observed evidence honestly.
- A browser click and a local state write cannot be one transaction. The `sending` phase preserves that uncertainty and deliberately disallows an automatic second send. A positively observed non-submission can be reconciled explicitly before a new readiness/send sequence.
- Final provider failures are retained as `failed` outcomes so a corrective follow-up can use the same URL; temporary blockers retain the active run.
- ChatGPT's GitHub connection does not supply credentials to the local PR verifier. Private PR verification needs local access.
- Public repository URLs are passed to Gemini as requested; an inaccessible URL must be reported, not treated as read.
- Offline tests validate the workflow implementation; signed-in live checks validate the provider boundary.

Future transport integrations should preserve these invariants and use the same state lifecycle. They should not silently bypass observed mode selection, project continuity, or PR verification.
