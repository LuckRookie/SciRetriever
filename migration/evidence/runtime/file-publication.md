# File publication evidence

- Direct check: `pnpm exec vitest run apps/server/test/immutable-publication.test.ts --passWithNoTests=false`.
- Result: 5 tests passed. Publication is create-if-absent, same-byte idempotent, different-byte conflict preserving, ancestor-symlink rejecting, target-locked during concurrent publication, and cleans an injected fsync failure without deleting a competing object.
- Boundary: cross-process lock lifecycle remains in FILE-LOCKING.
