# CI policy

## Required checks

The `Compile and run tests` workflow runs `npm test` (typecheck + build + `node:test`) on Node.js 22.18 and 24 across Linux, macOS, and Windows. Typechecking covers both `src/` and `tests/`: Node's type stripping executes tests without checking their types. The `[Required] Tests passed` job is the aggregate result for branch protection. These checks do not require a signed-in ChatGPT or Gemini browser.

`Check code before submitting` runs `npm run check-format` (ESLint + Prettier) and `npm run docs` (active document links and command reference).

CI output is not evidence that ChatGPT Pro or Gemini Thinking was exercised live. Use the [live verification recipe](user/workflows.md#live-verification-recipe) in an authorized agent/browser session and record that outcome separately.

## Release

`npm-publish.yml` publishes on a pushed `v*` tag or an explicit manual dispatch through npm Trusted Publishing (OIDC). It runs `npm test` first; `prepack` rebuilds `build/`. The job uses GitHub-hosted runners, `id-token: write`, Node 24, and npm 11.5.1 or newer.

Do not supply a long-lived npm publish token. The default npm registry is used without `setup-node`'s `registry-url` option, which would generate token-based `.npmrc` settings and a placeholder `NODE_AUTH_TOKEN`. The npm CLI tries OIDC before falling back to traditional credentials; the mere presence of that variable does not establish that OIDC will fail.

On npm, configure the package's Trusted Publisher for GitHub owner `usedhonda`, repository `chrome-ai-bridge`, workflow filename `npm-publish.yml`, and permission to publish directly with `npm publish`. This job does not declare a GitHub environment, so leave the publisher's environment field unset. See the [official Trusted Publishing guide](https://docs.npmjs.com/trusted-publishers/). Repository tests cannot verify those npm-side settings or a real OIDC exchange. A passing package check is not permission to publish or tag a release.
