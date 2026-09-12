# File staging write evidence

- Direct checks: `pnpm exec vitest run apps/server/test/immutable-file-store.test.ts apps/server/test/file-staging-lifecycle.test.ts --passWithNoTests=false`.
- Result: 7 tests passed. Directory replacement, directory-entry replacement, hardlink and over-limit reads fail closed; cleanup does not delete a replacement entry.
- Boundary: the implementation uses descriptor binding on Linux; other platform fallbacks remain governed by the runtime support matrix.
