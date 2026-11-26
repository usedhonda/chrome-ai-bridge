# Provider routing

Use the user's explicit provider first. The same lifecycle applies through `ask-ai` or `cab`; these aliases prepare work for the calling agent's browser tools.

| Request                                                           | Provider                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| ChatGPTに依頼 / ChatGPTに聞いて / C in established ask-ai context | `chatgpt`                                                        |
| Geminiに聞いて / G in established ask-ai context                  | `gemini`                                                         |
| 両方に聞いて / AIに聞いて with no provider specified              | `both`                                                           |
| クロス議論 / D in established discussion context                  | Separate provider requests with the same stable project identity |

Do not infer that a single letter in unrelated text invokes this workflow. Preserve the requested task scope and use known project/repository context.

## Output contract is part of routing

ChatGPT uses Pro and must produce an actual branch / PR as well as its chat answer. Gemini uses the Neon model with high thinking level and returns its answer in chat. For a request that only needs discussion and does not authorize repository changes, use Gemini when compatible with the user's provider choice; otherwise clarify the requested deliverable rather than inventing a code change merely to obtain a PR.

For private repositories, each Gemini request needs selected code context. `both` does not make the private repository accessible to Gemini and does not require sending the selected code to ChatGPT.

## Multiple perspectives

When the user requests comparison or cross-discussion, keep each provider's conversation URL. Ask focused follow-ups about an actual unresolved point instead of imposing a fixed number of rounds. Cross-check claims against the repository and observed results. Do not assume a provider is faster or more accurate for every task.

Do not start parallel operations against the same provider conversation. Independent ChatGPT and Gemini tabs may run concurrently. A completed Gemini answer never substitutes for the ChatGPT PR requirement.
