import {
  annotationRecord,
  annotationInteger,
  canonicalJsonBytes,
  sha256,
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseArtifactRef,
  parseArrangementSourceBlock,
  parseArrangementSnapshot,
  parseLeafDestination,
  parsePageProofreadRecord,
  parseArchiveModelUsage,
  parseArchiveTextStop,
  parseArchiveSectionTarget,
  parseLeafPresentation,
  parseRawResourceReference,
  type ArrangementSourceBlock,
  type ArrangementSnapshot,
  type ArrangementLeaf,
  type LeafDestination,
  type PageProofreadRecord,
  type ArchiveModelUsage,
  type ArchiveTextStop,
  type ArtifactRef,
  type RawParseResource,
  type Sha256,
  type ManualArrangementChange,
  type ArchiveStep,
  type ArchiveSectionRole,
  ARCHIVE_STEPS,
  ARCHIVE_DROP_REASONS,
} from "./index.js";

export interface ArchiveTextBundleV2 {
  readonly schema_version: 2;
  readonly page_count: number;
  readonly source_blocks: readonly ArrangementSourceBlock[];
  readonly arrangement: ArrangementSnapshot | null;
  readonly leaves: readonly {
    readonly leaf: ArrangementLeaf;
    readonly destination: LeafDestination;
    readonly corrected_text: string;
    readonly correction_ids: readonly string[];
    readonly text_source: "parser" | "agent" | "manual";
    readonly basis: "text-layer" | "image-only" | "manual";
  }[];
}
export interface ProofreadVersionV2 {
  readonly schema_version: 2;
  readonly proofread_id: string;
  readonly content_sha256: Sha256;
  readonly part_asset_id: string;
  readonly part_sha256: Sha256;
  readonly draft_input: {
    readonly profile: "pipeline" | "vlm-engine" | "vlm-engine-markdown-only";
    readonly raw_parse_id: string;
    readonly result_sha256: string;
  };
  readonly method: {
    readonly arrange: string;
    readonly page_classify: string;
    readonly suspects: string;
    readonly correction: string;
    readonly model_config_sha256: string | null;
  };
  readonly manual_decision_ids: readonly string[];
  readonly status: "complete" | "incomplete" | "failed";
  readonly arrangement_id: string | null;
  readonly blocks: ArtifactRef;
  readonly pages: readonly PageProofreadRecord[];
  readonly resources: readonly RawParseResource[];
  readonly usage: ArchiveModelUsage;
  readonly stop: ArchiveTextStop | null;
}
export interface ArrangementEditRequest {
  readonly schema_version: 2;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly expected_proofread_id: string;
  readonly expected_arrangement_id: string;
  readonly expected_manual_revision: number;
  readonly changes: readonly ManualArrangementChange[];
}
export type ArrangementQueryV2 = {
  readonly schema_version: 2;
  readonly asset_id: string;
  readonly proofread_id: string | null;
} & (
  | { readonly kind: "summary" }
  | {
      readonly kind: "leaves";
      readonly visibility: "kept" | "dropped" | "all";
      readonly drop_reason: string | null;
      readonly page_index: number | null;
      readonly cursor: string | null;
      readonly limit: number;
      readonly max_bytes: number;
    }
  | {
      readonly kind: "breaks" | "source-map" | "pages";
      readonly cursor: string | null;
      readonly limit: number;
      readonly max_bytes: number;
    }
);
export interface EstimateRange {
  readonly median: number;
  readonly p90: number;
}
export interface ArchiveEstimateComponent {
  readonly kind?: ArchiveStep;
  readonly step: ArchiveStep;
  readonly unit: "part" | "page" | "literature";
  readonly units: number | null;
  readonly sample_count: number;
  readonly basis: "matching-history" | "deterministic" | "unknown";
  readonly calls: EstimateRange | null;
  readonly input_tokens: EstimateRange | null;
  readonly output_tokens: EstimateRange | null;
  readonly unknown_code:
    | "no-matching-history"
    | "pages-unknown"
    | "source-missing"
    | "model-unavailable"
    | "partial-reuse-unknown"
    | null;
}
export interface ArchiveUsageEstimateV2 {
  readonly schema_version: 2;
  readonly kind: "archive";
  readonly available: boolean;
  readonly no_hard_limit: true;
  readonly count: number;
  readonly reused_count: number;
  readonly total_pdf_pages: number | null;
  readonly expected_proofread_pages: number | null;
  readonly page_basis: "accepted-arrangement" | "all-pdf-pages" | "unknown";
  readonly components: readonly ArchiveEstimateComponent[];
  readonly total: {
    readonly calls: EstimateRange | null;
    readonly input_tokens: EstimateRange | null;
    readonly output_tokens: EstimateRange | null;
  };
  readonly estimate_method: string;
}
export interface ArchiveProgressV2 {
  readonly schema_version: 2;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly part: "main" | "supplementary";
  readonly step: ArchiveStep;
  readonly phase:
    | "started"
    | "progress"
    | "validation-rejected"
    | "page-accepted"
    | "reused"
    | "stopped"
    | "completed";
  readonly page_index: number | null;
  readonly pages: {
    readonly required: number;
    readonly accepted: number;
    readonly reused: number;
    readonly pending?: number;
    readonly failed?: number;
  } | null;
  readonly usage: ArchiveModelUsage;
  readonly stop: ArchiveTextStop | null;
}
export function archiveHash(v: unknown): Sha256 {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v))
    throw new ContractValidationError();
  return parseArtifactRef({
    sha256: v,
    byte_size: 1,
    media_type: "application/json",
  }).sha256;
}
export function archiveList<T>(
  v: unknown,
  parse: (v: unknown) => T,
  max = 100000,
): readonly T[] {
  if (!Array.isArray(v) || v.length > max) throw new ContractValidationError();
  return v.map(parse);
}
export function archiveText(v: unknown, max = 4 * 1024 * 1024): string {
  if (typeof v !== "string" || v.includes("\0") || BufferFreeLength(v) > max)
    throw new ContractValidationError();
  return v;
}
function BufferFreeLength(v: string) {
  return new TextEncoder().encode(v).length;
}
export function parseArchiveTextBundleV2(value: unknown): ArchiveTextBundleV2 {
  const r = annotationRecord(value, [
    "schema_version",
    "page_count",
    "source_blocks",
    "arrangement",
    "leaves",
  ]);
  if (r.schema_version !== 2) throw new ContractValidationError();
  const page_count = annotationInteger(r.page_count, 1, 10000),
    source_blocks = archiveList(r.source_blocks, (v) =>
      parseArrangementSourceBlock(v, page_count),
    ),
    arrangement =
      r.arrangement === null
        ? null
        : parseArrangementSnapshot(r.arrangement, page_count);
  const leaves = archiveList(r.leaves, (v) => {
    const q = annotationRecord(v, [
      "leaf",
      "destination",
      "corrected_text",
      "correction_ids",
      "text_source",
      "basis",
    ]);
    const leaf = arrangement?.leaves.find(
      (l) => l.leaf_id === (q.leaf as { leaf_id?: unknown } | null)?.leaf_id,
    );
    if (
      !leaf ||
      JSON.stringify(
        JSON.parse(new TextDecoder().decode(canonicalJsonBytes(q.leaf))),
      ) !==
        JSON.stringify(
          JSON.parse(new TextDecoder().decode(canonicalJsonBytes(leaf))),
        ) ||
      !["parser", "agent", "manual"].includes(String(q.text_source)) ||
      !["text-layer", "image-only", "manual"].includes(String(q.basis))
    )
      throw new ContractValidationError();
    const root = source_blocks.find(
      (b) => b.root_block_id === leaf.source.root_block_id,
    );
    if (
      !root ||
      root.source_sha256 !== leaf.source.source_sha256 ||
      [...root.text].slice(leaf.source.start, leaf.source.end).join("") !==
        leaf.original_text
    )
      throw new ContractValidationError();
    const destination = parseLeafDestination(q.destination);
    if (
      JSON.stringify(destination) !==
      JSON.stringify(
        arrangement!.destinations.find((d) => d.leaf_id === leaf.leaf_id)!
          .destination,
      )
    )
      throw new ContractValidationError();
    return {
      leaf,
      destination,
      corrected_text: archiveText(q.corrected_text),
      correction_ids: archiveList(q.correction_ids, parseAssetId),
      text_source: q.text_source as "parser" | "agent" | "manual",
      basis: q.basis as "text-layer" | "image-only" | "manual",
    };
  });
  if (
    leaves.length !== (arrangement?.leaves.length ?? 0) ||
    new Set(leaves.map((l) => l.leaf.leaf_id)).size !== leaves.length ||
    new Set(source_blocks.map((b) => b.root_block_id)).size !==
      source_blocks.length
  )
    throw new ContractValidationError();
  return { schema_version: 2, page_count, source_blocks, arrangement, leaves };
}
export async function parseProofreadVersionV2(
  value: unknown,
): Promise<ProofreadVersionV2> {
  const r = annotationRecord(value, [
    "schema_version",
    "proofread_id",
    "content_sha256",
    "part_asset_id",
    "part_sha256",
    "draft_input",
    "method",
    "manual_decision_ids",
    "status",
    "arrangement_id",
    "blocks",
    "pages",
    "resources",
    "usage",
    "stop",
  ]);
  const d = annotationRecord(r.draft_input, [
      "profile",
      "raw_parse_id",
      "result_sha256",
    ]),
    m = annotationRecord(r.method, [
      "arrange",
      "page_classify",
      "suspects",
      "correction",
      "model_config_sha256",
    ]);
  if (
    r.schema_version !== 2 ||
    !["pipeline", "vlm-engine", "vlm-engine-markdown-only"].includes(
      String(d.profile),
    ) ||
    !["complete", "incomplete", "failed"].includes(String(r.status))
  )
    throw new ContractValidationError();
  if (!Array.isArray(r.pages) || !r.pages.length || r.pages.length > 10000)
    throw new ContractValidationError();
  const pages = r.pages.map((v) =>
    parsePageProofreadRecord(v, r.pages instanceof Array ? r.pages.length : 0),
  );
  const v: ProofreadVersionV2 = {
    schema_version: 2,
    proofread_id: parseAssetId(r.proofread_id),
    content_sha256: archiveHash(r.content_sha256),
    part_asset_id: parseAssetId(r.part_asset_id),
    part_sha256: archiveHash(r.part_sha256),
    draft_input: {
      profile: d.profile as ProofreadVersionV2["draft_input"]["profile"],
      raw_parse_id: parseAssetId(d.raw_parse_id),
      result_sha256: archiveHash(d.result_sha256),
    },
    method: {
      arrange: archiveText(m.arrange, 128),
      page_classify: archiveText(m.page_classify, 128),
      suspects: archiveText(m.suspects, 128),
      correction: archiveText(m.correction, 128),
      model_config_sha256:
        m.model_config_sha256 === null
          ? null
          : archiveHash(m.model_config_sha256),
    },
    manual_decision_ids: archiveList(r.manual_decision_ids, parseAssetId),
    status: r.status as ProofreadVersionV2["status"],
    arrangement_id:
      r.arrangement_id === null ? null : archiveHash(r.arrangement_id),
    blocks: parseArtifactRef(r.blocks),
    pages,
    resources: archiveList(r.resources, (v) => {
      const q = annotationRecord(v, ["reference", "artifact"]);
      return {
        reference: parseRawResourceReference(q.reference),
        artifact: parseArtifactRef(q.artifact),
      };
    }),
    usage: parseArchiveModelUsage(r.usage),
    stop: r.stop === null ? null : parseArchiveTextStop(r.stop),
  };
  if (
    pages.some((p, i) => p.page_index !== i) ||
    (v.status === "complete" &&
      (!v.arrangement_id ||
        v.stop ||
        pages.some((p) => !["accepted", "not-required"].includes(p.status))))
  )
    throw new ContractValidationError();
  const { proofread_id, content_sha256 } = v;
  const { usage, pages: identityPages, ...body } = v;
  void usage;
  const {
    proofread_id: ignoredId,
    content_sha256: ignoredHash,
    ...input
  } = body;
  void ignoredId;
  void ignoredHash;
  const hash = await archiveProofreadHash({
      ...input,
      pages: identityPages,
      usage: v.usage,
    }),
    id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  if (hash !== content_sha256 || id !== proofread_id)
    throw new ContractValidationError();
  return v;
}
export function parseArrangementEditRequest(
  value: unknown,
): ArrangementEditRequest {
  const r = annotationRecord(value, [
    "schema_version",
    "literature_id",
    "asset_id",
    "expected_proofread_id",
    "expected_arrangement_id",
    "expected_manual_revision",
    "changes",
  ]);
  if (r.schema_version !== 2) throw new ContractValidationError();
  const changes = archiveList(
    r.changes,
    (v): ManualArrangementChange => {
      const q = annotationRecord(v, [
        "kind",
        "leaf_id",
        "target",
        "presentation",
      ]);
      if (q.kind !== "restore" && q.kind !== "assign")
        throw new ContractValidationError();
      return {
        kind: q.kind,
        leaf_id: parseAssetId(q.leaf_id),
        target: parseArchiveSectionTarget(q.target),
        presentation: parseLeafPresentation(q.presentation),
      };
    },
    200,
  );
  if (
    !changes.length ||
    new Set(changes.map((c) => c.leaf_id)).size !== changes.length
  )
    throw new ContractValidationError();
  return {
    schema_version: 2,
    literature_id: parseLiteratureId(r.literature_id),
    asset_id: parseAssetId(r.asset_id),
    expected_proofread_id: parseAssetId(r.expected_proofread_id),
    expected_arrangement_id: archiveHash(r.expected_arrangement_id),
    expected_manual_revision: annotationInteger(r.expected_manual_revision),
    changes,
  };
}
export type ArrangedRole = ArchiveSectionRole;

