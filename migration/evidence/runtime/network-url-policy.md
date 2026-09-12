# Network URL policy evidence

- Direct check: `pnpm exec vitest run apps/server/test/network-url-policy.test.ts --passWithNoTests=false`.
- Result: 3 tests passed. Canonical HTTP(S) URLs are produced; userinfo, fragment, sensitive query, traversal, encoded separators and control hazards are rejected before a request boundary.
- Boundary: this is policy-only; full request admission remains open.
