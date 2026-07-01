# 272 - Auth Redirect Deleted-Chat Guard

Date: 2026-07-01

## Task

Hardening NIT2(b): avoid treating same-origin auth/login/onboarding redirects as deleted-chat signals.

## Implementation

Changed `src/fast-cdp/fast-chat.ts`:

- added `isAuthOrOnboardingUrl()`;
- excluded ChatGPT auth/login/signin/signup/onboarding/account redirects from deleted-chat detection;
- excluded Gemini auth/login/signin/onboarding/account redirects from deleted-chat detection;
- excluded `accounts.google.com` redirects.

This keeps valid saved chat URLs from being dropped during login or onboarding transitions.

## Verification

Commands:

```bash
npm run check-format
npm test
```

Both passed.

## Scope

- No `src/extension/**` changes.
- No session isolation changes.
- No retry behavior changes in this substep.