export function parseArchiveUsageEstimateV2(
  value: unknown,
): ArchiveUsageEstimateV2 {
  const r = annotationRecord(value, [
    "schema_version",
    "kind",
    "available",
    "no_hard_limit",
    "count",
    "reused_count",
    "total_pdf_pages",
    "expected_proofread_pages",
    "page_basis",
    "components",
    "total",
    "estimate_method",
  ]);
  if (
    r.schema_version !== 2 ||
    r.kind !== "archive" ||
    typeof r.available !== "boolean" ||
    r.no_hard_limit !== true ||
    !["accepted-arrangement", "all-pdf-pages", "unknown"].includes(
      String(r.page_basis),
    )
  )
    throw new ContractValidationError();
  const range = (v: unknown): EstimateRange | null => {
    if (v === null) return null;
    const q = annotationRecord(v, ["median", "p90"]),
      median = annotationInteger(q.median),
      p90 = annotationInteger(q.p90, median);
    return { median, p90 };
  };
  const components = archiveList(
      r.components,
      (v): ArchiveEstimateComponent => {
        const q = annotationRecord(v, [
          "step",
          "unit",
          "units",
          "sample_count",
          "basis",
          "calls",
          "input_tokens",
          "output_tokens",
          "unknown_code",
          ...(v && typeof v === "object" && "kind" in v ? ["kind"] : []),
        ]);
        if (q.kind !== undefined && q.kind !== q.step)
          throw new ContractValidationError();
        if (
          !(ARCHIVE_STEPS as readonly unknown[]).includes(q.step) ||
          !["part", "page", "literature"].includes(String(q.unit)) ||
          !["matching-history", "deterministic", "unknown"].includes(
            String(q.basis),
          ) ||
          (q.unknown_code !== null &&
            ![
              "no-matching-history",
              "pages-unknown",
              "source-missing",
              "model-unavailable",
              "partial-reuse-unknown",
            ].includes(String(q.unknown_code)))
        )
          throw new ContractValidationError();
        return {
          ...(q.kind === undefined ? {} : { kind: q.step as ArchiveStep }),
          step: q.step as ArchiveStep,
          unit: q.unit as ArchiveEstimateComponent["unit"],
          units: q.units === null ? null : annotationInteger(q.units),
          sample_count: annotationInteger(q.sample_count),
          basis: q.basis as ArchiveEstimateComponent["basis"],
          calls: range(q.calls),
          input_tokens: range(q.input_tokens),
          output_tokens: range(q.output_tokens),
          unknown_code:
            q.unknown_code as ArchiveEstimateComponent["unknown_code"],
        };
      },
      6,
    ),
    t = annotationRecord(r.total, ["calls", "input_tokens", "output_tokens"]),
    count = annotationInteger(r.count),
    reused_count = annotationInteger(r.reused_count, 0, count);
  if (
    components.length !== 6 ||
    components.some((c, i) => c.step !== ARCHIVE_STEPS[i])
  )
    throw new ContractValidationError();
  return {
    schema_version: 2,
    kind: "archive",
    available: r.available,
    no_hard_limit: true,
    count,
    reused_count,
    total_pdf_pages:
      r.total_pdf_pages === null ? null : annotationInteger(r.total_pdf_pages),
    expected_proofread_pages:
      r.expected_proofread_pages === null
        ? null
        : annotationInteger(r.expected_proofread_pages),
    page_basis: r.page_basis as ArchiveUsageEstimateV2["page_basis"],
    components,
    total: {
      calls: range(t.calls),
      input_tokens: range(t.input_tokens),
      output_tokens: range(t.output_tokens),
    },
    estimate_method: archiveText(r.estimate_method, 128),
  };
}

