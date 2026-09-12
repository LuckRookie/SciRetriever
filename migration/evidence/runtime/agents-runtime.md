# Agents runtime evidence

- Scope: provider-neutral AgentCall validation, role binding/readiness/identity, capability gate, cancellation check, usage/context validation, and unknown adapter error normalization.
- Direct checks: `pnpm typecheck`; `pnpm exec vitest run apps/server/test/agent-runtime.test.ts apps/server/test/agent-network-transport.test.ts apps/server/test/responses-adapter.test.ts --passWithNoTests=false`.
- Result: 7 tests passed. Capability failure occurred before adapter invocation; recursive closed schema, duplicate tools, bounded message/image input, unknown adapter normalization, neutral identity and shared Network transport are covered.
- Boundary: provider protocol parity is recorded separately by the three adapter tests. No real LLM, credential, or network endpoint was contacted.
