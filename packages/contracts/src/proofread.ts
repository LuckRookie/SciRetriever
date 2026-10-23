import {
  ContractValidationError,
  canonicalJsonBytes,
  parseArtifactRef,
  parseAssetId,
  parsePageRegion,
  parseRawResourceReference,
  sha256,
  RAW_BLOCK_TYPES,
  type ArtifactRef,
  type PageRegion,
  type RawBlockType,
  type RawParseResource,
  type Sha256,
} from "./index.js";

export type ProofreadSource = "parser" | "rule" | "agent" | "manual";
export type ProofreadBasis = "text-layer" | "image-only" | "manual";
export type ProofreadRawRef = readonly (readonly [number, number])[];
export interface ProofreadBlock {
  readonly block_id: string;
  readonly page: number;
  readonly region: PageRegion | null;
  readonly continuation_regions: readonly {
    readonly page: number;
    readonly region: PageRegion;
  }[];
  readonly locate: "region" | "page";
  readonly type: RawBlockType;
  readonly title_level: number | null;
  readonly text: string;
  readonly html: string | null;
  readonly image_ref: string | null;
  readonly text_source: ProofreadSource;
  readonly basis: ProofreadBasis;

  readonly raw_ref: ProofreadRawRef;
  readonly edit_refs: readonly string[];
}
export interface ProofreadBlocksV1 {
  readonly schema_version: 1;
  readonly page_count: number;
  readonly blocks: readonly ProofreadBlock[];
}
export type ProofreadPageKind = "text-layer" | "image-only" | "blank";
export interface ProofreadPage {
  readonly page: number;
  readonly kind: ProofreadPageKind;
  readonly checked: boolean;
  readonly no_body_reason: string | null;
  readonly pending_reason: string | null;
}
export type ProofreadSuspectKind =
  | "missing"
  | "extra"
  | "token-mismatch"
  | "page-misplaced";
