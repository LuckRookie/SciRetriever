# SciRetriever Architecture Principles

This is the working reference for how SciRetriever is built. It turns the domain-boundary decisions in [ADR 0001](decisions/0001-sciretriever-scope-and-boundary.md), the product reset in [ADR 0002](decisions/0002-work-centered-literature-library.md), and the external parser boundary in [ADR 0003](decisions/0003-operator-managed-mineru-service.md) into concrete responsibilities, a data contract, ownership rules, and a review checklist. Apply each ADR only to the topics listed in the [architecture decision index](decisions/README.md): ADR 0001 controls the domain boundary, ADR 0002 controls product shape and execution, and ADR 0003 controls the operator-managed MinerU connection. If this file disagrees with the applicable ADR, follow that ADR and fix this file.

The one sentence to remember: **SciRetriever acquires, catalogs, normalizes, and lightly structures literature, and it stops at a versioned, provenance-bearing `DocumentPackage`.** Domains live downstream.

The product center is a local literature library organized by `Work` and bibliographic `WorkVersion`; processing and export snapshots are separate identities. The ideal design is defined in the [system design](system-design.md), while current behavior is documented by the project [README](../../README.md).

## Layered view

```
  +----------------------------------------------------------------------+
  |  SciRetriever (this project, authoritative up to the boundary)       |
  |                                                                      |
  |  Acquisition      search providers, download providers               |
  |  Preservation     immutable raw assets on the filesystem (path+hash) |
  |  Normalization    raw (PDF | XML | HTML) -> one DocumentPackage       |
  |  Light structure  summaries, tags, citation links (loss-aware)       |
  |  Catalog          Work/versions, files, artifacts, analysis, lineage |
  |                                                                      |
  +===================== BOUNDARY: DocumentPackage ======================+
  |                                                                      |
  |  Downstream consumers (NOT this project)                             |
  |  Domain pack      Prompt + output Schema + optional Validator        |
  |  Portable dataset JSONL (authoritative) + CSV (optional) + manifest  |
  |  Consumer store   the consumer loads the dataset into its own DB     |
  +----------------------------------------------------------------------+
```

Read across the boundary in one direction only. Consumers reach up for a `DocumentPackage` using stable identifiers. Nothing below the line reaches into SciRetriever's tables, and no domain field reaches down into the catalog.

## Responsibility matrix

| Concern | SciRetriever core | Domain pack (downstream) | Consumer store (downstream) |
| --- | --- | --- | --- |
| Search and download | Owns | No | No |
| Raw asset preservation (immutable, path + hash) | Owns | No | No |
| Work identity and deduplication | Owns | No | No |
| Normalization to `DocumentPackage` | Owns | No | No |
| Sections, tables, references, evidence | Owns (generic, in package) | Reads | No |
| Summaries and tags (light structure) | Owns | Reads | No |
| Citation links between works | Owns | Reads | No |
| Domain schema (reactions, molecules, routes, ...) | No | Owns | Reads |
| Prompt, output schema, validator | No | Owns | No |
| Portable dataset (JSONL/CSV/manifest) | No | Owns | Reads |
| Domain database, tables, columns | No | No | Owns |
| Domain-run bookkeeping (status + pointer + hash) | Owns | Reports | No |
| Storage-root configuration | Owns | Reads config | Reads config |

"Owns" means this layer is the single writer and source of truth. "Reads" means it consumes but never writes. If a cell tempts you to add a second "Owns" in a row, stop and open a new ADR.

## The `DocumentPackage` minimum contract

The `DocumentPackage` is the boundary object. Its shape is identical whether the source was PDF, XML, or HTML. This section lists the minimum every package must carry. Implementations may add fields, but they may not drop any of these, and they may not add domain fields.

| Field group | Required content | Notes |
| --- | --- | --- |
| `schema_version` | Version string for the package contract | Bump only through a new ADR when the change is not backward compatible. |
| `document_id` | Stable catalog work identifier | Never reused, never recycled. The primary handle for consumers. |
| `identifiers` | External ids: DOI, arXiv id, and similar | May be empty, but the field is always present. |
| `source_provenance` | Provider, acquisition method, timestamps, agent | Answers "where did this come from and how". |
| `files[]` | For each raw asset: `file_id`, original format, storage path, content hash, size | Points at immutable evidence. Not the bytes themselves. |
| `normalized_content` | Full sections, tables, and references extracted generically | The complete, loss-aware body. Not a summary. |
| `evidence[]` | Locators tying normalized spans back to a `file_id` and position | Lets any downstream claim be traced to a source region. |
| `light_structure` | Generic summary, tags, and citation links | Discovery aids. Explicitly lossy. Never the only copy of content. |
| `artifacts[]` | For each derived artifact: `artifact_id`, kind, hash, storage pointer | Records what normalization produced. |
| `lineage` | What produced this package and from which inputs | Reproducibility and audit. |

