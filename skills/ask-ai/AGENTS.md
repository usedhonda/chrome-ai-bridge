# ask-ai maintenance

This directory is the repository-owned shared skill for Claude Code and Codex. Changes are versioned with chrome-ai-bridge; editing it does not install or overwrite a personal skill.

- Keep `SKILL.md` focused on the complete native-browser workflow. Its frontmatter contains `name` and `description` only.
- Keep `scripts/ask-ai` a wrapper for the canonical CAB command contract. Do not add a separate daemon client or provider parser here.
- Resolve the skill-relative script to an absolute path once and use the same executable for all lifecycle commands. Respect a returned structured `commandPrefix`. Do not hard-code `~/.claude` for both harnesses or switch to an older global `cab`.
- Discover browser tools from the active session. Do not add a Bash-only tool allowlist or guessed Claude/Codex tool identifiers.
- Preserve project URLs, mode evidence, the pre-send marker, private Gemini context, and provider-specific completion requirements. Require a saved, non-temporary conversation before readiness.
- Keep `references/routing-rules.md` and `assets/prompt-template.md` consistent with the CLI and `docs/tool-reference.md`.
- Never treat preparation or a prose promise of a PR as task completion. Keep blocked state reviewable. Document explicit non-submission reconciliation separately from final provider failure so recovery neither duplicates a send nor strands a project.
- Validate examples against the current CLI and include the skill changes in the feature PR.
