# ADR 0001: SciRetriever Scope and Boundary

- Status: Accepted
- Date: 2026-07-20
- Supersedes: none
- Superseded by: [ADR 0002](0002-work-centered-literature-library.md) only for product center and compatibility of unwanted download-task behavior; the scope boundary remains accepted
- Related: [ADR 0002](0002-work-centered-literature-library.md), [architecture principles](../principles.md), [project README](../../../README.md), [local AGENTS.md](../../../AGENTS.md)

This ADR is the authoritative source of truth for SciRetriever's domain boundary and where it stops. Read it before writing code, reviewing a change, or proposing a new module. It wins on that boundary unless a later ADR explicitly supersedes it; for product center and compatibility of unwanted download-task behavior, ADR 0002 controls as declared above.

## Current applicability

This ADR remains accepted for the domain boundary, the `DocumentPackage` integration contract, immutable evidence, generic light structure, stable downstream references, and the separation of domain extraction. It is not the current product specification. [ADR 0002](0002-work-centered-literature-library.md) controls the Work-centered product, bibliographic `WorkVersion`, foreground execution, PDF-required analysis, and removal or decoupling of unwanted download-task behavior. The [ADR index](README.md) gives the complete authority and reading order.

The `DocumentPackage` boundary describes what SciRetriever may expose to downstream domains; it does not make package generation the product navigation center or end the internal Work/WorkVersion lifecycle. Domain-run bookkeeping and portable domain-pack outputs below are permitted boundary contracts, not first-release SciRetriever requirements. Current implemented behavior is documented by the project [README](../../../README.md), and ideal product behavior is normative in the [requirements](../requirements.md).

## Context

The following context is a historical snapshot as of 2026-07-20, not a description of current implementation or approved target status. SciRetriever had grown as a toolkit for one lab's energetic-materials literature work, and its code mixed two concerns that needed to be separated.

The generic concern is literature handling: search providers (Semantic Scholar, Crossref, Google Scholar, plus an OpenAlex stub), download providers (Sci-Hub, Elsevier/ScienceDirect XML, Wiley, a generic web fetcher, and a CJEM journal scraper), a weak SQLAlchemy `Paper` ORM with a 22-column table and a self-referential citation join, an `Optera` CRUD wrapper, and standalone LLM scripts that summarize parsed documents.

The domain-specific concern is chemistry extraction. It lives today inside one standalone script whose prompt hardcodes reactant, reagent, solvent, conditions, product, and yield fields. That chemistry logic is currently entangled with generic literature handling, and the `Paper` model already carries opinions (a flat metadata table, no provenance, no versioning) that would quietly become the schema for everything downstream if we let it.

At that time, nine legacy databases had been retired in Batch 015 with no replacement, there was no `docs/` directory or recorded architecture, and a future PDF/XML rebuild had not started. This historical state made it the right moment to freeze the initial boundary before the old `Paper` table and chemistry script could set future defaults by accident.

This ADR settles the boundary before that happens. It does not implement anything. It records decisions the project owner finalized after an extended architecture discussion.

## Decision

SciRetriever is a scientific-literature acquisition, cataloging, normalization, and light-structuring system. It is not a chemistry system, and it is not a domain database.

1. **Purpose.** SciRetriever acquires scientific literature, catalogs it, normalizes it into a consistent shape, and adds generic light structure. Nothing about a specific research domain belongs in its core.

2. **Processing boundary.** SciRetriever's cross-domain authority ends at a versioned, provenance-bearing `DocumentPackage`. The package contract can represent supported PDF, XML, or HTML assets without exposing internal ORM tables. Under ADR 0002, the internal product continues to manage Work/WorkVersion, current analysis, tags and references, and target `analyze` requires an accepted primary PDF; XML/HTML cannot independently satisfy analysis. The package remains the stable downstream boundary, not the product center.

3. **Raw assets are evidence.** Downloaded files stay on an external filesystem as immutable evidence. SciRetriever never rewrites a raw asset in place. Large documents and images are referenced by path and hash. They are not stored as relational BLOBs.

