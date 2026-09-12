# Network permit evidence

- Direct checks: `pnpm exec vitest run apps/server/test/network-permit.test.ts apps/server/test/network-budget.test.ts --passWithNoTests=false`.
- Result: 11 tests passed. Scope and shared host limits, strictest-limit behavior, fair wakeup, cancellation, idempotent release, body, retry-after and budget counters are covered.
- Boundary: full request orchestration still needs a single request-state retry/cancel integration review.
