# SciRetriever

SciRetriever acquires scientific literature, catalogs it, normalizes it into a
consistent shape, and adds generic light structure such as summaries, tags, and
citation links. Its authoritative processing ends at a versioned,
provenance-bearing `DocumentPackage`, the same shape whether the source was PDF,
XML, or HTML. Domain-specific extraction (reactions, molecules, synthesis
routes, and the like) is deliberately out of scope. That work belongs to
independent downstream consumers that read the `DocumentPackage` and produce
their own portable datasets, never to SciRetriever's core.

This scope is settled. Read it before changing anything:

- [ADR 0001: SciRetriever scope and boundary](docs/adr/0001-sciretriever-scope-and-boundary.md) is the authoritative decision.
- [Architecture principles](docs/architecture/principles.md) hold the responsibility matrix, the `DocumentPackage` minimum contract, the data ownership rules, and the review checklist.
- [AGENTS.md](AGENTS.md) states the enforceable rules for coding agents working in this project.

## v2 specifications

The v2 design lives in three concise specs under [`docs/specs/`](docs/specs/).
P0-P9 now provide the contracts, catalog and identity foundation, bounded
discovery MVP, immutable `RawAsset` storage with crash reconciliation, and the
single- and multi-source acquisition layer for PDF, supplementary PDF, XML, and
HTML assets, deterministic normalization and generic enrichment, and immutable
`DocumentPackageVersion` publication, bounded existing-asset import, and neutral
legacy Paper adapters. No replacement operational literature database exists.

- [Requirements](docs/specs/requirements.md): why v2 exists, who it serves, what it must and must not do.
- [System design](docs/specs/system-design.md): the end-to-end runtime data flow, from a download request to a published `DocumentPackageVersion`.
- [Technical architecture](docs/specs/technical-architecture.md): module map, technology route, and phased milestones.

They build on [ADR 0001](docs/adr/0001-sciretriever-scope-and-boundary.md) and the
[architecture principles](docs/architecture/principles.md), which stay authoritative.

## Current state

P0-P9 of the v2 framework are implemented: neutral intake contracts, the catalog
and identity foundation, the discovery pipeline and `sciretriever discover` CLI,
the immutable `RawAsset` store, acceptance coordinator and reconciler, and the
single- and multi-source acquisition orchestrators and CLI. Deterministic PDF,
XML, and HTML normalization, generic summaries/tags/citation links, quality
gates, immutable derived storage, and offline package publication are built.
The bounded Paper/Optera compatibility adapter is built. Everything documented below as legacy and
standalone behavior remains kept as-is. The old search and
download providers, SQLAlchemy `Paper` model with its `Optera` CRUD layer, and
standalone LLM scripts all predate the boundary; they do not satisfy the v2
architecture and must eventually enter it through adapters.

## P2 discovery CLI

`sciretriever discover` executes one bounded metadata workflow:

```text
retrieve -> clean / deduplicate / merge -> compare with read-only catalog ->
label title + abstract -> atomically publish JSONL DownloadManifest
```

Built-in metadata providers are Crossref, Europe PMC, arXiv, OpenAlex, Semantic
Scholar, Elsevier Scopus Search, and Springer Nature Metadata. The backward-
compatible default remains Crossref, Europe PMC, and arXiv; repeat `--source`
to select any subset. Semantic Scholar accepts its optional configured API key.
Elsevier and Springer require their configured keys when explicitly selected.
Labeling is local
and deterministic: repeat `--label-rule LABEL=TERM` to add literal keyword terms
to a label. A missing abstract does not discard a candidate; the manifest marks
`missing_abstract=true`, and rules can still match the title. Catalog access is
strictly read-only and may reuse an exact existing label match. Discovery never
creates or updates a `Work` and never downloads full text.

```bash
sciretriever discover "solid-state electrolytes" \
  --source crossref \
  --source europe-pmc \
  --filter year_from=2020 \
  --catalog /path/to/existing-catalog.sqlite \
  --output /path/to/manifests/electrolytes.jsonl \
  --taxonomy literature-topic \
  --taxonomy-version 1 \
  --label-rule battery=electrolyte \
  --label-rule battery=lithium \
  --crossref-mailto researcher@example.org
```

`--catalog` must name an existing migrated catalog, and the output parent must
already exist. `--limit` defaults to 100, `--timeout` to 30 seconds, and the
optional `--intake-run-id` and `--retrieved-at` accept a canonical UUID and UTC
RFC3339 timestamp for reproducible manifests. Otherwise they are generated at
run time. A successful run returns `0`; argument errors return `2`; search,
catalog, and filesystem failures return `1` without a traceback or partial
manifest.