4. **What the catalog owns.** The literature catalog manages work identity, external identifiers (DOI, arXiv id, and similar), file records, acquisition history, normalized artifacts, generic summaries, tags, citation links, literature-processing state, failure records, and lineage. That is the full list. Under ADR 0002, literature-processing state means Work/WorkVersion, asset, analysis and reference state plus diagnostic acquisition evidence; it does not preserve task-centered durable control state as a product requirement.

5. **Domain extraction is out of scope.** Pulling reactions, molecules, routes, materials properties, or any other domain payload out of a document is not SciRetriever's job. Independent downstream consumers ("domain packs") do that work using a Prompt, an output Schema, and an optional Validator.

6. **Domain output is a portable dataset, not a database.** A domain pack produces a versioned, portable dataset: JSONL as the authoritative form, an optional flattened CSV export, plus a schema, a manifest, and a validation report. A domain pack does not create or own a domain database. A consumer may later load the dataset into its own database. That loading is the consumer's concern, not SciRetriever's.

7. **The catalog tracks runs, not domain fields.** The catalog may record only that a domain run happened: its status, a pointer to its output, and content hashes. This is a permitted integration boundary, not a first-release product requirement. The catalog never gains a reaction column, a molecule column, a yield column, or any other domain field.

8. **Integration is by stable reference.** Downstream consumers integrate through stable identifiers (`document_id`, `file_id`, `artifact_id`), content hashes, and evidence and provenance records. They do not import or query SciRetriever's internal ORM tables. The internal storage layer is free to change as long as those references and the `DocumentPackage` contract hold.

9. **Retained legacy code enters through adapters.** SciRetriever is the host project for the new framework, but existing code does not get to define the future. A legacy shape still needed for approved migration or retained behavior may enter only through a restricted adapter. CLI, state, codec, or task behavior removed or decoupled under ADR 0002 does not require an adapter. No legacy shape may dictate the v2 schema or module boundaries.

10. **Light structuring is loss-aware.** Generic summaries and tags exist to help people and machines find documents. They are lossy by nature, so they never replace the full normalized content. The full sections, tables, references, and evidence stay available in the `DocumentPackage`. SciRetriever's target analysis is based on the accepted primary PDF and primary-PDF evidence locators as required by ADR 0002; a downstream domain pack reads the full package and must not depend on a compressed summary alone.

11. **Modular monolith first.** The codebase evolves as a single, well-factored application. No microservices, no external workflow platform, no vector store, and no web UI until a concrete need forces the question through a new ADR.

12. **Data lives outside the repository.** Actual literature and domain data stay outside the code repository, under configured storage roots. The repository holds code and documentation, not corpora.

## Scope

### In scope

- Search across literature providers and normalization of search hits into work records.
- Download of full-text assets (PDF, XML, HTML) and recording each as an immutable file with a hash.
- Work identity and deduplication across providers and identifiers.
- Normalization of any supported raw format into a single `DocumentPackage` shape.
- Generic light structure: summaries, tags, and citation links that aid discovery.
- Catalog state: Work/WorkVersion processing state, acquisition diagnostics, artifact records, failures, and lineage.
- Optionally recording minimal domain-run bookkeeping: status, output pointers, and hashes produced by external domain packs. This is permitted, not required for the first release.
- Configuration of storage roots and provider credentials.

### Out of scope

- Any domain-specific extraction schema, including reactions, molecules, synthesis routes, and materials properties.
- Any domain database, table, or column inside the catalog.
- Ownership of generated JSONL or CSV domain datasets. Those are outputs of domain packs, not catalog entries.
- Chemistry knowledge, cheminformatics parsing, or reaction validation in core code.
- Downstream analytics, prediction, or planning built on domain data.
- Microservices, a workflow engine, a vector store, or a web UI (see decision 11).
- Storing corpora inside the repository (see decision 12).

## Canonical flow

