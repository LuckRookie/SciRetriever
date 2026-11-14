import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { METADATA_FIELDS, type DevicePurpose } from "@sciretriever/contracts";

const text = { type: "string" };
const id = {
  type: "string",
  pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
};
const hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
const sessionId = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" };
const epoch = { type: "integer", minimum: 0 };
const positive = { type: "integer", minimum: 1 };
const nullable = (value: object) => ({ anyOf: [value, { type: "null" }] });
const object = (
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const operations = [
  object({
    operation: { const: "parse-documents" },
    request: object(
      {
        literature_id: id,
        asset_id: id,
        asset_sha256: hash,
        profiles: {
          type: "array",
          items: { enum: ["pipeline", "vlm-engine"] },
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          description:
            "Two raw sources for archiving, not alternative parser backends. Defaults to both.",
        },
        force: {
          type: "boolean",
          description:
            "Explicitly rerun selected profiles. False reuses matching successful results.",
        },
      },
      ["literature_id", "asset_id", "asset_sha256"],
    ),
  }),
  object({
    operation: { const: "assess-article-identity" },
    request: object({
      schema_version: { const: 1 },
      literature_id: id,
      document_version_id: id,
      representation_sha256: hash,
      metadata_revision: positive,
      metadata_sha256: hash,
      budget: object({
        max_input_bytes: positive,
        max_output_tokens: positive,
      }),
    }),
  }),
  object({
    operation: { const: "build-archive" },
    request: {
      type: "object",
      description:
        "ArchiveBuildRequest: selector, mode, from_step, idempotency_key. Requires existing raw parses.",
    },
  }),
  object({
    operation: { const: "backfill-tags" },
    request: object({
      tag_ids: {
        type: "array",
        items: id,
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
      },
    }),
  }),
  object({
    operation: { const: "run-processor" },
    request: {
      type: "object",
      description:
        "A fixed ProcessorInvocation returned by processor submission preparation; uses archive-document or collection-snapshot inputs.",
    },
  }),
];
function tool(
  name: string,
  description: string,
  inputSchema: Tool["inputSchema"],
  readOnlyHint = true,
): Tool {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint,
      destructiveHint: false,
      idempotentHint: readOnlyHint,
      openWorldHint: !readOnlyHint,
    },
  };
}
export const BROWSER_QUERY_TOOLS: readonly Tool[] = [
  tool(
    "runtime_list_tasks",
    "Read tasks with progress {total,done} from the explicitly connected Web runtime. done counts targets with completed, failed or skipped dispositions. Does not open another Application.",
    object(
      {
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: text,
        status_group: { enum: ["active", "attention", "ended"] },
      },
      [],
    ),
  ),
  tool(
    "runtime_read_task",
    "Read task detail from the explicitly connected Web runtime.",
    object({ job_id: sessionId }),
  ),
  tool(
    "browser_view",
    "Observe the explicitly connected Workbench runtime, including sessions, current observation, task feedback and control epoch. Watching never pauses the Agent. controlled_by_client reports this connection's authority.",
    object({}),
  ),
  tool(
    "browser_select",
    "Select an existing session for this viewer only; does not take control.",
    object({ session_id: sessionId }),
  ),
  tool(
    "browser_tabs",
    "List pages exposed by the owning controlled Browser runtime.",
    object({}),
  ),
  tool(
    "browser_disconnect",
    "Close this runtime connection and revoke its control lease. Release explicitly before disconnect to return control; disconnect while controlling follows the owner's pause policy.",
    object({}),
    false,
  ),
];
export const BROWSER_MAINTENANCE_TOOLS: readonly Tool[] = [
  tool(
    "runtime_create_task",
    "Save a task in the connected Web runtime. request uses the same create_task shape. Does not run until runtime_control_task/run.",
    object({ request: { type: "object" } }),
    false,
  ),
  tool(
    "runtime_control_task",
    "Run, pause, cancel, resume or retry in the connected Web process. Background execution belongs to that process and can continue after the machine client exits.",
    object({
      job_id: sessionId,
      action: { enum: ["run", "pause", "cancel", "resume", "retry"] },
    }),
    false,
  ),
  tool(
    "browser_control",
    "Explicitly take, release, pause, resume or cancel an existing Browser session. Requires exact session/article binding and current control_epoch. Stale requests are rejected; no automatic retries.",
    object({
      kind: { enum: ["takeover", "release", "pause", "resume", "cancel"] },
      session_id: sessionId,
      article_id: sessionId,
      control_epoch: epoch,
    }),
    false,
  ),
  tool(
    "browser_action",
    "Send a controlled OperatorInput after takeover. Copy session/page/document/observation/viewport/epoch from the latest view; request_id supports idempotency. No JavaScript, CDP, cookies or arbitrary page handles.",
    object({
      session_id: sessionId,
      page_id: sessionId,
      document_generation: epoch,
      observation_revision: epoch,
      viewport_revision: epoch,
      control_epoch: epoch,
      request_id: sessionId,
      input: {
        type: "object",
        description:
          "OperatorInput: click-element, click-point, scroll-surface, go-back, wait-for-change, type-text, press-key or stop, with the contract's revision and target fields.",
      },
    }),
    false,
  ),
  tool(
    "browser_guidance",
    "Submit bounded natural-language guidance for the active article. This is an explicit instruction to the running Agent.",
    object({
      guidance_id: sessionId,
      session_id: sessionId,
      article_id: sessionId,
      control_epoch: epoch,
      text: { type: "string", maxLength: 2048 },
    }),
    false,
  ),
  tool(
    "browser_cancel_guidance",
    "Cancel this connection's still-pending guidance.",
    object({ guidance_id: sessionId, session_id: sessionId }),
    false,
  ),
  tool(
    "browser_activate_tab",
    "Activate a page exposed by the owning Browser runtime.",
    object({ page_id: sessionId }),
    false,
  ),
  ...(["accept", "abandon"] as const).map((action) =>
    tool(
      `browser_${action}_candidate`,
      `Explicitly ${action} a current PDF candidate through the existing owner; requires the control lease and exact transfer hash.`,
      object({
        session_id: sessionId,
        control_epoch: epoch,
        sha256: hash,
        transfer_id: sessionId,
      }),
      false,
    ),
  ),
];
export const QUERY_TOOLS: readonly Tool[] = [
  tool(
    "intake_batch_status",
    "Read a persisted intake batch without initializing the library or resuming import work.",
    object({ batch_id: id }),
  ),
  tool(
    "intake_batch_report",
    "Read the actual intake report with bounded record pagination. Files and import data use the intake HTTP API, not MCP.",
    object(
      {
        batch_id: id,
        cursor: nullable({ type: "string", pattern: "^\\d{1,4}:\\d{1,6}$" }),
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["batch_id"],
    ),
  ),
  tool(
    "processor_runs",
    "List bounded processor runs with actor, source selection, four part-outcome counts and staleness. Filters are conjunctive.",
    object(
      {
        processor_id: text,
        snapshot_id: id,
        literature_id: id,
        literature_query: text,
        stale: { type: "boolean" },
        offset: epoch,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      [],
    ),
  ),
  tool(
    "literature_results",
    "List all single- and multi-paper processor results involving a literature, with immutable result identity and staleness.",
    object(
      {
        literature_id: id,
        offset: epoch,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["literature_id"],
    ),
  ),
  tool(
    "usage_estimate",
    "Read historical median–P90 token estimates without models or writes. kind=processor with a ProcessorBatchRequest, archive with {selector:SnapshotDefinition}, or tags with {operation:backfill|consolidate,tag_ids?}. No history returns unknown; no cost or hard budget is imposed.",
    object(
      {
        kind: {
          type: "string",
          enum: [
            "processor",
            "archive",
            "tags",
            "synthesis",
            "archive-issues",
            "processing",
          ],
        },
        request: { type: "object" },
      },
      ["kind", "request"],
    ),
  ),
  tool(
    "task_run",
    "Read a paginated human/agent task projection: fixed run steps, literature titles, actor, usage and result/session links; no model calls.",
    object(
      {
        job_id: text,
        target_id: text,
        member_offset: epoch,
        member_limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: epoch,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["job_id"],
    ),
  ),
  tool(
    "source_statistics",
    "Read source-record aggregates for the last 30 days or all recorded history, with explicit ratio numerators/denominators and recorded_since. Never probes sources or writes the library.",
    object({ range: { enum: ["last-30-days", "all"] } }),
  ),
  tool(
    "intake_batches",
    "Read persistent intake batches. request is {operation:list,request:{limit?,cursor?}} or {operation:get,request:{batch_id}}.",
    object({ request: { type: "object" } }),
  ),
  tool(
    "library_facets",
    "Count direct active tags, author keywords and subject terms over the entire filtered library. Includes per-layer literature coverage and exact keyword-to-tag alias links.",
    object({
      query: { type: "object" },
      limit: { type: "integer", minimum: 1, maximum: 30 },
    }),
  ),
  tool(
    "acquire_pdf_preview",
    "Preview the frozen PDF acquisition scope. selector is {kind:query,query,sort,limit} or {kind:literatures,literature_ids}.",
    object({ selector: { type: "object" } }),
  ),
  tool(
    "agent_sessions",
    "Read DSH session list, bounded tool history, or revision. Ended histories expire after seven days; viewing never controls agents. operation=list|read|revision, request uses session_id/after/limit for read, job_id/literature_id/status/before/limit for list.",
    object(
      {
        operation: { type: "string", enum: ["list", "read", "revision"] },
        request: { type: "object" },
      },
      ["operation", "request"],
    ),
  ),
  tool(
    "operation_history",
    "Read bounded operation history with authenticated session or machine-entry attribution. No writes or models.",
    object(
      {
        actor: text,
        operation: text,
        after: epoch,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      [],
    ),
  ),
  tool(
    "snapshots_query",
    "Read frozen archive snapshots (read {snapshot_id,offset,limit,max_bytes}; list {after:null|snapshot_id,limit}; diff {before,after}). Read pages are bounded; follow next_offset. Differences separate membership, content versions and descriptions. No models or implicit recomputation.",
    object({
      operation: { enum: ["read", "list", "diff"] },
      request: { type: "object" },
    }),
  ),
  tool(
    "archive_arrangement",
    "Read a fixed arrangement summary or bounded JSON-UTF8 stream of leaves, breaks, or source-map; deleted content is never a document segment.",
    object(
      {
        schema_version: { const: 2 },
        asset_id: id,
        proofread_id: nullable(id),
        kind: { enum: ["summary", "leaves", "breaks", "source-map", "pages"] },
        visibility: { enum: ["kept", "dropped", "all"] },
        drop_reason: nullable(text),
        page_index: nullable(epoch),
        cursor: nullable(text),
        limit: { type: "integer", minimum: 1, maximum: 200 },
        max_bytes: { type: "integer", minimum: 1024, maximum: 65536 },
      },
      ["schema_version", "asset_id", "proofread_id", "kind"],
    ),
  ),
  tool(
    "archive_query",
    "Read archive status, issues, stats or persisted version events without starting work. Requests: status {literature_id}; issues {reason?,part?,offset?,limit?}; stats {}; events {after,limit}.",
    object({
      operation: { enum: ["status", "issues", "stats", "events"] },
      request: { type: "object" },
    }),
  ),
  tool(
    "tags_query",
    "Read the library tag vocabulary (list/search/show/state/changes/undo-preview), ordered literature assignment or a model-free backfill-preview. List/search returns {items,total,next_offset}; each item has the Tag fields plus uses, the direct literature assignment count (same as show.uses, excluding descendants). List defaults to active tags. Parent and merged tags resolve to active children. Preview reports candidates and estimated calls; old assignments may need explicit backfill.",
    object({
      operation: {
        enum: [
          "list",
          "search",
          "show",
          "state",
          "changes",
          "assignment",
          "backfill-preview",
          "undo-preview",
        ],
      },
      request: { type: "object" },
    }),
  ),
  tool(
    "metadata_fields",
    "Read accepted metadata with field sources, conflicts and manual locks. Does not run models.",
    object({ literature_id: id }),
    true,
  ),

  tool(
    "document_annotation",
    "Read fixed structure annotation, figures or references in bounded UTF-8 JSON chunks. Concatenate text chunks and parse JSON after continuation=null. Figures output uses one-based pages; all returns the immutable artifact with zero-based pages. Reads never call a model.",
    object({
      document_version_id: id,
      annotation_id: nullable(hash),
      field: { enum: ["all", "figures", "references"] },
      max_bytes: { type: "integer", minimum: 4, maximum: 65536 },
      continuation: nullable(text),
    }),
  ),
  tool(
    "reading_status",
    "Read corrected block source counts, page text-layer coverage and last manual edit for one asset. Rule-normalized blocks count as parser. No writes or models.",
    object({ asset_id: id }),
  ),
  tool(
    "proofread_text",
    "Read immutable corrected Markdown in UTF-8 chunks for editing. Bind subsequent reads and save to the returned proofread_id; no models or writes.",
    object(
      {
        asset_id: id,
        proofread_id: nullable(id),
        start: epoch,
        max_bytes: { type: "integer", minimum: 1024, maximum: 262144 },
      },
      ["asset_id"],
    ),
  ),
  tool(
    "proofread_page",
    "Read an original PDF page or region as bounded PNG base64 without model calls or catalog writes. Pages are zero-based.",
    object(
      {
        asset_id: id,
        page: epoch,
        region: {
          anyOf: [
            { type: "array", items: { type: "number" } },
            { type: "null" },
          ],
        },
      },
      ["asset_id", "page"],
    ),
  ),
  tool(
    "proofread_inspect",
    "Read bounded single-source drafts, corrections, unresolved questions and manual locks. No parsing or model calls.",
    object(
      {
        asset_id: id,
        offset: epoch,
        page_offset: epoch,
        page_limit: positive,
        block_id: id,
        limit: positive,
        unresolved_only: { type: "boolean" },
      },
      ["asset_id"],
    ),
  ),
  tool(
    "processor_query",
    "Read saved processor results, four part outcome counts, freshness reasons, records, evidence, collections or exports. Use action results with stale:true to list stale results. Never invokes models. Use action list for processor schemas. For complete large results or exports use action transfer with result_id, content_sha256, format result/json/csv/markdown, max_bytes (4–262144) and continuation null; follow next until null and verify transfer_sha256 on concatenated UTF-8 text.",
    object({
      action: {
        enum: [
          "list",
          "read",
          "results",
          "collections",
          "collection",
          "search",
          "search-collections",
          "query",
          "evidence",
          "export",
          "transfer",
        ],
      },
      request: { type: "object" },
    }),
    true,
  ),
  tool(
    "read_artifact_chunk",
    "Explicitly read a bounded chunk of catalog-owned PDF or Markdown bytes. Start with offset 0 and expected_sha256 null; bind every following chunk to the returned sha256. No server file paths. Document resources use document_read/resource.",
    object({
      literature_id: id,
      kind: { enum: ["primary-pdf"] },
      expected_sha256: nullable(hash),
      offset: { type: "integer", minimum: 0 },
      max_bytes: { type: "integer", minimum: 1, maximum: 196608 },
    }),
  ),
  tool(
    "export_bibliography",
    "Export selected literature as bibliography text with its hash. Read-only; batch at most 100 IDs, or use smaller batches when response-budget is reported.",
    object({
      literature_ids: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: id,
      },
      format: { enum: ["bibtex", "biblatex", "ris", "csl-json"] },
    }),
  ),
  tool(
    "status",
    "Read local library readiness. No initialization, recovery or external calls.",
    object({}),
  ),
  tool(
    "index_status",
    "Read index_state (ready/missing/corrupt), the durable queue, current or last operation and rebuild source progress. Reading does not refresh or rebuild. Retry with refresh_index or rebuild_index as appropriate.",
    object({}),
  ),
  tool(
    "folders_query",
    "Read folder tree and distinct direct/descendant counts, or preview deletion. operation list request {}; delete-preview request {folder_id}. Does not write.",
    object({
      operation: { enum: ["list", "delete-preview"] },
      request: { type: "object" },
    }),
  ),
  tool(
    "marks_query",
    "Read one paper's reading marks (highlights, region captures and notes) in reading order, or export them. operation list request {literature_id}; export request {literature_id, format: markdown|json}. Does not write.",
    object({
      operation: { enum: ["list", "export"] },
      request: { type: "object" },
    }),
  ),
  tool(
    "library_counts",
    "Count library quick filters, ignoring statuses and needs_manual_pdf but preserving all other LibraryQuery facets. No writes.",
    object({ query: { type: "object" } }),
  ),
  tool(
    "search_library",
    "Search existing literature with full LibraryQuery filters, sorting and pagination. A miss never starts discovery or PDF acquisition. The legacy text/limit/cursor form remains supported.",
    {
      type: "object",
      oneOf: [
        object({
          text: nullable(text),
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: nullable(text),
        }),
        object(
          {
            query: {
              type: "object",
              description:
                "LibraryQuery: text, title, author, author_orcids, identifiers, publication_year_from/to, venue, publisher, publication_forms, article_kinds, languages, keywords, version_roles, statuses, missing_steps, needs_manual_pdf, discovery_run_ids.",
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: nullable(text),
            sort: {
              enum: [
                "relevance",
                "intake-desc",
                "opened-desc",
                "publication-year-desc",
                "publication-year-asc",
                "title-asc",
                "title-desc",
              ],
            },
          },
          ["query"],
        ),
      ],
    },
  ),
  tool(
    "read_literature",
    "Read existing metadata, assets, parse information and current article identity assessment. IDs and hashes are stable references.",
    object({ literature_id: id }),
  ),
  tool(
    "document_read",
    "Read figures/reference-texts with {document_version_id,annotation_id,max_bytes,continuation} as a bounded JSON stream. Read parts with {literature_id,offset,limit}; corrections with {document_version_id,segment_id,max_bytes,continuation} returns a bounded resumable JSON UTF-8 stream for human audit. Describe optionally returns layout ranges for article information, figure/table groups and page footnotes in UTF-8 bytes. Outline titles are null when the source has no heading. Outline and segments accept annotation_id to pin role interpretation; segments also accepts roles to filter corrected blocks. Read raw parsing status with operation parsing-status and {literature_id, asset_id}. Read existing document data. request follows the named operation's closed document-read contract. Uses bounded pagination; does not parse or download.",
    object({
      operation: {
        enum: [
          "figures",
          "reference-texts",
          "parts",
          "corrections",
          "parsing-status",
          "default",
          "describe",
          "outline",
          "segments",
          "slice",
          "resources",
          "resource",
          "evidence",
          "material",
        ],
      },
      request: { type: "object" },
    }),
  ),
  tool(
    "prepare_analysis_inputs",
    "Freeze references to existing primary PDFs and default parsed documents for analysis; return gaps without creating materials. Copy the returned manifest into an explicitly requested analysis task.",
    object({
      literature_ids: {
        type: "array",
        items: id,
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
      },
    }),
  ),
  tool(
    "search_context",
    "Retrieve existing source or mixed knowledge context. request is the MaterialContextRequest or KnowledgeContextRequest contract, including scope/version/budget/continuation. Both kinds can return index-stale coverage with verified items and continuation. Mixed context keeps per-literature index-stale gaps and a material-index-stale summary, and still returns verified processor results. Material receipts include current source_revision and active indexed_revision. An index mutation invalidates old cursors, including mixed pages of processor results, and requires a new query. This read-only tool never refreshes/rebuilds an index or generates content.",
    object({
      kind: { enum: ["material", "knowledge"] },
      request: { type: "object" },
    }),
  ),
  tool(
    "read_task",
    "Read durable task state, fixed targets, result references, failures and bounded per-article acquisition_traces. accepted/queued/running is not a completed scientific result.",
    object({ job_id: text }),
  ),
  tool(
    "read_article_identity",
    "Read a saved, evidence-linked article assessment and whether it is current. match-supported is an advisory identity judgment, not a scientific correctness guarantee.",
    object({ assessment_id: id }),
  ),
  tool(
    "read_references",
    "Read a page of existing references/citations with source support. request follows LibraryReferenceRequest; no external discovery.",
    object({ request: { type: "object" } }),
  ),
  tool(
    "read_reference",
    "Read one existing reference and its supporting observations.",
    object({ reference_id: id }),
  ),
  tool(
    "prepare_extraction",
    "Validate caller-owned extraction spec and freeze existing materials. request follows ExtractionPreparationRequest. Does not execute an extraction model or create a delivery operation.",
    object({ request: { type: "object" } }),
  ),
  tool(
    "list_tasks",
    "List persisted tasks with progress {total,done}, cursor and active/attention/ended filter. done counts targets with completed, failed or skipped dispositions. Read-only; does not recover or execute tasks.",
    object(
      {
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: nullable(text),
        status_group: { enum: ["active", "attention", "ended"] },
      },
      [],
    ),
  ),
  tool(
    "inspect_task",
    "Read task targets, results, failures, events, acquisition_traces, interventions, policy and budget. acquisition_traces_truncated flags the bounded source history. Read-only, including tasks created from Web/CLI.",
    object({ job_id: text }),
  ),
  tool(
    "configuration_apply_state",
    "Read configuration apply lifecycle state; configuration-only processes are unmanaged.",
    object({}),
  ),
  tool(
    "configuration_sources",
    "Read all 15 source capabilities, presence, saved/effective routes and safe recent test results. No external requests.",
    object({}),
  ),
  tool(
    "configuration_read",
    "Read the supported ordinary configuration and revision from the fixed user home. No secret values or external probes.",
    object({}),
  ),
  tool(
    "configuration_status",
    "Read local configuration, credential-presence readiness and acquisition_routes (effective runtime or null, pending selection, restart difference). No external requests.",
    object({}),
  ),
  tool(
    "configuration_preview",
    "Validate a complete ordinary configuration candidate and show changed fields against baseline revision; does not publish. Supply exactly one of payload (TOML) or configuration (typed projection).",
    object(
      { baseline: text, payload: text, configuration: { type: "object" } },
      ["baseline"],
    ),
  ),
];
export const MAINTENANCE_TOOLS: readonly Tool[] = [
  tool(
    "configuration_apply",
    "Apply a saved binding in a managed runtime. Configuration-only processes return unmanaged and do not stop themselves.",
    object({
      request_id: id,
      runtime_id: sessionId,
      target_binding_revision: hash,
    }),
    false,
  ),
  tool(
    "configuration_apply_cancel",
    "Cancel an uncommitted apply request in its owning managed runtime.",
    object({ request_id: id, runtime_id: sessionId }),
    false,
  ),
  tool(
    "configuration_source_save",
    "Save exactly one source. Secret fields are replace/clear only; test_after_save explicitly authorizes the fixed probe. Partial publications enumerate committed fields.",
    object({
      source: {
        enum: [
          "web-of-science",
          "crossref",
          "semantic-scholar",
          "arxiv",
          "openalex",
          "europe-pmc",
          "elsevier",
          "springer",
          "datacite",
          "core",
          "opencitations",
          "unpaywall",
          "wiley",
          "sci-hub",
          "plos",
        ],
      },
      baseline: text,
      parameters: {
        anyOf: [
          object({ action: { const: "keep" } }),
          object({ action: { const: "reset" } }),
          object({ action: { const: "set" }, value: { type: "object" } }),
        ],
      },
      credentials: {
        type: "array",
        maxItems: 8,
        items: {
          anyOf: [
            object({ field: text, action: { const: "clear" } }),
            object({
              field: text,
              action: { const: "replace" },
              value: { type: "string", minLength: 1, maxLength: 65536 },
            }),
          ],
        },
      },
      test_after_save: { type: "boolean" },
    }),
    false,
  ),
  tool(
    "configuration_source_selection",
    "Save one exact metadata/PDF selection; Auto has no provider list. No probes.",
    object({
      baseline: text,
      domain: { enum: ["metadata", "pdf"] },
      selection: object({
        mode: { enum: ["auto", "custom"] },
        providers: {
          type: "array",
          maxItems: 15,
          uniqueItems: true,
          items: text,
        },
      }),
    }),
    false,
  ),
  tool(
    "configuration_source_test",
    "Explicitly test one source on its fixed fixture; no library writes.",
    object({ source: text, source_revision: text, request_id: id }),
    false,
  ),
  tool(
    "configuration_source_test_all",
    "Explicitly test configured sources serially, using shared access budgets.",
    object({
      catalog_revision: text,
      request_id: id,
      scope: { const: "configured" },
    }),
    false,
  ),
  tool(
    "proofread_save",
    "Save schema 2 Markdown only when its source map uniquely decomposes edits into leaf-local corrections. Supply the expected arrangement and manual revision. No model calls; mapping conflicts do not publish.",
    object(
      {
        literature_id: id,
        asset_id: id,
        proofread_id: id,
        schema_version: { const: 2 },
        expected_arrangement_id: hash,
        expected_manual_revision: epoch,
        markdown: text,
      },
      [
        "schema_version",
        "literature_id",
        "asset_id",
        "proofread_id",
        "expected_arrangement_id",
        "expected_manual_revision",
        "markdown",
      ],
    ),
    false,
  ),

  tool(
    "folders_manage",
    "Explicit folder create, rename, move, delete, add or remove. Deleting a subtree only removes membership, never papers. Member batches allow at most 1000 IDs. See FolderOperation contract.",
    object({
      operation: {
        enum: ["create", "rename", "move", "delete", "add", "remove"],
      },
      request: { type: "object" },
    }),
    false,
  ),
  tool(
    "marks_manage",
    "Explicit reading-mark create, update, delete or restore. create request {literature_id, kind: highlight|region, color: yellow|blue|green|red|purple, note?, quote?, quote_prefix?, quote_suffix?, pdf?: {sha256, page, rects: [[x,y,w,h]]}, document?: {document_version_id, start_utf8, end_utf8}}; a highlight needs its quote, a region needs pdf. update {mark_id, color?, note?, pdf?, document?}; delete and restore {mark_id}. Deleted marks stay restorable for 30 days. See MarkOperation contract.",
    object({
      operation: { enum: ["create", "update", "delete", "restore"] },
      request: { type: "object" },
    }),
    false,
  ),
  tool(
    "reading_open",
    "Explicitly record opening a paper for shared recent reading history. Queries themselves never update history.",
    object({ literature_id: id }),
    false,
  ),
  tool(
    "snapshot_rename",
    "Set a snapshot display name independently of its immutable content. Empty or null name restores the generated label.",
    object({ snapshot_id: id, name: nullable(text) }),
    false,
  ),
  tool(
    "snapshot_create",
    "Freeze READY literature IDs with their corrected part versions and descriptions. Supply {kind:'literatures',literature_ids} or {kind:'query',query:LibraryQuery}. Reports non-ready exclusions, never builds or analyzes them.",
    object(
      {
        name: nullable(text),
        kind: { enum: ["literatures", "query"] },
        literature_ids: { type: "array", items: id },
        query: { type: "object" },
      },
      ["kind"],
    ),
    false,
  ),
  tool(
    "archive_arrangement_edit",
    "Restore or reassign leaves with explicit version/CAS and human locks. Does not call a model.",
    object({
      schema_version: { const: 2 },
      literature_id: id,
      asset_id: id,
      expected_proofread_id: id,
      expected_arrangement_id: hash,
      expected_manual_revision: epoch,
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: object({
          kind: { enum: ["restore", "assign"] },
          leaf_id: id,
          target: { type: "object" },
          presentation: { type: "object" },
        }),
      },
    }),
  ),
  tool(
    "archive_manage",
    "Explicit build {schema_version:2,selector:{kind:'literatures',literature_ids} or {kind:'query',query},mode:'full'|'legacy-vlm-markdown',from_step:null|step,idempotency_key}; resume {literature_id}; resolve {issue_ids,resolution:'continue'|'skip'|'cancel'}. Requires pre-existing raw parses and never calls MinerU. Correct failed facts using arrangement/text editing, metadata or tag commands before resume; acknowledgement cannot establish readiness.",
    object({
      operation: { enum: ["build", "resume", "resolve"] },
      request: { type: "object" },
    }),
    false,
  ),
  tool(
    "tags_manage",
    "Explicitly change/undo the vocabulary, assign or lock literature tags, build tags from corrected main-document evidence, consolidate, or backfill. Requires expected revisions for edits. Run tags_query backfill-preview before executing backfill. Main themes only; compounds require literal title/abstract support; no conditions, reagents or publication-kind tags. Automation respects manual locks. Uses the shared DSH runtime for model work.",
    object({
      operation: {
        enum: ["change", "assign", "lock", "build", "consolidate", "backfill"],
      },
      request: { type: "object" },
    }),
    false,
  ),
  tool(
    "archive_references",
    "Explicitly resolve existing corrected main-paper references against the local library. Preserves unmatched text; does not query providers, download, parse or call models.",
    object({ literature_id: id, document_version_id: id, annotation_id: hash }),
    false,
  ),
  tool(
    "metadata_edit",
    "Explicitly edit and lock metadata fields or unlock fields, with an expected metadata revision. Does not run models or archive the paper.",
    object({
      literature_id: id,
      expected_revision: positive,
      set: {
        type: "array",
        items: object({ field: { enum: [...METADATA_FIELDS] }, value: {} }),
      },
      unlock: { type: "array", items: { enum: [...METADATA_FIELDS] } },
    }),
    false,
  ),

  tool(
    "document_annotate",
    "Deterministically derive annotation schema 2 from a fixed arranged document. Requires its arrangement ID; never calls a model. Old classification requests are obsolete.",
    object({
      schema_version: { const: 2 },
      document_version_id: id,
      arrangement_id: hash,
    }),
  ),
  tool(
    "document_role",
    "Set a section role lock, or revoke it with role=null. Atomically publishes a new annotation and retains the prior version and audit history. Supply the current manual revision.",
    object(
      {
        document_version_id: id,
        section_id: id,
        role: nullable(text),
        expected_manual_revision: epoch,
        actor: text,
      },
      ["document_version_id", "section_id", "role", "expected_manual_revision"],
    ),
    false,
  ),

  tool(
    "document_publish_proofread",
    "Explicitly publish a complete immutable proofreading version as the default readable document. No parser or model call.",
    object({
      schema_version: { const: 2 },
      literature_id: id,
      asset_id: id,
      proofread_id: id,
      expected_default_revision: nullable({ type: "integer", minimum: 1 }),
    }),
  ),
  tool(
    "proofread_build",
    "Proofread retained leaves of an already accepted arrangement, page by page. Does not arrange, parse or fetch. Old unbound raw-draft requests are obsolete.",
    object({
      schema_version: { const: 2 },
      asset_id: id,
      arrangement_id: hash,
      retry_page_indexes: nullable({
        type: "array",
        items: epoch,
        maxItems: 10000,
        uniqueItems: true,
      }),
    }),
  ),
  tool(
    "proofread_decide",
    "Explicit human correction of a fixed draft block. Locks the decision; use inspect to copy the current revision and hash, then explicitly build again.",
    object(
      {
        asset_id: id,
        proofread_id: id,
        block_id: id,
        draft_sha256: hash,
        expected_manual_revision: epoch,
        action: {
          enum: ["replace", "resolve-suspect", "no-body"],
        },
        reason: text,
        suspect_id: nullable(id),
        disposition: { anyOf: [{ type: "object" }, { type: "null" }] },
        text: nullable(text),
        actor: text,
        page: nullable(epoch),
      },
      [
        "asset_id",
        "proofread_id",
        "block_id",
        "draft_sha256",
        "expected_manual_revision",
        "action",
        "reason",
        "suspect_id",
        "disposition",
        "text",
        "page",
      ],
    ),
    false,
  ),
  tool(
    "proofread_revoke",
    "Explicitly revoke an active human correction using its fixed decision ID and current manual revision. Retains the audit record.",
    object(
      {
        asset_id: id,
        decision_id: id,
        expected_manual_revision: epoch,
        actor: text,
      },
      ["asset_id", "decision_id", "expected_manual_revision"],
    ),
    false,
  ),
  tool(
    "submit_processor",
    "Enqueue an explicitly chosen processor on READY corrected archive documents or a frozen snapshot. Single-paper processors cannot consume other results or raw parsing. Reuse depends on selected content versions, processor, spec and model; description edits do not invalidate single-paper results. Collection map results are reused; no automatic rebuild. Returns a durable job; use read_task for progress.",
    object({ request: { type: "object" } }),
    false,
  ),
  tool(
    "rebuild_processor_index",
    "Explicitly rebuild processor search projections from verified immutable results.",
    object({ result_ids: { type: ["array", "null"], items: id } }),
    false,
  ),
  tool(
    "retain_extraction",
    "Validate the complete external candidate through extraction delivery, then explicitly retain its content and evidence beyond receipt expiry.",
    object({ request: { type: "object" } }),
    false,
  ),
  tool(
    "begin_pdf_upload",
    "Reserve a connection-local disk-spooled PDF upload without a file-size ceiling. Expires after 10 minutes or disconnect; no file paths. Supply full byte size/hash before bounded chunks. Does not publish literature.",
    object({
      literature_id: id,
      sha256: hash,
      byte_size: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    }),
    false,
  ),
  tool(
    "append_pdf_upload",
    "Append a canonical base64 chunk at the exact byte offset. Identical already-received chunks may be retried. Does not publish literature.",
    object({
      upload_id: id,
      offset: { type: "integer", minimum: 0 },
      bytes_base64: { type: "string", maxLength: 262144 },
    }),
    false,
  ),
  tool(
    "commit_pdf_upload",
    "Explicitly consume a complete hash-verified upload and accept it through the same PDF owner as Web/CLI. PDF validation and primary-asset conflicts still apply. Inspect literature after ambiguous publication failure; the upload handle is consumed.",
    object({ upload_id: id }),
    false,
  ),
  tool(
    "discard_pdf_upload",
    "Discard an unfinished connection-local upload. Accepted immutable assets are unaffected.",
    object({ upload_id: id }),
    false,
  ),
  tool(
    "submit_processing",
    "Submit explicitly USER-REQUESTED processing of EXISTING fixed materials. Operations are independent frozen targets, not an implicit dependency pipeline. Omit parse-documents profiles to use the deployment profile; another explicit profile is for inspection and does not participate in proofreading. Use result IDs to submit a later stage. Persists an idempotent job, then starts it in this process; returns its ID immediately. Read_task provides results. No implicit discovery or download.",
    object({
      schema_version: { const: 1 },
      idempotency_key: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { oneOf: operations },
      },
    }),
    false,
  ),
  tool(
    "acquire_pdf",
    "Submit USER-REQUESTED PDF acquisition for explicit literature IDs using configured public/API/Browser routes. Returns a durable job reference, not a PDF-success claim.",
    object({
      literature_ids: {
        type: "array",
        items: id,
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
      },
      idempotency_key: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    }),
    false,
  ),
  tool(
    "discover_metadata",
    "Perform USER-REQUESTED bounded topic discovery; saves metadata only. Does not download PDF. The result is an operation report, not a relevance guarantee.",
    object({
      query: text,
      year_from: nullable(positive),
      year_to: nullable(positive),
      providers: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: object({
          provider_name: text,
          scan_limit: { type: "integer", minimum: 1, maximum: 10000 },
        }),
      },
    }),
    false,
  ),
  tool(
    "control_task",
    "Explicitly run, pause, cancel, resume or retry a durable job. Resume/retry preserves completed targets. A stopped stdio process performs no background work; reopen and explicitly run/retry. Remote model calls cannot be guaranteed exactly once after a crash.",
    object({
      job_id: text,
      action: { enum: ["run", "pause", "cancel", "resume", "retry"] },
    }),
    false,
  ),
  tool(
    "import_bibliography",
    "Explicitly import supplied bibliography bytes as text into the shared library; no PDF acquisition.",
    object(
      {
        format: { enum: ["bibtex", "biblatex", "ris", "csl-json"] },
        content: { type: "string", maxLength: 786432 },
        file_name: nullable({ type: "string", minLength: 1, maxLength: 1024 }),
      },
      ["format", "content"],
    ),
    false,
  ),
  tool(
    "lookup_metadata",
    "Explicitly complete bibliography for existing literatures through configured metadata sources; records a durable task, never downloads PDF.",
    object({
      literature_ids: {
        type: "array",
        items: id,
        minItems: 1,
        maxItems: 1000,
        uniqueItems: true,
      },
      scan_limit: { type: "integer", minimum: 1, maximum: 10000 },
    }),
    false,
  ),
  tool(
    "discover_citations",
    "Explicitly expand existing literature references or citations using configured sources. Saves metadata/relations, not PDFs.",
    object({
      seed_literature_id: id,
      direction: { enum: ["references", "cited-by"] },
      scan_limit: { type: "integer", minimum: 1, maximum: 10000 },
    }),
    false,
  ),
  tool(
    "intake_batch_rename",
    "Rename one intake batch; null restores its default label.",
    object({
      batch_id: id,
      label: nullable({ type: "string", minLength: 1, maxLength: 120 }),
    }),
    false,
  ),
  tool(
    "create_task",
    "Save a durable Web-compatible task without executing it. request is {kind: processing, request: ProcessingTaskRequest}, {kind: metadata, idempotency_key, request: MetadataTaskRequest (providers optional)}, or {kind: acquire-pdf, idempotency_key, selector, policy?}. Call control_task run explicitly after inspecting the saved scope.",
    object({ request: { type: "object" } }),
    false,
  ),
  tool(
    "resolve_intervention",
    "Resolve a saved task intervention belonging to the named job. Does not implicitly run the task; use control_task afterward if required.",
    object({
      job_id: text,
      intervention_id: text,
      resolution: { enum: ["continue", "skip", "cancel"] },
    }),
    false,
  ),
  tool(
    "refresh_index",
    "Schedule incremental index refresh in the existing background queue and immediately return IndexRefreshStatus. No download, parse or model calls.",
    object({}),
    false,
  ),
  tool(
    "rebuild_index",
    "Rebuild the source index from existing material. By default waits and returns the generation receipt; background:true queues it and returns IndexRefreshStatus. Does not download or parse.",
    object({ background: { type: "boolean" } }, []),
    false,
  ),
  tool(
    "verify_index",
    "Explicitly verify all indexed source text, SQLite structure, FTS postings and whole-generation hashes. Does not rebuild, download or parse. Rebuild if verification reports corruption.",
    object({}),
    false,
  ),
  tool(
    "verify_catalog",
    "Explicitly verify the complete SQLite catalog layout, integrity, foreign keys and stored retrieval certificates. Works without a built retrieval index. Does not repair or read artifact contents.",
    object({}),
    false,
  ),
  tool(
    "create_extraction",
    "Create a delivery operation from a previously prepared caller spec and fixed manifest. Does not perform automatic extraction.",
    object({ request: { type: "object" } }),
    false,
  ),
  tool(
    "read_extraction",
    "Read a saved extraction delivery operation.",
    object({ operation_id: text }),
  ),
  tool(
    "submit_extraction",
    "Validate and deliver caller-produced evidence-linked candidates. request follows ExtractionSubmission; retain idempotency keys on retry.",
    object({ request: { type: "object" } }),
    false,
  ),
  tool(
    "read_extraction_receipt",
    "Read a persisted delivery receipt; acceptance is protocol validation, not downstream scientific approval.",
    object({ receipt_id: text }),
  ),
  tool(
    "close_extraction",
    "Explicitly close a delivery operation.",
    object({ operation_id: text }),
    false,
  ),
  tool(
    "cancel_extraction",
    "Explicitly cancel a delivery operation without reverting accepted facts.",
    object({ operation_id: text }),
    false,
  ),
  tool(
    "cleanup_extractions",
    "Explicitly clean expired extraction handoff data using the extraction owner's retention rules.",
    object({ limit: { type: "integer", minimum: 1, maximum: 1000 } }),
    false,
  ),
  tool(
    "configuration_publish",
    "Explicitly publish selected ordinary configuration sections with baseline CAS. Supply exactly one of payload (TOML) or configuration. Existing runtimes retain startup configuration; restart them to apply changes.",
    object(
      {
        baseline: text,
        sections: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            enum: [
              "network",
              "paths",
              "sources",
              "providers",
              "models",
              "analyze",
              "browser-model",
              "browser-site",
              "all",
              "parsing",
            ],
          },
        },
        payload: text,
        configuration: { type: "object" },
      },
      ["baseline", "sections"],
    ),
    false,
  ),
  tool(
    "configuration_credential",
    "Explicitly set/remove a credential through the configuration owner. Never reads or returns secret values. edit uses namespace model/source/mineru/proxy, target, kind keep/remove/set and value (model/mineru/proxy) or fields (source) only for set. Proxy authentication is bound to the saved network.proxy origin.",
    object({ baseline: text, edit: { type: "object" } }),
    false,
  ),
  tool(
    "configuration_probe",
    "Explicitly test one configured capability. May contact external services, consume quota or launch the controlled Browser; does not write literature.",
    object({
      owner: {
        enum: [
          "proxy",
          "provider",
          "model",
          "search",
          "download",
          "parse",
          "analyze",
          "browser-model",
          "browser-site",
          "all",
        ],
      },
      target: nullable(text),
      image: { type: "boolean" },
    }),
    false,
  ),
];

/** HTTP transport restrictions only; every allowed definition/handler remains shared with stdio. */
export const HTTP_MCP_EXCLUDED_TOOLS = [
  "import_bibliography",
  "begin_pdf_upload",
  "append_pdf_upload",
  "commit_pdf_upload",
  "discard_pdf_upload",
] as const;
export function httpMcpPurpose(name: string): "read" | "operate" | null {
  if (
    name.startsWith("configuration_") ||
    name.startsWith("device_") ||
    name.startsWith("browser_") ||
    name.startsWith("runtime_") ||
    HTTP_MCP_EXCLUDED_TOOLS.some((n) => n === name)
  )
    return null;
  if (QUERY_TOOLS.some((t) => t.name === name)) return "read";
  if (MAINTENANCE_TOOLS.some((t) => t.name === name)) return "operate";
  return null;
}
export function httpMcpAllowed(
  name: string,
  purposes: readonly DevicePurpose[],
): boolean {
  const purpose = httpMcpPurpose(name);
  return purpose !== null && purposes.includes(purpose);
}
