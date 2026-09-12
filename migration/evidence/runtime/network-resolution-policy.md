# Network resolution policy evidence

- Direct check: `pnpm exec vitest run apps/server/test/network-resolution-policy.test.ts --passWithNoTests=false`.
- Result: 2 tests passed. IPv4, IPv6, IPv4-mapped IPv6 and reserved/private ranges are classified; mixed answers, malformed answers and rebinding are rejected.
- Boundary: no external resolver or real network was used.
