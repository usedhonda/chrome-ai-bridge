# CI policy

This repository uses two CI lanes:

1. **Required lane (`Compile and run tests`)**
   - Runs fast, deterministic checks via `npm run test`.
   - Purpose: catch packaging/protocol regressions without browser session dependencies.

2. **Browser E2E lane (`Browser E2E tests`)**
   - Runs browser-dependent scenarios separately.
   - Triggered by manual dispatch and nightly schedule.
   - Marked as best-effort to avoid blocking routine PR merges.

## Script contracts used by workflows

The workflows depend on these scripts in `package.json`:

- `test`
- `docs`
- `generate-docs`

If any workflow references a new script name, add the script in `package.json` first.

## Release preflight

Release workflows run these checks before publish:

- Verify required npm scripts exist.
- Run `npm pack --dry-run`.

This catches missing script wiring and packaging issues before `npm publish`.
