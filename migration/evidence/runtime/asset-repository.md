# Asset repository evidence

- Direct check: `pnpm exec vitest run apps/server/test/asset-repository.test.ts --passWithNoTests=false`.
- Result: 4 tests passed. Asset rows reference relative artifact identity; parser Markdown/resources and literature-asset publication retain provenance and are replaced as one current closure; LiteratureContent readback returns artifact identity and input hashes; FileStore bytes are read back and hashed against the Catalog descriptor.
- Failure proof: mismatched current metadata/PDF/parser input and invalid reference text fail inside the transaction; the previously accepted content remains readable.
- Boundary: bytes are intentionally read through FileStore and verified there; this repository stores only relative references, hashes, sizes and provenance.
