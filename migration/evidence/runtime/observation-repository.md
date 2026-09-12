# Observation repository evidence

- Direct check: `pnpm exec vitest run apps/server/test/observation-repository.test.ts --passWithNoTests=false`.
- Result: 3 tests passed. Provenance and normalized metadata/provider observation child tables round trip idempotently, affiliations are reconstructed by ordinal, and current-facts acceptance is protected by expected revision/hash CAS with stale updates leaving current facts unchanged.
- Boundary: identity merge decisions remain outside the repository; asset and reference publication are separate tasks.
