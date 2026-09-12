# Network cancellation evidence

- Direct check: `pnpm exec vitest run apps/server/test/network-cancellation.test.ts --passWithNoTests=false`.
- Result: 1 test passed. Abort during response reading closes the local response and the request promise fails with a stable HTTP error.
- Boundary: queue and connection cancellation have separate lower-level coverage; end-to-end all-stage cancellation remains part of NETWORK-BUDGET.
