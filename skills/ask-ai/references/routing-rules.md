# Routing Rules

## Default

- 「AIに聞いて」→ `ask-ai both "質問"`（両方に並列）

## Explicit provider override

- 「ChatGPTに聞いて」「C」→ `ask-ai chatgpt "質問"`
- 「Geminiに聞いて」「G」→ `ask-ai gemini "質問"`
- 「クロス議論」「D」→ クロス議論モード（SKILL.md 参照）

## Auto-upgrade to cross-discussion

以下のいずれかに該当する場合、クロス議論モードに切り替える:

1. 比較、クロスチェック、複数の視点を求めている
2. 選択肢の最終選定（アーキテクチャ/ツール/設計）
3. リスク評価やトレードオフの検討
4. キーワード: `compare`, `cross-check`, `second opinion`, `tradeoff`, `pros and cons`, `比較`, `クロス議論`, `反証`, `別視点`

## Cost and speed control

- 低リスク/単純な事実確認 → 単一AI（ユーザー指定がなければ both）
- 重要な判断 → クロス議論を推奨
