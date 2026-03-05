# ask-ai prompt template

質問を構築する前に、以下で整理する。

## Normalized request

- Goal:
- Constraints:
- Desired output format:
- Preferred provider (if specified):
- Need cross-discussion? (`yes` / `no`):

## Execution decision

- Selected mode: `chatgpt` / `gemini` / `both` / `cross-discussion`
- Selected command: `ask-ai <mode> "質問"`
- Why this mode:

## Response format

Return:

1. `Mode`
2. `Answer`
3. `Cross-check` (only for cross-discussion):
   - `Agreement`
   - `Differences`
   - `Decision hint`
