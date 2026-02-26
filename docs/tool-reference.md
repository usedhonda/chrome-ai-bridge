<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome DevTools MCP Tool Reference

- **[Navigation automation](#navigation-automation)** (5 tools)
  - [`ask_chatgpt_gemini_web`](#ask_chatgpt_gemini_web)
  - [`ask_chatgpt_web`](#ask_chatgpt_web)
  - [`ask_gemini_web`](#ask_gemini_web)
  - [`get_page_dom`](#get_page_dom)
  - [`take_cdp_snapshot`](#take_cdp_snapshot)

## Navigation automation

### `ask_chatgpt_gemini_web`

**Description:** [RECOMMENDED] Ask ChatGPT and Gemini in parallel via browser (fast CDP path). Use this by default unless user explicitly specifies single AI.

**Parameters:**

- **debug** (boolean) _(optional)_: Return detailed debug info (DOM structure, extraction attempts, timings)
- **question** (string) **(required)**: Question to ask. Do not include secrets/PII. No mention of MCP/AI.

---

### `ask_chatgpt_web`

**Description:** Ask ChatGPT only via browser. Note: For general queries, prefer [`ask_chatgpt_gemini_web`](#ask_chatgpt_gemini_web) to get multiple perspectives.

**Parameters:**

- **createNewChat** (boolean) _(optional)_: Unused (kept for compatibility)
- **debug** (boolean) _(optional)_: Return detailed debug info (DOM structure, extraction attempts, timings)
- **projectName** (string) _(optional)_: Unused (kept for compatibility)
- **question** (string) **(required)**: Question to ask. Do not include secrets/PII. No mention of MCP/AI.

---

### `ask_gemini_web`

**Description:** Ask Gemini only via browser. Note: For general queries, prefer [`ask_chatgpt_gemini_web`](#ask_chatgpt_gemini_web) to get multiple perspectives.

**Parameters:**

- **createNewChat** (boolean) _(optional)_: Unused (kept for compatibility)
- **debug** (boolean) _(optional)_: Return detailed debug info (DOM structure, extraction attempts, timings)
- **projectName** (string) _(optional)_: Unused (kept for compatibility)
- **question** (string) **(required)**: Question to ask. Do not include secrets/PII. No mention of MCP/AI.

---

### `get_page_dom`

**Description:** Get DOM elements from the connected ChatGPT/Gemini page using CSS selectors. Use this to debug selector issues or find correct element patterns when the UI changes. Returns element counts, attributes, text content, and outer HTML for each selector.

**Parameters:**

- **selectors** (array) _(optional)_: CSS selectors to query. If empty, uses default selectors for the target.
- **target** (enum: "chatgpt", "gemini") **(required)**: Which AI to get DOM from

---

### `take_cdp_snapshot`

**Description:** Take a snapshot of what CDP is seeing on the ChatGPT/Gemini page. Use this to debug connection issues or verify page state. Returns URL, title, input field state, button state, message counts, and optionally a screenshot.

**Parameters:**

- **bodyTextLimit** (number) _(optional)_: Max characters of body text to include
- **includeScreenshot** (boolean) _(optional)_: Include a screenshot (saved to /tmp)
- **target** (enum: "chatgpt", "gemini") **(required)**: Which AI to take snapshot from

---
