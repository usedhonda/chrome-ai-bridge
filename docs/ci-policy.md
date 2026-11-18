# CI policy

## Required checks

The `Compile and run tests` workflow runs `npm test` (build + `node:test`) on Node.js 22.18 and 24 across Linux, macOS, and Windows. It does not require a signed-in ChatGPT or Gemini browser. The `[Required] Tests passed` job is the aggregate result for branch protection.

`Check code before submitting` runs `npm run check-format` (ESLint + Prettier) and `npm run docs` (active document links and command reference).

CI output is not evidence that ChatGPT Pro or Gemini Thinking was exercised live. Use the [live verification recipe](user/workflows.md#live-verification-recipe) in an authorized agent/browser session and record that outcome separately.

## Release

`npm-publish.yml` publishes on a pushed `v*` tag through npm Trusted Publishing (OIDC). It runs `npm test` first; `prepack` rebuilds `build/`. Do not set `NODE_AUTH_TOKEN`, which overrides OIDC. A passing package check is not permission to publish or tag a release.
