# Repository task

Use this structure to write the task file. CAB adds the provider-specific repository, mode, and output contract; do not weaken or duplicate those instructions.

## Goal

Describe the concrete result and why it is needed.

## Repository context

- Relevant component and current behavior:
- Base branch or commit, if known:
- Runtime, module system and compiler rules that code must respect (for example Node version, ESM `.ts` imports, no runtime dependencies, target OSes):
- Facts already checked locally about code the provider cannot see (for example an `rg` summary of callers):
- Scope and constraints:

## Evidence

Include verbatim errors, logs and diffs, reproduction steps, and what has already been checked. Distinguish observations from assumptions. Gemini cannot read the repository even when it is public, so select through `--context` the target files in full, the types they import, and one or two representative callers or tests for code questions (required for private repositories). CAB already tells Gemini its role and limits; do not repeat them here.

## Requested work

State the specific implementation or review questions, the answer shape you want (for example edits anchored to function names, or findings ranked by severity with a concrete failure case and a minimal fix), acceptance criteria, and useful verification commands. Do not ask the provider to invent test results, inaccessible file contents, branch names already created, or PR URLs.

## Follow-up context

For a continuation, name the remaining issue and every file changed locally since the preceding request, so older copies are treated as stale. Keep the same CAB project/provider conversation. Send Gemini a compact diff and refreshed `--context` for the affected files.
