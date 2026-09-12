# Application assembly evidence

- Direct check: `pnpm exec vitest run apps/server/test/application-assembly.test.ts --passWithNoTests=false`.
- Result: 2 tests passed. The production constructor exposes one shared database, FileStore, Network budget, AgentRuntime, Metadata registry, repositories, parsed ordinary configuration and opaque credential bundle from a temporary home; a configured OpenAI Responses model is bound from ordinary configuration plus the opaque credential bundle, with reasoning/stream identity preserved. Metadata capabilities remain explicit and unavailable until provider ports are injected. No external endpoint is contacted.
- Boundary: execution against a real provider remains outside this offline evidence; the adapter receives the single transport built by bootstrap.