export interface ProofreadDisposition {
  readonly status: "fixed" | "draft-correct" | "uncertain";
  readonly reason: string;
}
export interface ProofreadSuspect {
  readonly suspect_id: string;
  readonly page: number;
  readonly kind: ProofreadSuspectKind;
  readonly tokens: readonly string[];
  readonly block_ids: readonly string[];
  readonly text_offset: number;
  readonly disposition: ProofreadDisposition | null;
}
export type ProofreadEdit = (
  | {
      readonly kind: "replace";
      readonly block_id: string;
      readonly text: string;
    }
  | {
      readonly kind: "insert_after";
      readonly after_block_id: string | null;
      readonly block: Pick<
        ProofreadBlock,
        | "page"
        | "region"
        | "type"
        | "title_level"
        | "text"
        | "html"
        | "image_ref"
      >;
    }
  | {
      readonly kind: "delete";
      readonly block_id: string;
      readonly reason: string;
    }
  | {
      readonly kind: "move";
      readonly block_id: string;
      readonly page: number;
      readonly after_block_id: string | null;
    }
) & { readonly basis_page: number; readonly reason: string };
export interface ProofreadEditRecord {
  readonly edit_id: string;
  readonly edit: ProofreadEdit;
}
export interface ProofreadFailure {
  readonly page: number | null;
  readonly reason:
    | "input-missing"
    | "page-content-missing"
    | "correction-failed";
  readonly message: string;
}
export interface ProofreadVersionInput {
  readonly part_asset_id: string;
  readonly part_sha256: Sha256;
  readonly draft_input: {
    readonly profile: "pipeline" | "vlm-engine" | "vlm-engine-markdown-only";
    readonly raw_parse_id: string;
    readonly result_sha256: Sha256;
  };
  readonly method: {
    readonly clean: string;
    readonly page_classify: string;
    readonly suspects: string;
    readonly correction: string;
    readonly render: string;
    readonly model_config_sha256: Sha256 | null;
  };
  readonly manual_decision_ids: readonly string[];
  readonly status: "complete" | "incomplete" | "failed";
  readonly pages: readonly ProofreadPage[];
  readonly suspects: readonly ProofreadSuspect[];
  readonly edits: readonly ProofreadEditRecord[];
  readonly blocks: ArtifactRef;
  readonly markdown: ArtifactRef;
  readonly resources: readonly RawParseResource[];
  readonly stats: {
    readonly text_layer_pages: number;
    readonly image_only_pages: number;
    readonly blank_pages: number;
    readonly missing: number;
    readonly extra: number;
    readonly token_mismatch: number;
    readonly page_misplaced: number;
    readonly fixed: number;
    readonly draft_correct: number;
    readonly agent_deletions: number;
    readonly calls: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly elapsed_ms: number;
  };
  readonly failure: ProofreadFailure | null;
}
export interface ProofreadVersion extends ProofreadVersionInput {
  readonly proofread_id: string;
  readonly content_sha256: Sha256;
}
function fail(): never {
  throw new ContractValidationError();
}
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== [...keys].sort().join()
  )
    fail();
  return v as Record<string, unknown>;
}
function text(v: unknown, max = 4 * 1024 * 1024): string {
  if (typeof v !== "string" || v.length > max) fail();
  return v;
}
function reason(v: unknown): string {
  const s = text(v, 65536);
  if (!s.trim()) fail();
  return s;
}
function count(v: unknown, max = 1_000_000): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > max) fail();
  return Number(v);
}
function digest(v: unknown): Sha256 {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v)) fail();
  return v as Sha256;
}
function list(v: unknown, max = 100000): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail();
  return v;
}
function uniqueIds(v: unknown): string[] {
  const a = list(v).map(parseAssetId);
  if (new Set(a).size !== a.length) fail();
  return a;
}
export function parseProofreadRawRef(v: unknown): ProofreadRawRef {
  const a = list(v).map((p): readonly [number, number] => {
    const n = list(p, 2);
    if (n.length !== 2) fail();
    return [count(n[0], 9999), count(n[1])];
  });
  if (new Set(a.map((p) => p.join(":"))).size !== a.length) fail();
  return a;
}
function blockContent(
  v: Record<string, unknown>,
  pages: number,
  available: Set<string>,
) {
  const page = count(v.page, pages - 1),
    region = v.region === null ? null : parsePageRegion(v.region),
    type = v.type as RawBlockType;
  if (
    !RAW_BLOCK_TYPES.includes(type) ||
    ["header", "footer", "page-number", "discarded"].includes(type)
  )
    fail();
  const title_level = v.title_level === null ? null : count(v.title_level, 6);
  if ((type === "title") !== (title_level !== null) || title_level === 0)
    fail();
  const html = v.html === null ? null : text(v.html),
    image_ref =
      v.image_ref === null ? null : parseRawResourceReference(v.image_ref);
  if (
    (html !== null && type !== "table") ||
    (image_ref !== null && !available.has(image_ref))
  )
    fail();
  return {
    page,
    region,
    type,
    title_level,
    text: text(v.text),
    html,
    image_ref,
  };
}
export function parseProofreadEdit(
  v: unknown,
  pages: number,
  resources: readonly string[],
): ProofreadEdit {
  if (!v || typeof v !== "object" || !("kind" in v)) fail();
  const common = ["kind", "basis_page", "reason"],
    k = v.kind;
  const fields =
    k === "replace"
      ? ["block_id", "text"]
      : k === "insert_after"
        ? ["after_block_id", "block"]
        : k === "delete"
          ? ["block_id"]
          : k === "move"
            ? ["block_id", "page", "after_block_id"]
            : fail();
  const r = record(v, [...common, ...fields]),
    basis_page = count(r.basis_page, pages - 1),
    editReason = reason(r.reason);
  if (k === "replace")
    return {
      kind: k,
      basis_page,
      reason: editReason,
      block_id: parseAssetId(r.block_id),
      text: text(r.text),
    };
  if (k === "delete")
    return {
      kind: k,
      basis_page,
      reason: editReason,
      block_id: parseAssetId(r.block_id),
    };
  const after_block_id =
    r.after_block_id === null ? null : parseAssetId(r.after_block_id);
  if (k === "move")
    return {
      kind: k,
      basis_page,
      reason: editReason,
      block_id: parseAssetId(r.block_id),
      page: count(r.page, pages - 1),
      after_block_id,
    };
  return {
    kind: "insert_after",
    basis_page,
    reason: editReason,
    after_block_id,
    block: blockContent(
      record(r.block, [
        "page",
        "region",
        "type",
        "title_level",
        "text",
        "html",
        "image_ref",
      ]),
      pages,
      new Set(resources),
    ),
  };
}
export function parseProofreadDisposition(v: unknown): ProofreadDisposition {
  const r = record(v, ["status", "reason"]);
  if (!["fixed", "draft-correct", "uncertain"].includes(String(r.status)))
    fail();
  return {
    status: r.status as ProofreadDisposition["status"],
    reason: reason(r.reason),
  };
}
export function parseProofreadBlocksV1(
  v: unknown,
  resources: readonly string[],
): ProofreadBlocksV1 {
  const r = record(v, ["schema_version", "page_count", "blocks"]),
    pages = count(r.page_count, 10000);
  if (r.schema_version !== 1 || !pages) fail();
  const available = new Set(resources.map(parseRawResourceReference));
  if (available.size !== resources.length) fail();
  let previous = -1;
  const ids = new Set<string>();
  const blocks = list(r.blocks).map((v): ProofreadBlock => {
    const b = record(v, [
      "block_id",
      "page",
      "region",
      "continuation_regions",
      "locate",
      "type",
      "title_level",
      "text",
      "html",
      "image_ref",
      "text_source",
      "basis",

      "raw_ref",
      "edit_refs",
    ]);
    const block_id = parseAssetId(b.block_id),
      content = blockContent(b, pages, available);
    if (
      ids.has(block_id) ||
      content.page < previous ||
      b.locate !== (content.region ? "region" : "page")
    )
      fail();
    ids.add(block_id);
    previous = content.page;
    if (
      !["parser", "rule", "agent", "manual"].includes(String(b.text_source)) ||
      !["text-layer", "image-only", "manual"].includes(String(b.basis))
    )
      fail();
    if (b.text_source === "manual" && b.basis !== "manual") fail();
    const raw_ref = parseProofreadRawRef(b.raw_ref);
    if (raw_ref.some(([p]) => p >= pages)) fail();
    return {
      block_id,
      ...content,
      locate: content.region ? "region" : "page",
      continuation_regions: list(b.continuation_regions).map((v) => {
        const c = record(v, ["page", "region"]);
        return {
          page: count(c.page, pages - 1),
          region: parsePageRegion(c.region),
        };
      }),
      text_source: b.text_source as ProofreadSource,
      basis: b.basis as ProofreadBasis,

      raw_ref,
      edit_refs: uniqueIds(b.edit_refs),
    };
  });
  return { schema_version: 1, page_count: pages, blocks };
}
export function parseProofreadVersionInput(v: unknown): ProofreadVersionInput {
  const r = record(v, [
    "part_asset_id",
    "part_sha256",
    "draft_input",
    "method",
    "manual_decision_ids",
    "status",
    "pages",
    "suspects",
    "edits",
    "blocks",
    "markdown",
    "resources",
    "stats",
    "failure",
  ]);
  const d = record(r.draft_input, ["profile", "raw_parse_id", "result_sha256"]);
  if (
    !["pipeline", "vlm-engine", "vlm-engine-markdown-only"].includes(
      String(d.profile),
    )
  )
    fail();
  const m = record(r.method, [
    "clean",
    "page_classify",
    "suspects",
    "correction",
    "render",
    "model_config_sha256",
  ]);
  const pages = list(r.pages, 10000).map((v, i): ProofreadPage => {
    const p = record(v, [
      "page",
      "kind",
      "checked",
      "no_body_reason",
      "pending_reason",
    ]);
    if (
      p.page !== i ||
      !["text-layer", "image-only", "blank"].includes(String(p.kind)) ||
      typeof p.checked !== "boolean"
    )
      fail();
    if (p.checked && p.pending_reason !== null) fail();
    return {
      page: i,
      kind: p.kind as ProofreadPageKind,
      checked: p.checked,
      no_body_reason:
        p.no_body_reason === null ? null : reason(p.no_body_reason),
      pending_reason:
        p.pending_reason === null ? null : reason(p.pending_reason),
    };
  });
  if (!pages.length) fail();
  const suspects = list(r.suspects).map((v): ProofreadSuspect => {
    const s = record(v, [
      "suspect_id",
      "page",
      "kind",
      "tokens",
      "block_ids",
      "text_offset",
      "disposition",
    ]);
    if (
      !["missing", "extra", "token-mismatch", "page-misplaced"].includes(
        String(s.kind),
      )
    )
      fail();
    return {
      suspect_id: parseAssetId(s.suspect_id),
      page: count(s.page, pages.length - 1),
      kind: s.kind as ProofreadSuspectKind,
      tokens: list(s.tokens).map((t) => text(t, 65536)),
      block_ids: uniqueIds(s.block_ids),
      text_offset: count(s.text_offset, 32 * 1024 * 1024),
      disposition:
        s.disposition === null
          ? null
          : parseProofreadDisposition(s.disposition),
    };
  });
  if (new Set(suspects.map((s) => s.suspect_id)).size !== suspects.length)
    fail();
  const resources = list(r.resources, 4096)
    .map((v) => {
      const a = record(v, ["reference", "artifact"]),
        artifact = parseArtifactRef(a.artifact);
      if (!artifact.media_type.startsWith("image/") || artifact.byte_size < 1)
        fail();
      return { reference: parseRawResourceReference(a.reference), artifact };
    })
    .sort((a, b) => a.reference.localeCompare(b.reference, "en"));
  if (new Set(resources.map((r) => r.reference)).size !== resources.length)
    fail();
  const edits = list(r.edits).map((v) => {
    const e = record(v, ["edit_id", "edit"]);
    return {
      edit_id: parseAssetId(e.edit_id),
      edit: parseProofreadEdit(
        e.edit,
        pages.length,
        resources.map((r) => r.reference),
      ),
    };
  });
  if (new Set(edits.map((e) => e.edit_id)).size !== edits.length) fail();
  const keys = [
    "text_layer_pages",
    "image_only_pages",
    "blank_pages",
    "missing",
    "extra",
    "token_mismatch",
    "page_misplaced",
    "fixed",
    "draft_correct",
    "agent_deletions",
    "calls",
    "input_tokens",
    "output_tokens",
    "elapsed_ms",
  ] as const;
  const s = record(r.stats, keys),
    stats = Object.fromEntries(
      keys.map((k) => [k, count(s[k], Number.MAX_SAFE_INTEGER)]),
    ) as unknown as ProofreadVersionInput["stats"];
  const blocks = parseArtifactRef(r.blocks),
    markdown = parseArtifactRef(r.markdown);
  if (
    blocks.media_type !== "application/json" ||
    markdown.media_type !== "text/markdown" ||
    blocks.byte_size < 1
  )
    fail();
  const f =
    r.failure === null
      ? null
      : record(r.failure, ["page", "reason", "message"]);
  if (
    f &&
    !["input-missing", "page-content-missing", "correction-failed"].includes(
      String(f.reason),
    )
  )
    fail();
  const failure = f
    ? {
        page: f.page === null ? null : count(f.page, pages.length - 1),
        reason: f.reason as ProofreadFailure["reason"],
        message: reason(f.message),
      }
    : null;
  if (
    !["complete", "incomplete", "failed"].includes(String(r.status)) ||
    (r.status === "failed") !== (failure !== null)
  )
    fail();
  if (
    r.status === "complete" &&
    (pages.some((p) => !p.checked) || suspects.some((s) => !s.disposition))
  )
    fail();
  return {
    part_asset_id: parseAssetId(r.part_asset_id),
    part_sha256: digest(r.part_sha256),
    draft_input: {
      profile: d.profile as ProofreadVersionInput["draft_input"]["profile"],
      raw_parse_id: parseAssetId(d.raw_parse_id),
      result_sha256: digest(d.result_sha256),
    },
    method: {
      clean: reason(m.clean),
      page_classify: reason(m.page_classify),
      suspects: reason(m.suspects),
      correction: reason(m.correction),
      render: reason(m.render),
      model_config_sha256:
        m.model_config_sha256 === null ? null : digest(m.model_config_sha256),
    },
    manual_decision_ids: uniqueIds(r.manual_decision_ids),
    status: r.status as ProofreadVersionInput["status"],
    pages,
    suspects,
    edits,
    blocks,
    markdown,
    resources,
    stats,
    failure,
  };
}
export async function proofreadIdentity(value: ProofreadVersionInput) {
  const input = parseProofreadVersionInput(value);
  const content_sha256 = await sha256(
    canonicalJsonBytes({
      blocks: input.blocks,
      markdown: input.markdown,
      resources: input.resources,
    }),
  );
  const { elapsed_ms, calls, input_tokens, output_tokens, ...stats } =
    input.stats;
  void elapsed_ms;
  void calls;
  void input_tokens;
  void output_tokens;
  const hash = await sha256(
    canonicalJsonBytes({ ...input, stats, content_sha256 }),
  );
  return {
    proofread_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
    content_sha256,
  };
}
export async function parseProofreadVersion(
  v: unknown,
): Promise<ProofreadVersion> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  const { proofread_id, content_sha256, ...raw } = v as Record<string, unknown>;
  const input = parseProofreadVersionInput(raw),
    identity = await proofreadIdentity(input);
  if (
    proofread_id !== identity.proofread_id ||
    content_sha256 !== identity.content_sha256
  )
    fail();
  return { ...input, ...identity };
}
