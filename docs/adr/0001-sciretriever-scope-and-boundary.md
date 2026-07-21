# ADR 0001: SciRetriever Scope and Boundary

- Status: Accepted
- Date: 2026-07-20
- Supersedes: none
- Superseded by: none
- Related: [architecture principles](../architecture/principles.md), [project README](../../README.md), [local AGENTS.md](../../AGENTS.md)

This ADR is the authoritative source of truth for what SciRetriever is and where it stops. Read it before writing code, reviewing a change, or proposing a new module. When this document and any other document disagree, this document wins.

## Context

SciRetriever grew as a toolkit for one lab's energetic-materials literature work, and its current code mixes two concerns that need to be separated.

The generic concern is literature handling: search providers (Semantic Scholar, Crossref, Google Scholar, plus an OpenAlex stub), download providers (Sci-Hub, Elsevier/ScienceDirect XML, Wiley, a generic web fetcher, and a CJEM journal scraper), a weak SQLAlchemy `Paper` ORM with a 22-column table and a self-referential citation join, an `Optera` CRUD wrapper, and standalone LLM scripts that summarize parsed documents.

The domain-specific concern is chemistry extraction. It lives today inside one standalone script whose prompt hardcodes reactant, reagent, solvent, conditions, product, and yield fields. That chemistry logic is currently entangled with generic literature handling, and the `Paper` model already carries opinions (a flat metadata table, no provenance, no versioning) that would quietly become the schema for everything downstream if we let it.

The repository state makes this the right moment to freeze the design. Nine legacy databases were retired in Batch 015 with no replacement, so there is no production schema to protect. There is no `docs/` directory and no recorded architecture. A future PDF/XML rebuild is not started. If we begin implementation without a written boundary, the old `Paper` table and the one chemistry script will set the defaults by accident.

This ADR settles the boundary before that happens. It does not implement anything. It records decisions the project owner finalized after an extended architecture discussion.

## Decision

SciRetriever is a scientific-literature acquisition, cataloging, normalization, and light-structuring system. It is not a chemistry system, and it is not a domain database.

1. **Purpose.** SciRetriever acquires scientific literature, catalogs it, normalizes it into a consistent shape, and adds generic light structure. Nothing about a specific research domain belongs in its core.

2. **Processing boundary.** SciRetriever's authoritative processing ends at a versioned, provenance-bearing `DocumentPackage`. The package shape is the same whether the raw input was PDF, XML, or HTML. Producing that package is the last step SciRetriever owns.

3. **Raw assets are evidence.** Downloaded files stay on an external filesystem as immutable evidence. SciRetriever never rewrites a raw asset in place. Large documents and images are referenced by path and hash. They are not stored as relational BLOBs.

4. **What the catalog owns.** The literature catalog manages work identity, external identifiers (DOI, arXiv id, and similar), file records, acquisition history, normalized artifacts, generic summaries, tags, citation links, workflow state, failure records, and lineage. That is the full list.

5. **Domain extraction is out of scope.** Pulling reactions, molecules, routes, materials properties, or any other domain payload out of a document is not SciRetriever's job. Independent downstream consumers ("domain packs") do that work using a Prompt, an output Schema, and an optional Validator.

6. **Domain output is a portable dataset, not a database.** A domain pack produces a versioned, portable dataset: JSONL as the authoritative form, an optional flattened CSV export, plus a schema, a manifest, and a validation report. A domain pack does not create or own a domain database. A consumer may later load the dataset into its own database. That loading is the consumer's concern, not SciRetriever's.

7. **The catalog tracks runs, not domain fields.** The catalog may record that a domain run happened: its status, a pointer to its output, and content hashes. The catalog never gains a reaction column, a molecule column, a yield column, or any other domain field.

8. **Integration is by stable reference.** Downstream consumers integrate through stable identifiers (`document_id`, `file_id`, `artifact_id`), content hashes, and evidence and provenance records. They do not import or query SciRetriever's internal ORM tables. The internal storage layer is free to change as long as those references and the `DocumentPackage` contract hold.

9. **Legacy code enters through adapters.** SciRetriever is the host project for the new framework, but the existing code is weak and does not get to define the future. The old `Paper` ORM, the `Optera` CRUD layer, and the standalone scripts must enter the new design through adapters. They must not dictate the v2 schema or the module boundaries.

10. **Light structuring is loss-aware.** Generic summaries and tags exist to help people and machines find documents. They are lossy by nature, so they never replace the full normalized content. The full sections, tables, references, and evidence stay available in the `DocumentPackage`. Domain extraction reads that full content and must not depend on a compressed summary alone.

11. **Modular monolith first.** The codebase evolves as a single, well-factored application. No microservices, no external workflow platform, no vector store, and no web UI until a concrete need forces the question through a new ADR.

12. **Data lives outside the repository.** Actual literature and domain data stay outside the code repository, under configured storage roots. The repository holds code and documentation, not corpora.

## Scope

### In scope

- Search across literature providers and normalization of search hits into work records.
- Download of full-text assets (PDF, XML, HTML) and recording each as an immutable file with a hash.
- Work identity and deduplication across providers and identifiers.
- Normalization of any supported raw format into a single `DocumentPackage` shape.
- Generic light structure: summaries, tags, and citation links that aid discovery.
- Catalog state: acquisition history, artifact records, workflow status, failures, and lineage.
- Recording domain-run bookkeeping: status, output pointers, and hashes produced by external domain packs.
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

```
                 SciRetriever (authoritative)                     |   Downstream consumers (out of scope)
                                                                   |
  Acquire            Preserve           Normalize      Light       |   Domain pack            Portable dataset      Consumer
  search +           immutable raw      raw -> one      structure   |   Prompt + Schema        JSONL (authoritative) load into
  download    --->   asset on the  ---> DocumentPackage --> +       |   + optional Validator   + CSV (optional)      the consumer's
  providers          filesystem         (versioned,     summaries   |   reads DocumentPackage  + schema/manifest/    own database
                     (path + hash)      provenance)     tags        |   by stable id + hash    validation report     (their concern)
                                                        citations   |
                                                                    |
                     Catalog: identity, ids, files, artifacts, workflow state, failures, lineage,
                              and domain-run bookkeeping (status + output pointer + hash only)
  ------------------------------------------------------------------|--------------------------------------------------
                          BOUNDARY: SciRetriever stops at the DocumentPackage
```

The boundary is the vertical line. Everything left of it is SciRetriever. Everything right of it reads the `DocumentPackage` through stable identifiers and provenance, and produces its own portable dataset. The catalog may note that a run happened and where its output lives, and that is the only thread that crosses back.

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

The existing code keeps working as legacy and standalone behavior. Nothing in this ADR deletes or rewrites current scripts, providers, or the retired-database safeguards.

New work follows an adapter pattern. When the v2 framework is built, the old `Paper` ORM and `Optera` CRUD are wrapped by adapters that translate between legacy rows and the new model. The legacy shapes never become the v2 schema. The chemistry `synthsis` script is treated as the first candidate domain pack, extracted out of core rather than blessed inside it.

Until an adapter exists for a given piece, that piece stays exactly as it is today. This ADR does not authorize a rewrite. It sets the target the rewrite must aim at. See the [architecture principles](../architecture/principles.md) for the responsibility matrix and the `DocumentPackage` minimum contract that adapters must satisfy.

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
