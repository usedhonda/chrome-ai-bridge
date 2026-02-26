# ask-ai prompt template

Use this internal template before tool execution.

## Normalized request

- Goal:
- Constraints:
- Desired output format:
- Preferred provider (if specified):
- Need cross-discussion? (`yes` / `no`):

## Execution decision

- Selected mode: `gemini-only` or `cross-discussion`
- Selected tool:
- Why this mode:

## Response format

Return:

1. `Mode`
2. `Answer`
3. `Cross-check` (only for cross-discussion):
   - `Agreement`
   - `Differences`
   - `Decision hint`

