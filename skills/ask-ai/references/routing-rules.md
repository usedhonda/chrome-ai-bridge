# Routing Rules (Gemini-first)

## Default

- Use `ask_gemini_web` by default.

## Explicit provider override

- If user explicitly says ChatGPT-only, use `ask_chatgpt_web`.
- If user explicitly says both/parallel/cross-discussion, use `ask_chatgpt_gemini_web`.

## Auto-upgrade to cross-discussion

Upgrade from default Gemini-only to `ask_chatgpt_gemini_web` when one or more of the following is true:

1. User asks for comparison, cross-check, or multiple viewpoints.
2. User asks for final selection among alternatives (architecture/tool/design choices).
3. User asks for risk assessment or tradeoff evaluation.
4. User uses keywords like:
   - `compare`
   - `cross-check`
   - `second opinion`
   - `tradeoff`
   - `pros and cons`
   - `比較`
   - `クロス議論`
   - `反証`
   - `別視点`

## Cost and speed control

- For low-risk/simple factual questions, keep Gemini-only unless user requests cross-discussion.
- For high-impact decisions, prefer cross-discussion.

