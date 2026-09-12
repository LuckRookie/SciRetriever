# OpenAI Chat adapter evidence

- Direct check: `pnpm exec vitest run apps/server/test/chat-adapter.test.ts --passWithNoTests=false`.
- Result: 5 tests passed. JSON and usage-terminated SSE content/tool responses, explicit reasoning, finish-state uniqueness, content/tool exclusivity and closed tool argument validation are enforced through the provider-neutral boundary.
- Boundary: synthetic response and injected transport only.