## P9 catalog and one-time import CLI

The lowercase `sciretriever` package is the primary v2 path. The uppercase
`SciRetriever` namespace remains available only for compatibility and retained
safety guards; legacy ORM and Optera write APIs are never used for v2 control
flow. Create a new catalog and import explicitly supplied existing evidence with:

```bash
sciretriever catalog create --catalog /path/to/new-catalog.sqlite

sciretriever catalog import-asset \
  --catalog /path/to/catalog.sqlite \
  --storage-root /path/to/existing-storage \
  --asset /path/to/article.xml --asset-role xml \
  --identifier doi=10.1000/example

sciretriever catalog import-legacy-db \
  --catalog /path/to/catalog.sqlite \
  --storage-root /path/to/existing-storage \
  --legacy-db /path/to/existing-legacy.sqlite \
  --asset-root /path/to/existing-assets \
  --legacy-source-id archive-2026
```

`create` is new-file-only and applies all migrations. Import commands require an
existing fully migrated catalog and real existing storage root. Legacy SQLite is
opened read-only, streamed in row-id order, and treated solely as one-time input.
There is no automatic corpus or database migration. Relative legacy `pdf_path`
values resolve only below `--asset-root`; symlinks, escapes, malformed content,
and oversized assets are refused. Exact replay reuses the authoritative accepted
Work-role asset and never replaces conflicting bytes. Exit codes are `0` for
complete success, `1` for operational or partial failure, and argparse `2` for
invalid arguments.

## P4-P5 acquisition CLI

`sciretriever acquire` consumes a discovery manifest or one direct DOI/HTTPS
URL, creates or reuses the canonical Work, and admits an idempotent role-specific
job. P4 single-provider operation remains available as a one-entry serial-plan
adapter over the P5 lifecycle owner. P5 accepts repeatable
`--providers` or a canonical `--source-plan` file, supports deterministic
`serial` fallback or same-tier `race`, and durably resumes one job or all due
retryable jobs. Asset roles are `primary_pdf`, `supplementary_pdf`, `xml`, and
`html` and remain independent per Work.

Built-ins are `direct`, `arxiv`, `crossref`, `unpaywall`, `europe-pmc`,
`openalex`, `semantic-scholar`, `elsevier`, `wiley`, and `springer`. Credentials
come from the fixed environment variables or the strict lowercase v2 TOML
configuration described below. They are never CLI values or source-plan data.

### v2 `config.toml`

Every lowercase v2 command accepts `--config PATH` or `--config=PATH` before or
after its subcommands. Selection order is explicit `--config`, then
`SCIRETRIEVER_CONFIG`, then an existing `./config.toml`. `--no-config` disables
environment and implicit loading. Missing explicit or environment-selected files
are errors; a missing implicit file preserves the previous CLI behavior.
`--version` does not load an implicit config.

Explicit CLI options override TOML. For credentials only, a nonblank fixed
environment variable overrides TOML. Built-in defaults are last. Repeatable CLI
options replace configured collections instead of extending them. Config-relative
`paths.catalog`, `paths.storage_root`, `acquisition.source_plan`, and
`acquisition.forbidden_urls` resolve from the config file's parent after `~`
expansion. CLI paths retain current-working-directory semantics. Environment
variables inside TOML path strings are not expanded.

The root requires `schema_version = 1` and accepts only `[paths]`,
`[credentials]`, `[discovery]`, `[acquisition]`, and `[package]`. Unknown fields,
wrong types, unsupported choices, duplicate collection values, malformed TOML,
files larger than 1 MiB, symlinks, and nonregular files are rejected with exit
code `2` before operational work starts. See [`config.example.toml`](config.example.toml)
for every supported setting. The schema is:

The loader also rejects replacement of the canonical config directory during
its bounded read. After loading, the config file and its directory are trusted
operational inputs; a same-user process that mutates them concurrently is
outside the CLI threat model.

- `[paths]`: `catalog`, `storage_root`.
- `[credentials]`: `unpaywall_email`, `semantic_scholar_api_key`,
  `elsevier_api_key`, `wiley_api_key`, `springer_api_key`.
- `[discovery]`: `sources`, `limit`, `timeout`, `taxonomy`,
  `taxonomy_version`, `crossref_mailto`, `[discovery.filters]` with
  `year_from`/`year_to`, and `[discovery.label_rules]` string lists.
- `[acquisition]`: either `providers` or `source_plan`, plus `routing`,
  `asset_role`, `timeout`, `host_concurrency`, `host_min_interval`, and
  `forbidden_urls`.
