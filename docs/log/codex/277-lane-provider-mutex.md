# 277 Lane Provider Mutex

## Task
Add per-`(agentId, provider)` serialization for `/api/ask` so simultaneous sends in the same lane and same provider cannot interleave on a shared tab. Preserve parallelism for different lanes and different providers.

## Changes
- Added `laneMutexes: Map<string, Mutex>` in `src/main.ts` keyed by `${agentId}:${provider}`.
- Added `runProviderWithConcurrencyGuards()` to acquire locks in this order:
  1. lane/provider mutex
  2. global `toolMutex` semaphore
  3. provider execution
  4. global release
  5. lane release
- Moved global semaphore acquisition from whole handler scope to each provider branch.
- Kept `target=both` provider-parallel: ChatGPT and Gemini each acquire their own lane/provider lock and one global slot.
- Updated `docs/SPEC.md` with the concurrency contract.

## Deadlock Avoidance
Lane lock is acquired before the global semaphore. Same-lane/provider waiters therefore wait without occupying global slots, so unrelated lanes/providers can continue and release capacity. This avoids the deadlock shape where all global slots are held by requests waiting on a lane lock.

## Verification
```text
npm run check-format -> pass
npm run typecheck -> pass
npm test -> pass
npm run build:noext -> pass
intent-guard check -> pass
```

## Scope Notes
- Did not split `fast-chat.ts`.
- Did not change provider implementations or session persistence.
- Did not touch `src/extension`.
