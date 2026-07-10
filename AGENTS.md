# Chrome AI Bridge

## Session Startup Tasks

### Read SPEC.md First - Mandatory

**Execute at session start (before any work):**

```bash
cat docs/SPEC.md
```

This project has complex architecture (CDP, Chrome Extension, REST API). SPEC.md contains:
- Architecture overview and component relationships
- ChatGPT/Gemini operation flows and selectors
- Response extraction logic (especially Thinking mode)
- Timeout values and retry logic
- Troubleshooting guide

**Always read SPEC.md before investigating issues or making changes.**

### Chrome Profile Cleanup Check

**Execute at session start:**

```bash
# Check profiles unused for 30+ days
find ~/.cache/chrome-ai-bridge/profiles -maxdepth 1 -type d -mtime +30 2>/dev/null | while read dir; do
  [ "$dir" != "$HOME/.cache/chrome-ai-bridge/profiles" ] && du -sh "$dir"
done
```

If targets exist: Show list, get user approval, then `rm -rf`.

### Work State Verification - Mandatory

**Execute immediately after context refresh:**

```bash
ls -t docs/log/claude/*.md | head -3
```

Read latest log, understand previous work, report "Resuming from: [summary]".

### Work Log Recording - Required

Create/update `docs/log/claude/[yymmdd_hhmmss-task.md]` at:
- Task start, milestone completion, errors, waiting for verification, task completion

**Log format:**
```markdown
# [Task Summary]

## Status
- Date: YYYY-MM-DD HH:MM
- Status: [in_progress / waiting / completed / error]

## Current Task
[Description]

## Progress
- [x] Done
- [ ] Not done <- here

## Recent Work
- What was done
- What to do next

## Blockers
- [if any]
```

### Git Commit Before Plan Execution - Mandatory

Before `EnterPlanMode -> ExitPlanMode`:
1. Check `git status` for uncommitted changes
2. If changes exist: Ask user "Uncommitted changes found. Commit first?"
3. Approved -> commit, Rejected -> continue with warning

---

## Strict Rules

### chrome-ai-bridge Usage Restrictions - Mandatory

**Chrome AI Bridge is for ChatGPT/Gemini queries only.**

**CLI commands (CC/Cdx 共通):**
```bash
ask-ai chatgpt "質問"   # ChatGPT のみ
ask-ai gemini "質問"    # Gemini のみ
ask-ai both "質問"      # 両方に並列
ask-ai health           # デーモン状態確認
```

CLI パス: `skills/ask-ai/scripts/ask-ai`

**Note:** MCP ツール（`ask_chatgpt_web` 等）は廃止済み。CLI を使うこと。
一般的なブラウザ操作には Playwright MCP (`mcp__plugin_playwright_playwright__*`) を使用。

---

### Deprecated Scripts - Mandatory

**Do not use:**
- `scripts/start-mcp-from-json.mjs` - Old daemon startup
- `scripts/configure-codex-mcp.mjs` - Codex only
- `scripts/codex-mcp-test.mjs` - Codex only

**Use instead:**
```bash
npm run test:chatgpt -- "question"
npm run test:gemini -- "question"
npm run cdp:chatgpt
npm run cdp:gemini
```

---

### Extension Version - Mandatory

**Bump `manifest.json` version after any `src/extension/` changes.**

```json
// src/extension/manifest.json
"version": "1.1.0",  // <- increment every time
```

Target files: All files under `src/extension/`

---

### Development Flow - Mandatory

**This dev environment uses local path reference, npm publish not needed for dev.**

```bash
# Run daemon directly from local build
node $HOME/projects/mcp/chrome-ai-bridge/scripts/cli.mjs
```

**Standard dev flow:**
```bash
vim src/browser.ts       # 1. Edit
npm run build            # 2. Build
npm run typecheck        # 3. Type check only
git add -A && git commit -m "..." && git push  # 4. Push
```

**Before user verification:**
- If changes include `src/extension/**`: Run `npm run build` first
- Only request verification after build completion

**Testing:**
- `npm test` not needed (slow & existing issues)
- `npm run typecheck` only
- Manual verification after Claude Code restart

**npm publish (for user releases only):**
```bash
# 1. Update version in package.json
# 2. git push
git add -A && git commit -m "chore: bump version" && git push origin main
# 3. Create & push tag manually
git tag vX.X.X && git push origin vX.X.X
# 4. Verify (wait ~30s)
npm view chrome-ai-bridge version
```

**Forbidden:**
- Local `npm publish` (EOTP error - WebAuthn 2FA issue)
- Relying on auto-tag workflow

---

### Efficient Debugging Rules - Mandatory

**Avoid daemon restarts** - Direct execution is faster.

| Situation | Method |
|-----------|--------|
| Single function debug | Direct execution script |
| E2E verification | `cab` CLI |
| UI element investigation | Manual browser check |
| Error identification | Logs + direct execution |

**Test questions - BAN avoidance:**

Forbidden:
- `1+1?` - Obviously a test
- `Connection test` - Automation trace
- `Hello` / `OK` - Meaningless

Recommended:
```
How do I deep copy an object in JavaScript? Include code example.
How to read files asynchronously in Python?
Explain generic types in TypeScript briefly.
```

