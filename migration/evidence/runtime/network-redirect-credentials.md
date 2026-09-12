# Network redirect evidence

- Direct checks: `pnpm exec vitest run apps/server/test/network-redirect-credentials.test.ts apps/server/test/network-admission.test.ts --passWithNoTests=false`.
- Result: 9 tests passed. Redirect targets are re-resolved and cross-origin authorization is removed before the next request; private redirect targets are rejected by policy.
- Boundary: no real provider or credential was accessed; the authorization value is synthetic.
