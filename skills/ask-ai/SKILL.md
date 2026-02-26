# ask-ai skill (Codex)

## Purpose

Provide a simple "ask-ai" style workflow in Codex using `chrome-ai-bridge` MCP tools.

This skill defaults to **Gemini-first** and upgrades to **cross-discussion** (Gemini + ChatGPT in parallel) when the request is comparative, decision-oriented, or explicitly asks for multiple perspectives.

## Prerequisites

1. `chrome-ai-bridge` MCP is configured in Codex.
2. Chrome extension is installed and enabled (`build/extension` for local development).
3. ChatGPT / Gemini tabs are open and logged in.

## Routing Rules

Read `references/routing-rules.md` and apply it strictly.

## Input Normalization

Before calling tools, normalize the user request using `assets/prompt-template.md`.

## Tool Selection

1. Default: `ask_gemini_web`
2. Explicit ChatGPT request: `ask_chatgpt_web`
3. Cross-discussion mode: `ask_chatgpt_gemini_web`

## Output Contract

Always return in this structure:

1. `Mode`: `gemini-only` or `cross-discussion`
2. `Answer`: main answer
3. `Cross-check`: include only in cross-discussion mode
   - `Agreement`
   - `Differences`
   - `Decision hint`

## Failure Handling

1. Gemini-only mode:
   - If extension/connection timeout occurs, report recovery steps and stop.
2. Cross-discussion mode:
   - If one side fails, return successful side + failure reason for the other.
3. Do not silently switch providers without stating it.

