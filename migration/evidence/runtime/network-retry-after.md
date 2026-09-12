# Retry-After evidence

- Direct checks: `pnpm exec vitest run apps/server/test/network-retry-after.test.ts apps/server/test/network-budget.test.ts --passWithNoTests=false`.
- Result: 13 tests passed. Delta-seconds/date parsing is bounded; invalid values fail; an explicit loop consumes retry budget and applies response-header Retry-After through the shared coordinator.
- Boundary: provider adapters still have no implicit retry path; higher-level adapter integration remains a later task.