- `[package]`: the seven documented normalization/summary positive integer
  bounds and boolean `enrichment`.

For example:

```bash
cp config.example.toml config.toml
chmod 600 config.toml
mkdir -p storage
sciretriever --config config.toml catalog create
sciretriever discover "solid-state electrolytes" \
  --config config.toml --output /path/to/manifests/electrolytes.jsonl
sciretriever acquire --config config.toml --doi 10.1000/example
sciretriever package --config config.toml --work-id UUID
```

On POSIX, any config containing at least one credential must have no group or
other permission bits; `chmod 600 config.toml` is the normal setting. Credential
values are redacted from config representations and errors and never enter CLI
arguments, source plans, catalog provenance, attempt details, package lineage,
logs, or success output. The fixed environment variables are:

| Provider | Environment variable | Requirement |
| --- | --- | --- |
| Unpaywall | `SCIRETRIEVER_UNPAYWALL_EMAIL` | Required when Unpaywall is selected |
| Semantic Scholar | `SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY` | Optional; sent as `x-api-key` when present |
| Elsevier | `SCIRETRIEVER_ELSEVIER_API_KEY` | Required; primary/supplementary PDF and XML |
| Wiley | `SCIRETRIEVER_WILEY_API_KEY` | Required; primary PDF only |
| Springer | `SCIRETRIEVER_SPRINGER_API_KEY` | Required; XML and HTML only |

Environment-only operation remains supported:

```bash
export SCIRETRIEVER_UNPAYWALL_EMAIL='researcher@example.org'
export SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY='...'
export SCIRETRIEVER_ELSEVIER_API_KEY='...'
export SCIRETRIEVER_WILEY_API_KEY='...'
export SCIRETRIEVER_SPRINGER_API_KEY='...'
```

Discovery consumes the fixed Semantic Scholar, Elsevier, and Springer key
variables only when those sources are selected. Crossref, Europe PMC, arXiv,
and OpenAlex work without keys. Keys are sent in headers except for Springer's
required request query parameter, which is removed from retained URLs.
Invocation operands remain
CLI-only: discovery query/output; acquisition manifest, DOI, URL, and resume
selectors; catalog asset and import-specific arguments; package Work/RawAsset
selector; and discovery intake-run/retrieval timestamps. TOML may satisfy the
shared catalog/storage paths but does not bypass existing-file, migration,
retired-database, staged-write, or storage-symlink guards.

`SCIRETRIEVER_STORAGE_ROOT` remains a Python-library fallback for `RawAssetStore`,
not a lowercase CLI fallback. `SCIRETRIEVER_WORKSPACE_ROOT` remains a workspace
compatibility control and is not v2 CLI config selection. `SourceEntry.locator`
and `SourceEntry.config_refs` remain reserved credential-free durable-plan
metadata. Lowercase `config.toml` is not loaded by the retained uppercase legacy
namespace or standalone LLM scripts.

`sciretriever package` has no v2 LLM API configuration. It uses deterministic
fallback enrichment unless a caller injects a `Summarizer` through the Python API;
`SCIRETRIEVER_LLM_API_KEY`, `--model`, and `--base-url` belong only to the retained
uppercase standalone LLM scripts described below.

```bash
sciretriever acquire --manifest /path/to/manifest.jsonl \
  --catalog /path/to/existing-catalog.sqlite \
  --storage-root /path/to/existing-storage \
  --provider crossref --timeout 30

sciretriever acquire --doi 10.1000/example \
  --catalog /path/to/existing-catalog.sqlite \
  --storage-root /path/to/existing-storage \
  --providers openalex --providers semantic-scholar \
  --routing race --host-concurrency 2 --host-min-interval 0.25

sciretriever acquire --due-jobs \
  --catalog /path/to/existing-catalog.sqlite \
  --storage-root /path/to/existing-storage
```

The catalog and storage root must already exist. Acquisition permits HTTPS only,
checks direct and redirected resolved addresses, validates bounded PDF bytes,
XML, or HTML according to the requested role, and accepts content exclusively
through `AssetAcceptanceCoordinator`. An existing asset for the requested role
is reused without network access. Source plans, attempts, retry times, skip
events, and terminal states are durable. Candidate attempt details use a strict
versioned JSON contract; the catalog remains acquisition-neutral and stores only
canonical JSON plus generic role/version metadata. Providers, host budgets,
health EMA, circuit state, and retry policy are shared process-local state for
one CLI invocation. Publisher profile budget hints apply unless explicitly
overridden by `--host-concurrency` or `--host-min-interval`. Exit codes are `0` for complete
success, `1` for runtime or partial failure, and `2` for argument errors.

