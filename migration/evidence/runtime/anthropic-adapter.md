# Anthropic adapter evidence

- Direct check: `pnpm exec vitest run apps/server/test/anthropic-adapter.test.ts --passWithNoTests=false`.
- Result: 3 tests passed. Ordered JSON text blocks and Anthropic's explicit SSE message terminal state were reconstructed into a neutral structured result; deltas outside an active block and provider error events fail at the protocol boundary.
- Boundary: synthetic response and injected transport only.
