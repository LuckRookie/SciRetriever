# File locking evidence

- Direct check: `pnpm exec vitest run apps/server/test/file-locking.test.ts --passWithNoTests=false`.
- Result: 4 tests passed. Same-key ownership is exclusive, release is owner checked and idempotent, symlink lock directories fail closed, an independent process is excluded, normal exit releases the lock, and SIGKILL leaves an unconfirmed lock that cannot be stolen.
- Boundary: production shutdown orchestration remains part of Application lifecycle.