Two rules make the contract safe:

- **Format independence.** A consumer must be able to process a package without knowing whether it started as PDF, XML, or HTML. Any code branching on original format below the boundary is a smell.
- **Loss awareness.** `light_structure` is a convenience. `normalized_content` and `evidence` are the truth. A domain pack that reads only the summary is violating [ADR 0001 decision 10](decisions/0001-sciretriever-scope-and-boundary.md#decision).

## Data ownership rules

1. **Raw assets are immutable evidence.** Write once to a configured storage root, record the hash, never edit in place. To fix a normalization error, re-run against the same raw asset. Do not patch outputs by hand.
2. **No large BLOBs in the relational store.** Documents and images are referenced by path and hash. The catalog stores metadata and pointers, not file bytes.
3. **The catalog owns a fixed list.** Work/WorkVersion identity, identifiers, files, asset availability, normalized artifacts, current generic analysis, tags, citations, diagnostic acquisition records, failures, and lineage. The deleted task/job/attempt/event lifecycle, lease, fencing, durable pause/resume, candidate checkpoints and retry-child control state do not enter the WorkVersion product model. Nothing else.
4. **No domain fields in the catalog, ever.** No reaction, molecule, route, yield, or other domain column. The catalog may hold a domain-run row with a status, an output pointer, and a hash. That row carries no domain payload.
5. **Domain output is external and portable.** JSONL is authoritative, CSV is an optional flattened export, and both ship with a schema, a manifest, and a validation report. These files are not catalog records. A consumer may load them into its own database; that database is not part of SciRetriever.
6. **Integration is by reference.** Consumers depend on `document_id`, `file_id`, `artifact_id`, hashes, and provenance. They never query internal ORM tables. Internal storage may be refactored as long as those references and the package contract hold.
7. **Data lives outside the repository.** Corpora and datasets sit under configured storage roots, never inside the code tree. Paths come from configuration, never from hardcoded strings.
8. **Provenance survives every step.** Acquisition, normalization, and light structuring each add to lineage. No step erases where a thing came from.
9. **External parser capability is not product ownership.** SciRetriever may submit an accepted primary PDF to the explicitly configured operator-managed MinerU service, but it never owns that service, GPU, model, queue or task lifecycle. MinerU output is untrusted derived input until local schema, resource, page/bbox and evidence validation succeeds.

## Review checklist

Run this checklist on any change before merging. A single "no" answer blocks the change until it is fixed or a new ADR authorizes it.

- [ ] Does this change stay on SciRetriever's side of the boundary (acquire, preserve, normalize, catalog, light structure)?
- [ ] Is the `DocumentPackage` contract unchanged, or changed only through a new ADR with a `schema_version` bump?
- [ ] Are all package fields format independent, with no branching on PDF vs XML vs HTML below the boundary?
- [ ] Does normalized content stay complete, so domain packs never have to rely on summaries alone?
- [ ] Are raw assets treated as immutable, referenced by path and hash, with no in-place edits?
- [ ] Are large documents and images kept out of the relational store as BLOBs?
- [ ] Is the catalog free of any domain field (no reaction, molecule, route, or yield columns)?
- [ ] Do any new domain outputs land as external JSONL/CSV plus schema, manifest, and validation report, and not as catalog rows?
- [ ] Does downstream integration use stable ids, hashes, and provenance rather than internal ORM tables?
- [ ] If a future owner-approved migration accepts legacy input, does it enter through an adapter rather than shaping the target schema?
- [ ] Are all data paths read from configuration, with no hardcoded workspace paths and no corpora committed to the repo?
- [ ] Is provenance preserved and extended, never dropped?
- [ ] Does the change avoid SciRetriever-owned microservices, workflow platforms, vector stores, and web UI, while keeping any ADR-approved external parser behind a strict capability adapter?

See the [local AGENTS.md](../../AGENTS.md) for the directive form of these rules that applies to coding agents, and the [project README](../../README.md) for current operational commands.
