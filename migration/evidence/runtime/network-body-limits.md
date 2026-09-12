# Network body limit evidence

- Direct checks: `pnpm exec vitest run apps/server/test/network-body-limits.test.ts apps/server/test/network-http-framing.test.ts --passWithNoTests=false`.
- Result: 3 tests passed. Limits count decoded response body bytes, exclude large headers, and reject truncated/over-limit responses.
- Boundary: complete retry/redirect request-state integration remains open.
