# AGENTS.md: SciRetriever

Rules for any coding agent or contributor working inside
`literature/retrieval/SciRetriever/`. These are directives, not suggestions.
The parent workspace file at [`../../../AGENTS.md`](../../../AGENTS.md) still
applies in full; the rules below add to it and never relax it.

## Read this first

1. Read [ADR 0001: SciRetriever Scope and Boundary](docs/adr/0001-sciretriever-scope-and-boundary.md) before you plan or write any change. It is the source of truth for scope.
2. Read [the architecture principles](docs/architecture/principles.md) for the responsibility matrix, the `DocumentPackage` contract, and the review checklist.
3. If a task conflicts with the ADR, stop and raise it. Do not code around the boundary.

## Hard constraints

Each rule below is enforceable. A change that breaks one does not merge until it is fixed or a new ADR authorizes it.

- **Stay on SciRetriever's side of the boundary.** SciRetriever acquires, preserves, normalizes, catalogs, and lightly structures literature, and it stops at the `DocumentPackage`. Do not build domain extraction, analytics, prediction, or planning here.
- **No domain schema in the catalog.** Never add a reaction, molecule, route, yield, or any other domain-specific field, table, or column to the catalog. The catalog may hold a domain-run row that carries only status, an output pointer, and a hash. It carries no domain payload.
- **Domain output stays external and portable.** Domain results are JSONL (authoritative) plus optional flattened CSV, shipped with a schema, a manifest, and a validation report, written under a configured storage root. Do not turn any generated JSONL or CSV into a catalog record.
- **No writes to retired database paths.** The nine Batch 015 databases are retired with no replacement. Do not create, recreate, or write to any of them:
  - `all.db`, `all_bak.db`, `CR_energetic_materials.db`, `CR_energetic_materials_synthesis.db`, `CR_title_cyclo-N5.db`, `GS.db`
  - `work/old_database/crossref.db`, `work/old_database/Organic_synthesis.db`, `work/old_database/paper.db`

  Keep the existing guard (`reject_retired_database_creation`) and the staged-write guard (`require_staged_write_override`) intact. Do not remove or weaken them. Database access stays in existing-file mode; explicit creation at a retired active path is always refused.
- **No large BLOBs in the relational store.** Reference documents and images by filesystem path and content hash. Never store file bytes as relational BLOBs.
- **Never mutate a raw asset.** Downloaded files are immutable evidence. Write once, hash, and leave them alone. Fix normalization by re-running against the same raw asset, not by editing outputs or originals in place.
- **No hardcoded workspace paths.** Resolve every path from configuration or from `workspace_paths` discovery (`SCIRETRIEVER_WORKSPACE_ROOT` overrides discovery; explicit CLI paths win). Do not commit corpora or datasets into the repository. Data lives under configured storage roots, outside the code tree.
- **Preserve provenance.** Acquisition, normalization, and light structuring each add to lineage. No step may drop where a thing came from, how it was fetched, or which input produced which artifact.
- **Integrate by stable reference.** Downstream code depends on `document_id`, `file_id`, `artifact_id`, hashes, and provenance. Do not expose or couple to internal ORM tables across the boundary.
- **Keep light structure loss-aware.** Summaries and tags are discovery aids and are lossy. Keep full normalized sections, tables, references, and evidence in the `DocumentPackage`. Do not let a summary become the only copy of content.
- **Legacy enters through adapters.** The old `Paper` ORM, the `Optera` CRUD layer, and the standalone LLM scripts are legacy. Wrap them with adapters when integrating. Do not let their shapes define the v2 schema or module boundaries.
- **Modular monolith only.** Do not add microservices, an external workflow platform, a vector store, or a web UI without a new ADR.

## When you must change the boundary

If a task genuinely requires changing scope (for example, altering the
`DocumentPackage` contract, adding a domain field, or introducing a new runtime
component), do not edit ADR 0001 to fit the code. Author a new, dated ADR that
supersedes it, following the "When a new ADR is required" section of
[ADR 0001](docs/adr/0001-sciretriever-scope-and-boundary.md#when-a-new-adr-is-required).
Clarifications that do not change a decision may be edited in place.

## Before you finish

Run the [review checklist](docs/architecture/principles.md#review-checklist)
against your change. Every box must be checked. Preserve the operational facts
and safeguards documented in the [README](README.md); do not delete existing
operational information when editing docs.
