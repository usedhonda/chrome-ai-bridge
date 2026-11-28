# Coding playbook for the calling agent

Use this with the [ask-ai lifecycle](../SKILL.md); it guides task writing, not state transitions.
Treat the recommendations as workflow heuristics from CAB's observed failures and from ChatGPT Pro's and Gemini Carbon's own advice (2026-11-28), not model benchmarks.

Read: [Routing](#choose-the-deliverable) · [Pro](#request-a-useful-pro-pr) · [Gemini](#give-gemini-a-self-contained-code-question) · [Checking Gemini code](#check-geminis-code-before-applying-it) · [Design → PR](#design-with-gemini-implement-with-pro) · [Review loops](#run-a-review-loop) · [New conversations](#continue-or-start-a-new-conversation) · [Verification](#check-before-reporting) · [Anti-patterns](#avoid-these-traps).

## Choose the deliverable

- Honor the user's provider choice and [routing rules](routing-rules.md) first; assign work by access and required output, not assumed speed or intelligence.
- Use ChatGPT Pro for repository work ending in a real PR; use Gemini Carbon with 思考レベル 高 for reasoning over supplied material ending in a chat answer.

| Coding need                             | Assign a concrete job                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation or refactoring           | Ask Pro for one behavior change or compatibility-preserving refactor, with observable acceptance criteria.                                                                                                               |
| Debugging                               | Ask Pro to trace the real entry point, reproduce the failure and fix it; ask Gemini to compare specific hypotheses when a trace and the relevant execution path fit in the prompt.                                       |
| Design review or second opinion         | Give Gemini the proposed interfaces, constraints and a concrete failure scenario; ask which decision fails and why. Use Pro for a repository-grounded design document PR only when that artifact is authorized.          |
| Test design                             | Ask Gemini for inputs, expected observations and cases that distinguish competing implementations; ask Pro to implement the justified tests with the change.                                                             |
| Review of a PR                          | Give Gemini the actual diff plus surrounding code. Ask Pro for review-and-repair, or an explicitly requested review-report PR; do not invent edits to satisfy its PR contract.                                           |
| Concurrency, state machines, algorithms | Gemini, given the full function, its invariants and a trace: it is strongest at walking failure interleavings over compact code.                                                                                         |
| Wide refactor or 10+ file migration     | Pro (or the calling agent locally): Gemini cannot see unattached callers or run the type checker.                                                                                                                        |
| Both providers                          | Default to the design-first loop below: Gemini designs, the caller checks its assumptions, Pro implements the PR, Gemini audits the diff. Use independent parallel questions only when neither needs the other's result. |

- Do not launch `both` to review a PR that does not exist yet. Use separate requests for the sequential implementation/review loop; keep the same stable project identity.
- For advice-only work without write authorization, follow the routing rules rather than turning the question into an unsolicited PR.

## Request a useful Pro PR

- Put the task in `--prompt-file`; supply repository identity and base through CAB options. CAB adds GitHub access, real-PR delivery and no-merge/no-direct-base rules: do not copy those paragraphs into every task.
- Name the starting revision and first entry points: a command/handler, its implementation, relevant types and the nearest test. Ask Pro to confirm the base on GitHub and trace dependencies beyond that initial list.
- Give a reproduction and observable acceptance criteria: “after reconnect, each queued item is delivered once and in order,” rather than “make reconnection robust.” Separate observations from guesses.
- Bound each request to one reviewable outcome. Split migrations into verifiable changes: introduce a compatible adapter, move callers, then remove the old path. Specify each PR's base and track the remaining objective.
- Name exclusions, the working branch or naming prefix, Draft status, and existing verification commands with their working directory. Request actual results or a precise execution blocker.
- Ask for an early coherent commit **visible on GitHub**; a local commit or prose progress report cannot be recovered through the connector. Open a Draft PR at the first useful checkpoint when allowed, then finish the acceptance criteria.
- Keep unfinished criteria in the PR description. Batch validated updates; avoid a push per tiny edit, repeated CI reruns or unnecessary manual workflow dispatches.

Example task body (illustrative paths and commands; replace with the target repository's):

```text
Fix duplicate queued delivery after reconnect.
Read src/client.ts:reconnect, src/queue.ts:drain and tests/queue.test.ts first.
Acceptance: reconnect preserves order, sends each item once, and retains cancellation behavior.
Limit changes to the queue path; preserve its public API and saved-state format.
Use branch fix/reconnect-order and a Draft PR.
From the repository root run npm run typecheck and npm test -- tests/queue.test.ts.
Commit and push the first coherent fix early; open the draft, then finish the checks.
Report which criteria passed, any remaining work, and the final head SHA.
```

## Give Gemini a self-contained code question

- Supply code for public repositories too: a GitHub or PR URL identifies the target but does not provide readable source. CAB already explains Gemini's role and limits; spend task text on the actual question.
- Start with one execution path, in rings: (0) the target file in full, (1) the types, error classes and validators it imports, (2) one or two non-trivial callers and the head of one existing test file so test code matches the runner. Put an `rg -n symbol` summary of other callers in the task text instead of attaching them all.
- Aim for roughly 15–80 KB across 3–8 `--context` entries. Under ~200 lines Gemini guesses about unseen code; well past ~120 KB it starts summarizing instead of checking line by line. CAB's maximum size is not a target.
- Order the task text as: deliverable and scope, runtime/compiler rules (Node version, ESM `.ts` imports, no runtime dependencies, target OSes), facts already checked locally, verbatim evidence, then numbered questions with the answer shape. Order `--context` as shared types first, then targets, then callers and tests.
- Fetch the intended revision locally, then select complete blocks with `--context PATH[:START:END]` under `--root`; identify omissions. Context reads local files, not URLs. Do not attach context to a Pro-only request.
- State the revision and any uncommitted changes. For PR review, supply base/head SHAs, the actual diff and surrounding code; do not pair a PR diff with unrelated current-main files.
- Ask a falsifiable question: “can reconnect race with cancellation and send a canceled item?” Supply ordering assumptions and an observed trace; request a counterexample or reasoning that rules it out.
- Request a compact answer structure: conclusion; findings ordered by severity with path and function, triggering condition and consequence; evidence versus assumptions; minimal patch when useful; proposed tests; exact missing material. Supplied excerpts carry no line numbers, so ask for edits anchored to the function name plus a few verbatim lines, not hand-counted diff hunks. Accept “no supported finding” rather than forcing a bug quota.
- Refresh changed excerpts on follow-ups and name the revision they replace; private requests require explicit context every turn. Fill named gaps with the missing function/type, not another request to open the URL.

Example question alongside the selected code:

```text
Check whether drain can send a canceled item when reconnect and cancel interleave.
Use the supplied diff and source at the stated head revision; the trace is an observation.
For each supported finding give the exact interleaving, path/line, effect and smallest repair.
Then propose a test with inputs and expected observations; label it as proposed, not executed.
If the excerpts cannot settle this, name the missing function or contract and what it would decide.
```

## Design with Gemini, implement with Pro

Use this for any change that needs a design decision or has tricky edge cases. Skip step 1 for a small, well-specified change and go straight to Pro.

1. **Gemini designs.** Send the relevant code (rings above) and ask for the approach: exact type and signature changes, the edge-case list, the tests that must exist, and every assumption about code it could not see.
2. **The caller checks the assumptions** with `rg` and the type checker, and fixes names or signatures that do not match the checkout. Drop or rework anything that fails.
3. **Pro implements.** Send the checked design as the task, with acceptance criteria and verification commands. Tell Pro it is a design to verify against the repository, not a patch to paste; Pro can read callers Gemini never saw and should report where the code disagrees. Because the exploration is already done, Pro spends its conversation on the change itself, which keeps it away from the length limit.
4. **Gemini audits the diff** of Pro's PR against the invariants from step 1. Then run the review loop below for supported findings.

## Run a review loop

1. Inspect Pro's actual branch and PR. Pin the review to base/head SHAs; collect the diff, affected source and relevant existing test/CI results.
2. Give Gemini that material and a review lens, such as saved-state compatibility or duplicate-send prevention. Separate Pro's explanation from observed evidence.
3. Check each finding against the checkout. Send Pro the reviewed SHA, path/line, trigger, consequence and evidence; label unconfirmed hypotheses.
4. Ask Pro to confirm or refute those issues against the code and repair the same branch/PR when appropriate. Example: “At head H, cancel between dequeue and dispatch may leak one send; verify this sequence and fix it without changing order.”
5. Review the delta and relevant checks at the new head. Ask Gemini again for an unresolved risk or material change; stop when acceptance and supported findings are resolved, without a fixed debate count.

- Apply a Gemini proposal only within the user's implementation authorization. A completed Gemini answer is advice; it is neither a repository write nor evidence that Pro's deliverable exists.

## Continue or start a new conversation

- Reuse the saved URL for follow-ups. Send the current PR/head, changed evidence and unresolved question, without replaying the transcript. Serialize requests to the same provider conversation.
- Start a new page for a new project. For an existing project, start a fresh conversation only when explicitly intended or when the provider visibly reports its length limit; do not reset for slowness, a disconnect or uncertain submission.
- On an observed length limit, follow the skill's [length-limit recovery](../SKILL.md#会話の長さの上限): close the run according to its phase, verify actual GitHub progress, then prepare with the same project, a new request ID and `--new-chat`. Do not bypass uncertain-send reconciliation.
- Rewrite a self-contained request with the current goal, scope, acceptance criteria, constraints, confirmed branch/commit/PR, remaining work and minimal checks. Use `--handoff-file` only with `--new-chat`; CAB does not copy the old request automatically.
- Inspect the branch against its base. If it is still at base, request the first bounded implementation slice; if commits exist without a PR, continue those verified commits and create the requested PR. Do not treat prose as saved code. For Gemini, supply current excerpts again.

## Check Gemini's code before applying it

Each check takes seconds locally:

- **Non-erasable TypeScript:** `enum`, parameter properties or missing `import type` pass `tsc` but fail under Node's type stripping. Run the type check and import the changed module once.
- **Invented identifiers:** error codes, union members or helper options inferred from one file. `rg` each new identifier and run the type check.
- **Broken caller contracts:** a tightened check or changed error type that an unseen caller relied on. `rg` every caller before changing public behavior.
- **Stale file copies:** in a reused conversation Gemini patches the last copy it saw. Compare the file's SHA-256 with the one printed for its last attached copy, and resend it if they differ.
- **Defensive creep:** scaffolding for impossible states or a new package in a zero-dependency repo. Check imports and `git diff --stat`; keep a branch only if it has a concrete failing input.
- **OS-specific errno claims:** run a short `node -e` probe before baking an errno check into code.

## Check before reporting

- Inspect the PR's final head, base and diff through GitHub. Check acceptance, excluded paths, API/state compatibility and unexpected generated/private files; CAB validates PR identity and branches, not correctness.
- Inspect existing CI for that exact head. Distinguish passed, failed, pending and skipped; earlier green runs do not prove later edits. Run only the smallest missing check that settles a concrete risk.
- Re-verify consequential claims: a race needs a reachable interleaving; a fix needs the failing path covered; an API claim needs code or primary documentation. Separate reasoning, executed tests and live browser observations.
- Treat two models agreeing as a hypothesis, not independent execution evidence. Do not describe Gemini's excerpt review as a whole-repository audit, or treat a nonempty answer as a verified fix.
- Finish the CAB lifecycle; report the actual PR/branch/head or Gemini answer, acceptance results and unresolved findings/checks. Disclose unfinished work in a checkpoint Draft and any blockers.

## Avoid these traps

- Replace “audit everything and fix everything” with one bounded deliverable; do not spend the whole Pro conversation researching before any recoverable change exists.
- Replace public-URL-only Gemini requests with a coherent code packet; do not relabel the repository as private just to obtain context validation.
- Replace repeated provider disclaimers with task evidence; keep stable rules in CAB rather than overriding them in copied prompt boilerplate.
- Replace “review this” plus a bare PR URL with the actual diff and a named risk; avoid giving both providers identical work without a reason.
- Replace unverified carry-over claims with GitHub-confirmed progress; never discard an uncertain send, manufacture a PR, force a finding, or call a checkpoint the completed task.
