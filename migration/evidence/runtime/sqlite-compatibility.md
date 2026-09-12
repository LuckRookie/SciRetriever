# SQLite Worker and v1 schema evidence

- Direct checks: `pnpm typecheck`; `pnpm exec vitest run apps/server/test/sqlite-compatibility.test.ts apps/server/test/observation-repository.test.ts apps/server/test/asset-repository.test.ts apps/server/test/reference-repository.test.ts --passWithNoTests=false`.
- Result: 9 tests passed in the current run. The worker owns the `node:sqlite` connection, uses canonical metadata hashes, rejects unknown/closed commands, loads the repository v1 manifest fingerprint, supports stable signed pagination, round trips relation-shaped literature/observation/provider rows, preserves FTS projection, and rolls back invalid relational publications.
- Schema source: `src/sciretriever/storage/sqlite/schema.py` and its manifest modules, copied into an application-owned TypeScript manifest for runtime use; no historical reference bundle is a dependency.
- Boundary: the repository API is still a minimal foundation. Full business publication/CAS/read-model parity remains open.
