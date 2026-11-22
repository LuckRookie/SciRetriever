import type { SqliteCommand } from "./worker.js";

export const SHORT_READ_LIMIT_MS = 5_000;
export const SLOW_SHORT_READ = "sqlite-short-read-slow";

/** One catalog worker per lane. Long reads have operation-specific page bounds. */
export const SQLITE_READ_LANES = {
  short: {
    limit_ms: SHORT_READ_LIMIT_MS,
    requests: [
      "schema",
      "query_preflight",
      "get_literature",
      "get_literature_ids",
      "literature_detail_snapshot",
      "literature_bibliographies",
      "list_literature",
      "find_literature_by_identifiers",
      "identity_read",
      "metadata_fields_read",
      "article_identity_get",
      "article_identity_current",
      "get_asset",
      "asset_by_hash",
      "locate_artifact",
      "document_parts",
      "document_material",
      "document_version",
      "document_default",
      "get_observation",
      "get_provider_relation",
      "reference_query_snapshot.id",
      "library_search_page.page",
      "library_search_page.state-filter",
      "library_state_pending",
      "library_counts.global",
      "library_snapshot.ids",
      "intake_withdrawn",
      "intake_withdrawal_read.read",
      "intake_read.status",
      "capture_read",
      "device_connections.list",
      "device_connections.check",
      "import_read.owner",
      "import_read.workflow",
      "import_read.file",
      "import_read.folder",
      "import_read.result",
      "import_read.results",
      "import_read.files",
      "import_read.mapping",
      "import_read.intake-member",
      "import_read.batch",
      "import_read.items-read.one",
      "import_read.items-read.hash",
      "import_read.items-read.needs",
      "import_read.items-read.source-url",
      "import_read.items-read.resolution-file",
      "import_read.items-read.raw-owners",
      "folders.list",
      "filters.list",
      "marks.list",
      "marks.place.check",
      "archive.state",
      "archive.issues.literature",
      "archive.events",
      "archive.revision",
      "tags.get",
      "tags.list",
      "tags.resolve",
      "tags.assignment",
      "tags.changes",
      "snapshot.read",
      "snapshot.list",
      "snapshot.member",
      "annotation.get",
      "annotation.state",
      "annotation.find",
      "proofread.get",
      "proofread.document-source",
      "proofread.current",
      "proofread.state",
      "proofread.resources",
      "proofread.cache-read",
      "proofread.binding",
      "raw_parse.get",
      "raw_parse.current",
      "raw_parse.resources",
      "processor.get",
      "processor.list",
      "processor.projection",
      "processor.index-status",
      "processor.collection-get",
      "processor.collections",
      "processor.collection-members",
      "processor.pins",
      "processor.freshness",
      "review.job-origin-get",
      "review.session-revision",
      "review.task-run",
      "review.processor-runs",
      "review.literature-results",
      "extraction.operation",
      "extraction.receipt",
      "extraction.receipt-key",
      "retrieval.revision",
      "retrieval.active",
      "retrieval.state",
      "retrieval.search",
      "retrieval.documentCoverage.scope",
      "retrieval.metadataSource",
      "retrieval.hasDefault",
      "retrieval.literatureSources",
      "retrieval.changePage",
      "get_candidate",
      "get_receipt_intent",
      "get_receipt_result",
      "list_candidates",
      "current_facts",
      "read_automatic_pdf_exhaustion",
      "execution_get_job",
      "execution_list_jobs",
      "execution_list_targets",
      "execution_list_attempts",
      "execution_get_target",
      "execution_list_events",
      "execution_task_detail_events.incremental",
      "execution_get_policy",
      "execution_get_budget",
      "execution_list_interventions",
      "draft_text_read.facts",
      "draft_text_read.current",
      "draft_text_read.primary-defaults",
    ],
  },
  long: {
    limit_ms: null,
    requests: [
      "begin_read_snapshot",
      "snapshot_counts",
      "library_counts",
      "library_exact_count",
      "library_facets",
      "library_search_page.selection",
      "library_search_page.state-fallback",
      "library_search_page.discovery-scope",
      "library_snapshot.query",
      "acquire_pdf_selection",
      "parse_document_selection",
      "reference_snapshot",
      "reference_query_snapshot.literature",
      "get_discovery",
      "intake_read.list",
      "intake_withdrawal_read.preview",
      "import_read.active",
      "intake_withdrawal_read.restore-preview",
      "import_read.cleanup",
      "import_read.sessions",
      "import_read.report-snapshot",
      "import_read.aggregate",
      "import_read.parts",
      "import_read.items-read.all",
      "import_read.items-read.duplicate-candidates",
      "import_read.items-read.pending-resolution-files",
      "import_read.items-read.batch-candidates",
      "folders.delete-preview",
      "folders.export",
      "filters.export",
      "marks.export",
      "archive.stats",
      "archive.issues.library",
      "tags.state",
      "tags.undo-preview",
      "tags.backfill-candidates",
      "snapshot.capture",
      "processor.comparison",
      "processor.query",
      "processor.search",
      "processor.context-search",
      "processor.collection-search",
      "review.audit-list",
      "review.session-list",
      "review.session-read",
      "review.usage-history",
      "review.source-records-page",
      "review.estimate-issues",
      "retrieval.sourceCount",
      "retrieval.metadataPage",
      "retrieval.documentPage",
      "retrieval.documentCoverage.library",
      "retrieval.scanChanges",
      "retrieval.changesSnapshot",
      "retrieval.verificationEntries",
      "retrieval.verifyCatalog",
      "pending_receipts",
      "artifact_reclamation_snapshot",
      "candidate_cleanup_snapshot",
      "execution_runtime_inspect",
      "execution_restore_check",
      "execution_list_requested_jobs",
      "citation_checkpoints",
      "execution_task_detail_events.replay",
      "draft_text_read.backfill-candidates",
    ],
  },
} as const;