**Direct execution scripts:**
```bash
npm run build
npm run test:chatgpt
npm run test:gemini
npm run test:both
npm run test:network -- chatgpt  # Network intercept test
npm run test:network -- gemini   # Network intercept test
```

**Log monitoring:**
```bash
tail -f .local/debug.log
```

---

### Test Suite - Regression Prevention

**継続的テストスイート** - 過去の問題再発を防ぐ。

```bash
# 基本動作確認（smoke）
npm run test:smoke

# 過去の問題再発確認（regression）
npm run test:regression

# 全シナリオ実行
npm run test:suite

# 特定シナリオのみ
npm run test:suite -- --id=chatgpt-thinking-mode

# デバッグ情報付き
npm run test:suite -- --debug
```

**シナリオ定義**: `scripts/test-scenarios.json`
**レポート保存先**: `.local/chrome-ai-bridge/test-reports/`

**タグ一覧:**
| タグ | 説明 |
|------|------|
| `smoke` | 基本動作確認（新規チャット、並列クエリ） |
| `regression` | 過去の問題再発確認（既存チャット再接続、Thinkingモード） |
| `chatgpt` | ChatGPT関連のみ |
| `gemini` | Gemini関連のみ |

**新しい失敗パターンが見つかったら:**
1. `scripts/test-scenarios.json` にシナリオ追加
2. `npm run test:suite -- --id=<新シナリオID>` で動作確認

---

### ChatGPT/Gemini Question Construction - Required

Include:
1. **Context**: Project, tech stack, situation
2. **Problem**: Symptoms, error messages
3. **Tried**: Solutions attempted and results
4. **Question**: Numbered, specific
5. **Expected format**: Code examples, steps, comparison table

**Good example:**
```
chrome-ai-bridge project: EOTP error during npm publish.

Environment:
- npm 11.3.0 / Node.js 24.2.0
- 2FA: WebAuthn (Touch ID) only

Tried:
1. npm login --auth-type=web -> Success
2. npm publish --auth-type=web -> EOTP error

Questions:
1. Why EOTP error even with auth-type=web?
2. Can I publish with Touch ID only?
3. Is Trusted Publishing (OIDC) a good alternative?

Provide code examples or specific steps.
```

### Timestamp Rule for Logs

Use: `date '+%y%m%d_%H%M%S'` (client local time)
Don't use: `TZ='Asia/Tokyo' date '...'` (no timezone forcing)

---

### AI Query Default Behavior

**Rule:** When user says "ask AI", use `ask-ai both "質問"` (both AIs in parallel).

**Trigger patterns for single AI:**
- "ChatGPTに聞いて" → `ask-ai chatgpt "質問"`
- "Geminiに聞いて" → `ask-ai gemini "質問"`

**Trigger patterns for multi-AI (三者議論):**
- "三者議論して"
- "深掘りして"
- "複数のAIに聞いて"

**Forbidden:**
- Asking "Which AI should I ask?"
- Using parallel query for simple questions

---

## Codex Defaults (Codex 向け)

### Chrome Instance
- Use the **already running** Chrome instance unless explicitly instructed otherwise.
- Do **not** launch a new Chrome profile unless the user asks.
- When loading the extension for local testing, default to `build/extension`.
- For Codex-driven checks, proceed without re-asking these basics.
- Only ask when blocked (missing config, missing tool, permission/GUI restriction, or conflicting explicit user instruction).

### Daemon Verification
- Goal: **open an existing Chrome tab to ChatGPT and verify send/receive via the daemon from Codex**.
- Before asking the user, **inspect local config** (`codex-config.toml`, `server.json`) to find the daemon config.
- If a ChatGPT tab is required, open it in the existing Chrome without asking again.
- If a required action cannot be performed from Codex (e.g., GUI permission), report the exact blocker and the minimal user action needed.
- When requesting an extension reload, always include the extension version from `src/extension/manifest.json`.
- Never instruct the user to reload the extension before running `npm run build` and confirming the version is updated.
- When reporting extension status, always state: (1) build done, (2) manifest version, (3) reload required.
- If the task is unfinished and can be continued without user intervention, keep iterating until success or a concrete blocker.
- If progress stalls, propose switching to Playwright-style transport/flow when:
  - Two successive fixes fail to improve `pages`/`snapshot`.
  - `browser.pages()` remains empty after target/attach fixes.
  - OOM or reconnect loops recur.

### Verification Steps
1. Ensure the daemon is running.
2. In the existing Chrome, open a new tab to `https://chatgpt.com`.
3. Verify the extension can interact with the page (open, focus, send message, receive response).
4. Report the exact observed behavior and any errors.

### Change Discipline
- Do not trade away existing working behavior unless explicitly approved.
- Prefer the option that preserves current auto-connect paths and avoids manual steps.
- If a change has potential regressions, clearly list the tradeoffs and get approval before proceeding.
- Do not propose designs that are knowingly weaker than Playwright's extension2 baseline when the goal is speed/reliability.

---

## References

- **Technical spec**: `docs/SPEC.md`
- **Project overview**: `docs/SPEC.md` (Project Overview section)
- **Development workflow details**: `docs/SPEC.md` (Development section)
