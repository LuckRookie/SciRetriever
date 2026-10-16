import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
const processingRequest = (properties: Record<string, object>) =>
  object(
    properties,
    Object.keys(properties).filter((key) => key !== "budget"),
  );
const fixedInput = {
  type: "object",
  description:
    "Copy the complete fixed InputManifest returned by prepare_analysis_inputs, or the SynthesisInputManifest from prepare_synthesis. Do not invent IDs or hashes.",
};
const analysis = {
  schema_version: { const: 1 },
  input: fixedInput,
  purpose: { enum: ["overview", "detailed", "question"] },
  question: nullable(text),
  default_update: nullable(object({ expected_revision: nullable(positive) })),
  budget: object({ max_input_bytes: positive, max_output_tokens: positive }),
};
const longBudget = object({
  max_source_bytes: positive,
  max_call_bytes: positive,
  max_total_call_bytes: positive,
  max_calls: positive,
  max_output_tokens_per_call: positive,
  max_total_output_tokens: positive,
});
const operations = [
  object({
    operation: { const: "parse-documents" },
    request: object({
      literature_id: id,
      asset_id: id,
      asset_sha256: hash,
      mode: { enum: ["reuse-current", "reparse"] },
      expected_default_revision: nullable(positive),
    }),
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
    operation: { const: "analyze" },
    request: processingRequest(analysis),
  }),
  object({
    operation: { const: "analyze-long" },
    request: processingRequest({
      ...analysis,
      schema_version: { const: 2 },
      budget: longBudget,
    }),
  }),
  object({
    operation: { const: "synthesize" },
    request: processingRequest({
      schema_version: { const: 3 },
      input: fixedInput,
      purpose: { const: "synthesis" },
      question: text,
      policy: { enum: ["require-all", "allow-partial"] },
      budget: object({
        ...longBudget.properties,
        max_verification_bytes: positive,
      }),
    }),
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
    "Read tasks from the explicitly connected Web runtime. Does not open another Application.",
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
    "browser_frame",
    "Read the current JPEG frame from the selected session and exact observation frame_seq. Returns an image; a replaced frame is refused.",
    object({ session_id: sessionId, frame_seq: epoch }),
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
    "read_artifact_chunk",
    "Explicitly read a bounded chunk of catalog-owned PDF or Markdown bytes. Start with offset 0 and expected_sha256 null; bind every following chunk to the returned sha256. No server file paths. Document resources use document_read/resource.",
    object({
      literature_id: id,
      kind: { enum: ["primary-pdf", "content-markdown"] },
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
                "LibraryQuery: text, title, author, author_orcids, identifiers, publication_year_from/to, venue, publisher, document_types, languages, keywords, version_roles, statuses, missing_steps, needs_manual_pdf, discovery_run_ids.",
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: nullable(text),
            sort: {
              enum: [
                "relevance",
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
    "Read existing document data. request follows the named operation's closed document-read contract. Uses bounded pagination; does not parse or download.",
    object({
      operation: {
        enum: [
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
    "prepare_synthesis",
    "Prepare a fixed synthesis manifest from existing knowledge/documents. request: {policy: require-all|allow-partial, inputs: SynthesisSelection[]}. Does not call models.",
    object({ request: { type: "object" } }),
  ),
  tool(
    "read_knowledge",
    "Read a previously published single-paper or synthesis artifact by stable ID.",
    object({ artifact_id: id, kind: { enum: ["single", "synthesis"] } }),
  ),
  tool(
    "search_context",
    "Retrieve existing source or mixed knowledge context. request is the MaterialContextRequest or KnowledgeContextRequest contract, including scope/version/budget/continuation. Never rebuilds an index or generates content.",
    object({
      kind: { enum: ["material", "knowledge"] },
      request: { type: "object" },
    }),
  ),
  tool(
    "read_task",
    "Read durable task state, fixed targets, result references and failures. accepted/queued/running is not a completed scientific result.",
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
    "list_knowledge",
    "List verified knowledge for one literature, latest first.",
    object({
      literature_id: id,
      limit: { type: "integer", minimum: 1, maximum: 20 },
    }),
  ),
  tool(
    "default_knowledge",
    "Read the current default knowledge for a purpose/question; null means missing, never generates.",
    object({
      literature_id: id,
      purpose: { enum: ["overview", "detailed", "question"] },
      question: nullable(text),
    }),
  ),
  tool(
    "list_syntheses",
    "List existing synthesis artifacts and coverage, latest first.",
    object({
      manifest_sha256: nullable(hash),
      limit: { type: "integer", minimum: 1, maximum: 20 },
    }),
  ),
  tool(
    "read_synthesis_source",
    "Read a synthesis source artifact with its current verified/source-only classification.",
    object({ artifact_id: id }),
  ),
  tool(
    "prepare_extraction",
    "Validate caller-owned extraction spec and freeze existing materials. request follows ExtractionPreparationRequest. Does not execute an extraction model or create a delivery operation.",
    object({ request: { type: "object" } }),
  ),
  tool(
    "list_tasks",
    "List persisted tasks with cursor and active/attention/ended filter. Read-only; does not recover or execute tasks.",
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
    "Read task targets, results, failures, events, interventions, policy and budget. Read-only, including tasks created from Web/CLI.",
    object({ job_id: text }),
  ),
  tool(
    "configuration_read",
    "Read the supported ordinary configuration and revision from the fixed user home. No secret values or external probes.",
    object({}),
  ),
  tool(
    "configuration_status",
    "Read local configuration and credential-presence readiness. No external requests.",
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
    "begin_pdf_upload",
    "Reserve a connection-local PDF upload, at most 16 MiB. Expires after 10 minutes or disconnect; no file paths. Supply full byte size/hash before sending bounded chunks. Does not publish literature.",
    object({
      literature_id: id,
      sha256: hash,
      byte_size: { type: "integer", minimum: 1, maximum: 16777216 },
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
    "Submit explicitly USER-REQUESTED processing of EXISTING fixed materials. Operations are independent frozen targets, not an implicit dependency pipeline. Use result IDs to submit a later stage. Persists an idempotent job, then starts it in this process; returns its ID immediately. Read_task provides results. No implicit discovery or download.",
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
    object({
      format: { enum: ["bibtex", "biblatex", "ris", "csl-json"] },
      content: { type: "string", maxLength: 786432 },
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
    "create_task",
    "Save a durable Web-compatible task without executing it. request is {kind: processing, request: ProcessingTaskRequest} or {kind: acquire-pdf, idempotency_key, selector, policy?}. Call control_task run explicitly after inspecting the saved scope.",
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
    "rebuild_index",
    "Explicitly rebuild the original-document search index from existing material; does not download or parse.",
    object({}),
    false,
  ),
  tool(
    "rebuild_knowledge_index",
    "Explicitly rebuild the knowledge search index from existing artifacts; does not call models.",
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
    "Explicitly set/remove a credential through the configuration owner. Never reads or returns secret values. edit uses namespace model/source/mineru, target, kind keep/remove/set and value (model/mineru) or fields (source) only for set.",
    object({ baseline: text, edit: { type: "object" } }),
    false,
  ),
  tool(
    "configuration_probe",
    "Explicitly test one configured capability. May contact external services, consume quota or launch the controlled Browser; does not write literature.",
    object({
      owner: {
        enum: [
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
