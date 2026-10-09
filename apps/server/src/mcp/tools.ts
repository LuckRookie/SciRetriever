import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const text = { type: "string" };
const id = {
  type: "string",
  pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
};
const hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
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
  object({ operation: { const: "analyze" }, request: object(analysis) }),
  object({
    operation: { const: "analyze-long" },
    request: object({
      ...analysis,
      schema_version: { const: 2 },
      budget: longBudget,
    }),
  }),
  object({
    operation: { const: "synthesize" },
    request: object({
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
export const QUERY_TOOLS: readonly Tool[] = [
  tool(
    "status",
    "Read local library readiness. No initialization, recovery or external calls.",
    object({}),
  ),
  tool(
    "search_library",
    "Search only existing literature. A miss never starts discovery or PDF acquisition.",
    object({
      text: nullable(text),
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: nullable(text),
    }),
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
];
export const MAINTENANCE_TOOLS: readonly Tool[] = [
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
];
