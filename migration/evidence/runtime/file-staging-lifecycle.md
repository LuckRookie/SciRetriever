# File staging lifecycle evidence

- Direct checks: `pnpm exec vitest run apps/server/test/immutable-file-store.test.ts apps/server/test/file-staging-lifecycle.test.ts --passWithNoTests=false`.
- Result: 7 tests passed. Handoff seals the stage, returns a relative reference, later writes fail, discard is repeatable, and replacement cleanup preserves the competing object.
- Boundary: publication and cross-process locking are separate downstream tasks.
