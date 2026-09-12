# OpenAI Responses adapter evidence

- Direct check: `pnpm exec vitest run apps/server/test/responses-adapter.test.ts --passWithNoTests=false`.
- Result: 6 tests passed. JSON and synthetic UTF-8 SSE yielded the same neutral structured result; truncated/incomplete/failed SSE, refusal, duplicate terminal events, duplicate JSON keys and output outside the requested closed schema fail without a JSON retry.
- Boundary: transport is injected fake transport; no real provider or credential was accessed.
