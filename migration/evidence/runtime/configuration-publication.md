# Configuration publication evidence

- Direct check: `pnpm exec vitest run apps/server/test/configuration-publication.test.ts --passWithNoTests=false`.
- Result: 3 tests passed. Valid TOML is staged, fsynced and atomically published with an expected fingerprint and configuration lock; symlink targets, stale edits and concurrent first creators fail safely.
- Boundary: full editable section round trip and credential transition editing remain in the configuration editor task.