```text
                     SciRetriever (ADR 0002 product)                     | Downstream domains
                                                                          |
 metadata providers -> Work -> WorkVersion -> primary PDF asset           |
                                      |      (accepted, or missing/blocked) |
                                      |                                   |
                                      +-> optional XML/HTML supplements   |
                                      |                                   |
                                      +-> PDF normalization/OCR           |
                                      +-> current generic analysis        |
                                      +-> canonical metadata/tags/refs    |
                                      |                                   |
                                      `-> DocumentPackage + stable refs --+-> domain pack
                                                                          |   -> portable dataset
 Catalog: Work/WorkVersion, assets, current result, references, failures, |   -> consumer store
          lineage, and optional minimal domain-run bookkeeping            |
 -------------------------------------------------------------------------+----------------------
                     DOMAIN BOUNDARY: no domain payload enters the catalog
```

The vertical line is the domain boundary. Everything left of it remains generic literature handling organized around Work/WorkVersion. Everything right of it reads a `DocumentPackage` through stable identifiers, hashes and provenance, then produces its own portable dataset. Optional domain-run bookkeeping may cross back only as status, output pointer and hash; it is not product navigation or domain data.

## Consequences

### What this buys us

- One domain can never corrupt another. Chemistry, biology, or materials packs all read the same neutral package and write their own datasets.
- The catalog schema stays small and stable. Adding a new research domain requires zero catalog migrations.
- Provenance is first class. Every downstream claim traces back to a file, a hash, and an evidence record.
- Internal storage can be refactored freely. Consumers depend on the `DocumentPackage` contract and stable ids, not on table shapes.
- Reprocessing is safe. Raw assets are immutable, so a normalization bug is fixed by re-running, not by hoping the original survived.

### What this costs us

- Indirection. A consumer that just wants "the reactions" has to run a domain pack rather than query a table. We accept that cost to keep domains decoupled.
- Duplication of some data across portable datasets. Two packs may each carry a document's title. We accept redundancy in exchange for independence.
- The `DocumentPackage` contract becomes load-bearing. Changing it ripples to every consumer, so it changes only through a new ADR (see below).
- Loss-aware structuring means we keep full normalized content, which costs more storage than summaries alone. Decision 10 makes that non-negotiable.

## Compatibility strategy

This ADR does not require preserving pre-v1 implementation shapes. [ADR 0002](0002-work-centered-literature-library.md) supersedes compatibility promises for unwanted task-centered and legacy-catalog behavior: its approved work may directly delete incompatible CLI, configuration, schema, adapters and control state while preserving the scope boundary and immutable evidence defined here.

The current pre-v1 product has no supported legacy catalog and therefore no migration adapter boundary. Old `Paper` ORM, `Optera` rows, retired-database guards and incompatible legacy shapes may be deleted directly. If a future supported input requires migration, its contract and safeguards require a new explicit owner decision. The chemistry `synthsis` script remains outside the SciRetriever core boundary.

No legacy shape is part of the approved pre-v1 product. ADR 0002 authorizes direct replacement within its Work-centered scope; this ADR continues to set the domain and `DocumentPackage` boundary every replacement implementation must satisfy. See the [architecture principles](../principles.md) for the responsibility matrix and minimum contract.

## When a new ADR is required

Open a new ADR (do not edit this one, supersede it) before doing any of the following:

- Changing the `DocumentPackage` contract in a way that is not backward compatible.
- Adding any domain-specific field, table, or schema to the catalog.
- Making a domain-generated JSONL or CSV dataset part of the catalog rather than an external output.
- Coupling a downstream consumer to internal ORM tables instead of stable identifiers.
- Introducing microservices, an external workflow platform, a vector store, or a web UI.
- Moving actual corpora into the code repository, or hardcoding a workspace path in place of a configured storage root.
- Letting legacy `Paper`/`Optera`/script shapes define the v2 schema instead of entering through adapters.

Editing this ADR in place is allowed only for clarifications that do not change a decision. Any change to a decision is a new, dated ADR that marks this one superseded.