const requests = new Map<
  string,
  { lane: "short" | "long"; limit_ms: number | null }
>();
for (const lane of ["short", "long"] as const) {
  const { requests: names, limit_ms } = SQLITE_READ_LANES[lane];
  for (const name of names) requests.set(name, { lane, limit_ms });
}

export function sqliteReadRequest(command: SqliteCommand) {
  const name = readOperation(command);
  const policy = requests.get(name);
  return policy && { ...policy, name };
}

function readOperation(c: SqliteCommand): string {
  switch (c.kind) {
    case "library_counts":
      return c.counterRead === "defer" ? "library_counts.global" : c.kind;
    case "import_read":
      return c.action.op === "items-read"
        ? `${c.kind}.items-read.${c.action.query.kind}`
        : `${c.kind}.${c.action.op}`;
    case "intake_read":
      return `${c.kind}.${(c.value as { operation?: string } | null)?.operation === "get" ? "status" : "list"}`;
    case "draft_text_read":
      return `${c.kind}.${c.request.kind}`;
    case "device_connections":
      return `${c.kind}.${c.command.kind}`;
    case "intake_withdrawal_read":
      return `${c.kind}.${c.command.operation}`;
    case "folders":
    case "filters":
    case "marks": {
      const read = c.value as {
        operation?: string;
        check_only?: boolean;
      } | null;
      return `${c.kind}.${read?.operation}${c.kind === "marks" && read?.operation === "place" && read.check_only === true ? ".check" : ""}`;
    }
    case "retrieval":
      return c.operation === "documentCoverage"
        ? `${c.kind}.${c.operation}.${Array.isArray(c.args[0]) && c.args[0].length === 0 && c.args[2] === true ? "library" : "scope"}`
        : `${c.kind}.${c.operation}`;
    case "archive":
      if (c.action === "issues") {
        const request = c.args as { literature_id?: string } | null;
        return typeof request?.literature_id === "string"
          ? "archive.issues.literature"
          : "archive.issues.library";
      }
      return `${c.kind}.${c.action}`;
    case "review":
    case "snapshot":
    case "annotation":
    case "proofread":
    case "raw_parse":
    case "processor":
    case "extraction":
    case "tags":
      return `${c.kind}.${c.action}`;
    case "reference_query_snapshot":
      return `${c.kind}.${"reference_id" in c.selection ? "id" : "literature"}`;
    case "library_search_page":
      if (c.stateRead === "fallback")
        return "library_search_page.state-fallback";
      if (c.request.fullRelevance || c.request.limit > 200)
        return "library_search_page.selection";
      if (c.request.query.discovery_run_ids.length)
        return "library_search_page.discovery-scope";
      return needsLibraryState(c.request.query)
        ? "library_search_page.state-filter"
        : "library_search_page.page";
    case "library_snapshot": {
      const ids = c.literatureIds.length + c.metaLiteratureIds.length;
      return !c.scope && !c.discoveryRunIds.length && ids > 0 && ids <= 200
        ? "library_snapshot.ids"
        : "library_snapshot.query";
    }
    case "execution_task_detail_events":
      return `${c.kind}.${c.incrementalOnly ? "incremental" : "replay"}`;
    case "execution_task_detail_replay":
      return "execution_task_detail_events.replay";
    default:
      return c.kind;
  }
}

type LibraryStateFilter = {
  readonly statuses: readonly string[];
  readonly missing_steps: readonly string[];
  readonly needs_manual_pdf: boolean | null;
};

export function needsLibraryState(query: LibraryStateFilter): boolean {
  return (
    query.statuses.length > 0 ||
    query.missing_steps.length > 0 ||
    query.needs_manual_pdf === true
  );
}
