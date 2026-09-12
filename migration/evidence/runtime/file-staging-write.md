# File staging write evidence

- Direct checks: `pnpm exec vitest run apps/server/test/immutable-file-store.test.ts apps/server/test/file-staging-lifecycle.test.ts --passWithNoTests=false`.
- Result: 7 tests passed. Stages use owner-only exclusive no-follow files, serialize concurrent writes, enforce byte limits, reject hardlinks and preserve replacement objects during cleanup.
- Boundary: platform-specific fallback behavior remains limited to the supported runtime probe; publication failure injection is recorded under the publication task.