## P3 immutable RawAsset storage

P3 remains a network-independent library API and is called by the converged
P4-P5 lifecycle only after role-specific content validation succeeds.
`RawAssetStore` requires a configured
storage root that already exists as a real directory, with no symlink in the
root path. It creates only this managed relative layout:

```text
staging/<intent-id>.part
staging/.lock
raw/<sha256[:2]>/<sha256>
```

Managed directories and hash shards are mode `0700`, the lock is `0600`, and
staged and published files are read-only mode `0400`. Staging reads the input
stream once while computing SHA-256 and a strictly positive size, then strictly
fsyncs the bytes, read-only file, and staging directory. An `AssetIntent` is
committed with immutable Work, job, optional attempt, role, relative paths,
expected hash and size, media type, format, and provenance before publication.
Its only transitions are `pending -> published -> finalized` or
`pending -> abandoned`.

Raw publication uses same-filesystem `os.link` to create the content address
only if absent. It never renames, replaces, copies, or overwrites a target. A
new target and every pre-existing target are size-checked and rehashed, then the
target file and containing directories are fsynced. Only after that durable
verification does one catalog transaction create or reuse the single
`RawAsset` row for the SHA, add the per-Work role link, retain the intent's own
provenance, and move the intent to `published`; staging removal precedes
`finalized`. Catalog paths stay relative, file bytes never enter a BLOB, and
absolute filesystem paths are not stored.

Normal acceptance holds a shared storage lock; reconciliation holds the
exclusive lock. Recovery uses only immutable intent metadata and deterministic
paths. Valid staged evidence can recreate a missing target, and a valid target
can complete catalog registration without staging. Missing evidence may abandon
a pending intent or retain a published/finalized integrity failure. Corrupt
targets, corrupt staged entries, catalog metadata conflicts, and unknown staging
entries are retained and reported, never auto-deleted or overwritten. The sole
orphan cleanup is a recognized regular `staging/<uuid>.part` with no intent,
removed durably under the exclusive lock. Abandoned intents are terminal and do
not publish or delete files. Exact intent, event, and failure replays are
idempotent.

Verification covers all six durable crash checkpoints, restart plus two-pass
reconciliation, concurrent identical bytes converging to one target and one raw
row while preserving per-intent provenance and per-Work links, and clean SQLite
`integrity_check` and `foreign_key_check` results.

## P6-P8 normalization and package CLI

`sciretriever package` is an offline pipeline over already accepted RawAssets:

```text
raw acceptance -> normalization -> optional generic enrichment ->
package validation -> immutable DocumentPackageVersion publication
```

It accepts exactly one Work or RawAsset selector and processes every supported
asset linked to the resolved Work. PDF pages and XML/HTML structural text units
produce one format-independent `NormalizedContent`, a complete source map, and
evidence spans. Summary input is whitespace-cleaned and exactly deduplicated
before any optional injected summarizer; the CLI uses the deterministic fallback
only. Missing enrichment does not block complete normalized content.

```bash
sciretriever package \
  --catalog /path/to/existing-catalog.sqlite \
  --storage-root /path/to/existing-storage \
  --work-id 00000000-0000-4000-8000-000000000001

sciretriever package \
  --catalog /path/to/existing-catalog.sqlite \
  --storage-root /path/to/existing-storage \
  --raw-asset-id 00000000-0000-4000-8000-000000000002 \
  --no-enrichment
```

The catalog and storage root must already exist. Parser bounds are configurable
with `--max-input-bytes`, `--max-pages`, `--max-structural-units`, and
`--max-depth`, `--max-elements`, and `--max-text-characters`. Successful output
reports `disposition=created` for a newly published version or
`disposition=replayed` for exact replay. Exact replay reuses the same artifacts
and package version. A material package change creates only the next version. A
Work with a primary PDF publishes `pdf_backed`; XML/HTML without a primary PDF
publishes `limited_xml_html` with `missing_primary_pdf`.

Derived bytes use owner-addressed immutable paths:

```text
derived_staging/<kind>.<owner-id>.<sha256>.<attempt-id>.part
derived/<kind>/<owner-id-prefix>/<owner-id>
derived_locks/<run-id>
```

Publication uses the same restrictive permissions, fsync ordering, hard-link
create-if-absent, collision verification, and evidence-retention rules as Raw
storage. Filesystem publication and verification always precede catalog
registration. No catalog migration or `core/package.py` contract change was
required. Persistent mode-`0600` run locks serialize identical normalization,
enrichment, and package-publication work across processes; contenders reload
durable run state after taking the lock so interrupted ACTIVE runs can resume.

## Repository path and workspace

