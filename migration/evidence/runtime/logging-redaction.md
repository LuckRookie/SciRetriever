# Logging redaction evidence

- Direct check: `pnpm exec vitest run apps/server/test/logging-redaction.test.ts --passWithNoTests=false`.
- Result: 2 tests passed. Secret fields, URL userinfo and sensitive query values are removed while an explicit safe-field allowlist retains provider/status context; minimum level filtering keeps diagnostics separate from result payloads.
- Boundary: application-wide logger injection and configured adapter wiring remain open under APP-COMPOSITION.
