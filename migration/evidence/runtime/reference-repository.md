# Reference repository evidence

- Direct check: `pnpm exec vitest run apps/server/test/reference-repository.test.ts --passWithNoTests=false`.
- Result: 1 test passed. Directed references are idempotent; provider and metadata-text support plus a stable read-only snapshot are returned through typed repository methods; self-references, missing source text and invalid indexes are rejected by the relational boundary.
- Boundary: content-text support uses the same source/content/index checks; broad Library query projections remain a later business block.
