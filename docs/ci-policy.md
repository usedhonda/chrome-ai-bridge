# CI policy

## Required checks

The `Compile and run tests` workflow runs `npm test` on the configured Node.js and operating-system matrix. The command runs deterministic browser-workflow tests and type checking. It does not require a signed-in ChatGPT or Gemini browser. The `[Required] Tests passed` job remains the aggregate result for branch protection.

## Optional workflow check

The manually dispatched `Browser workflow checks` workflow runs `npm run test:browser-use`. It checks CLI/state/prompt/PR-verification behavior without live provider sessions. There is no nightly provider login or UI-automation job. The workflow file retains its historical `e2e-browser-tests.yml` filename, but its output is not evidence that ChatGPT Pro or Gemini Thinking was exercised live.

Use the [live verification recipe](user/workflows.md#live-verification-recipe) in an authorized agent/browser session to verify actual provider behavior. Record that outcome separately from CI.

## Documentation and package checks

Workflows use `test`, `docs`, and `generate-docs` from `package.json`. Keep their contracts aligned with the active v3 command set. If a workflow needs another command, define the script before referencing it.

Release preflight verifies required scripts and runs `npm pack --dry-run` to catch missing package files. A successful package check is not permission to publish or tag a release; follow the requested delivery scope.
