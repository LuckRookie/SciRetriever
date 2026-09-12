# Application lifecycle evidence

- Direct checks: `pnpm exec vitest run apps/server/test/application-lifecycle.test.ts apps/server/test/application-assembly.test.ts --passWithNoTests=false`.
- Result: 3 tests passed. A temporary offline home loads configuration/credentials, creates one worker-backed catalog, FileStore, AgentRuntime and repositories; staged files are discarded, repeated close is safe, a catalog can be reopened after close, and injected failures at database/files/network/agents/schema stages clean previously created resources before recovery.
- Boundary: real network/browser startup is intentionally outside this offline lifecycle evidence.
