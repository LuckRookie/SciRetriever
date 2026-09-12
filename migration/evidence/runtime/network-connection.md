# Network connection evidence

- Direct checks: `pnpm exec vitest run apps/server/test/network-connection.test.ts apps/server/test/network-http-framing.test.ts --passWithNoTests=false`.
- Result: 4 tests passed. Unverified destinations cannot invoke a connector; admitted sockets use the fixed address; framing/truncation and body overflow fail without producing a false complete response.
- Boundary: TLS hostname mismatch is covered by the existing loopback TLS test in `network-admission.test.ts`; all endpoints are local fixtures.