export function archiveProofreadHash(
  value: Omit<ProofreadVersionV2, "proofread_id" | "content_sha256">,
) {
  const { usage, pages, ...body } = value;
  void usage;
  return sha256(
    canonicalJsonBytes({
      ...body,
      pages: pages.map((p) => {
        const { usage, ...record } = p;
        void usage;
        return record;
      }),
    }),
  );
}

export type ArchiveMetadataFragmentEvidence =
  | {
      readonly kind: "document-segment";
      readonly document_version_id: string;
      readonly segment_ids: readonly string[];
    }
  | {
      readonly kind: "arrangement-leaf";
      readonly proofread_id: string;
      readonly arrangement_id: string;
      readonly raw_parse_id: string;
      readonly leaf_id: string;
      readonly source: import("./archive-text.js").SourceSpan;
      readonly drop_reason: import("./archive-text.js").ArchiveDropReason;
    };

export function archivePageCursor(proofread_id: string, offset: number) {
  return JSON.stringify({ proofread_id, offset });
}

export function parseArrangementQueryV2(value: unknown): ArrangementQueryV2 {
  if (!value || typeof value !== "object" || !("kind" in value))
    throw new ContractValidationError();
  const kind = value.kind,
    base = ["schema_version", "asset_id", "proofread_id", "kind"],
    keys =
      kind === "summary"
        ? base
        : kind === "leaves"
          ? [
              ...base,
              "visibility",
              "drop_reason",
              "page_index",
              "cursor",
              "limit",
              "max_bytes",
            ]
          : [...base, "cursor", "limit", "max_bytes"];
  const r = annotationRecord(value, keys);
  if (
    r.schema_version !== 2 ||
    !["summary", "leaves", "breaks", "source-map", "pages"].includes(
      String(kind),
    )
  )
    throw new ContractValidationError();
  const common = {
    schema_version: 2 as const,
    asset_id: parseAssetId(r.asset_id),
    proofread_id: r.proofread_id === null ? null : parseAssetId(r.proofread_id),
  };
  if (kind === "summary") return { ...common, kind };
  if (
    r.cursor !== null &&
    (typeof r.cursor !== "string" || r.cursor.length > 4096)
  )
    throw new ContractValidationError();
  const page = {
    cursor: r.cursor as string | null,
    limit: annotationInteger(r.limit, 1, 200),
    max_bytes: annotationInteger(r.max_bytes, 1024, 65536),
  };
  if (kind === "leaves") {
    if (
      !["kept", "dropped", "all"].includes(String(r.visibility)) ||
      (r.drop_reason !== null &&
        !(ARCHIVE_DROP_REASONS as readonly unknown[]).includes(r.drop_reason))
    )
      throw new ContractValidationError();
    return {
      ...common,
      ...page,
      kind,
      visibility: r.visibility as "kept" | "dropped" | "all",
      drop_reason: r.drop_reason as string | null,
      page_index:
        r.page_index === null ? null : annotationInteger(r.page_index, 0, 9999),
    };
  }
  return {
    ...common,
    ...page,
    kind: kind as "breaks" | "source-map" | "pages",
  };
}