`literature/retrieval/SciRetriever/` is the canonical repository after Batch 010. The complete original is retained indefinitely at `archive/migration-backups/phase2/batch-010/SciRetriever/`, and active consumers use canonical paths. The canonical `.venv/` was intentionally excluded and must be rebuilt from `pyproject.toml` and `uv.lock`; the archived environment is rollback-only and must not be copied or reused.

The workspace root is identified by a regular, non-symlink `.workspace-root`
file containing exactly `duanjw-research-workspace:v1` plus a newline.
`SCIRETRIEVER_WORKSPACE_ROOT` may override parent traversal only when the chosen
directory contains that valid marker. Explicit CLI paths take precedence.

## Database utilities (legacy, pending v2 adaptation)

The nine legacy repository databases were retired by Batch 015 to
`archive/migration-backups/phase2/batch-015/literature/retrieval/SciRetriever/`.
They remain user-controlled with indefinite retention and no automatic
expiration or deletion. No replacement database is present, and a future
PDF/XML rebuild is `NOT_STARTED` and outside Batch 015 scope. Database access
defaults to existing-file mode and explicit creation at a retired active path
is always refused.

```bash
python work/combin.py \
  --input-db /path/to/user-supplied/input-a.db \
  --input-db /path/to/user-supplied/input-b.db \
  --output-db /tmp/sciretriever-scratch/future-merged.db

python work/filter_database.py --database /tmp/sciretriever-scratch/future-merged.db
```

These commands are illustrative: the input paths must be future, user-supplied
existing databases, and no replacement database is currently present. Database
utilities require explicit paths and retain SciRetriever-owned staged-write and
retired-path safeguards. Prefer a scratch output outside the repository, as
shown above. Without required options, utilities exit before creating a
database. Merge inputs must exist, be files, be unique after resolution, and
must not alias the output; filtering also requires an existing file.

## Standalone LLM scripts (legacy, pending v2 adaptation)

These scripts summarize and extract from already-parsed documents. They run
standalone today and are not yet wired into the framework in ADR 0001.

```bash
python -m SciRetriever.LLM.script.synthsis INPUT.md [--output-dir DIR]
python -m SciRetriever.LLM.script.literature INPUT_FILE --file-type xml|html [--output FILE]
python -m SciRetriever.LLM.script.literature MINERU_RESULT_DIR --file-type pdf [--mineru] [--output FILE]
python -m SciRetriever.LLM.script.batch_literature [--input-dir DIR] [--output-dir DIR] [--file-type xml|html|pdf] [--mineru|--no-mineru]
```

All scripts also accept `--model` and `--base-url`. Set `SCIRETRIEVER_LLM_API_KEY` in the environment when the configured endpoint requires a credential; keys are not accepted on the command line. XML and HTML inputs must be files. For `--file-type pdf`, each input is a MinerU result directory containing `auto/<directory-name>.md`; `--mineru` additionally requires `auto/<directory-name>_middle.json`. The generated `SciRetriever.LLM.script.input_validation` helper contains only `pathlib` validation logic and is shared by both literature CLIs. The batch module imports that helper directly and never imports the single-file execution CLI during preflight. Both commands validate complete input layouts before importing OpenAI, `SciRetriever.LLM.utils`, or tqdm, constructing a client, creating output paths, or invoking a workflow; one malformed batch child aborts the entire preflight without output mutation. Default outputs resolve below `<workspace>/literature/outputs/`. Batch input defaults to the canonical parsed asset at `<workspace>/literature/parsed/pdf2md`.

Note on the synthesis script: `synthsis` extracts chemistry-specific fields and
is therefore domain work, not core SciRetriever behavior. Under ADR 0001 it is
the first candidate to move out of core into a downstream domain pack. It is
documented here only because it currently ships in this repository.

## Provider and download scripts (legacy, pending v2 adaptation)

These legacy-only provider scripts use `SEMANTIC_SCHOLAR_API_KEY`,
`WILEY_TDM_API_KEY`, `ELSEVIER_API_KEY`, or `SCIHUB_API_KEY` as applicable. These
names are not consumed by the lowercase v2 CLI. The preserved original repository
still contains historical credential literals; those credentials require
user-side revocation and rotation. No source credential was changed during
cutover.
The database-backed download examples require `SCIRETRIEVER_DOWNLOAD_DB` to name an existing, explicitly supplied database. They currently use code-defined relative output directories (`./Elsever`, `./scihub`, and `./wiley`); they do not implement shared `SCIRETRIEVER_DOWNLOAD_DIR` or `SCIRETRIEVER_ALLOW_STAGED_WRITE` controls.
