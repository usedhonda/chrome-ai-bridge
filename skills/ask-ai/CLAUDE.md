<!-- CDX-PERSONA-AGENTS -->
**Read `.codex/config.toml` in this directory and adopt the persona in its `instructions` field.**
<!-- CDX-PERSONA-AGENTS-END -->

# ask-ai スキル管理

ask-ai CLI を使った AI 質問・議論スキル。chrome-ai-bridge リポジトリに統合済み。

## ファイル構成

- `SKILL.md` - スキル本体（CC 用、description でトリガー自動判定）
- `CLAUDE.md` - プロジェクト管理用
- `scripts/ask-ai` - CLI エントリポイント（cab ラッパー）
- `references/routing-rules.md` - ルーティングルール定義
- `assets/prompt-template.md` - プロンプトテンプレート

## 運用

- `~/.claude/skills/ask-ai/` はこのディレクトリへのシンボリックリンク
- cab は symlink 経由で絶対パス解決される

## ask-ai CLI 使い方（CC / Cdx 共通）

### コマンド

| コマンド | 動作 |
|----------|------|
| `ask-ai chatgpt "質問"` | ChatGPT のみに質問 |
| `ask-ai gemini "質問"` | Gemini のみに質問 |
| `ask-ai both "質問"` | 両方に並列で質問 |
| `ask-ai health` | cab デーモンのステータス確認 |
| `ask-ai --help` | ヘルプ表示 |

### トリガーワード → コマンド対応

| トリガー | コマンド |
|----------|---------|
| 「AIに聞いて」 | `ask-ai both "質問"` |
| 「ChatGPTに聞いて」「C」 | `ask-ai chatgpt "質問"` |
| 「Geminiに聞いて」「G」 | `ask-ai gemini "質問"` |
| 「クロス議論」「D」 | クロス議論モード（SKILL.md 参照） |

### 実行例

```bash
# 単純質問
ask-ai chatgpt "useEffectの使い方を教えて"
ask-ai both "async/awaitの違いは？"

# ヘルスチェック
ask-ai health
```

### 注意

- デーモン管理（起動・停止）は cab 側が自動で担当。ask-ai 側での管理は不要
- cab は同リポジトリ内の `scripts/cab` を参照
