import {
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseLiteratureMetadata,
  parseProvenance,
  sha256,
  type AssetId,
  type Provenance,
  type Sha256,
} from "./index.js";

export interface ArtifactRef {
  readonly sha256: Sha256;
  readonly media_type: string;
  readonly byte_size: number;
}
export type ParserArtifactRef = ArtifactRef;
export interface ParserResource {
  readonly reference: string;
  readonly artifact: ParserArtifactRef;
}
export interface ParserProvenance {
  readonly provenance: Provenance;
  readonly parser_version: string;
  readonly mode: string | null;
  readonly model_identity: string | null;
}
export interface ParserResult {
  readonly source_asset_id: AssetId;
  readonly source_sha256: Sha256;
  readonly page_count: number;
  readonly markdown: ParserArtifactRef;
  readonly resources: readonly ParserResource[];
  readonly result_sha256: Sha256;
  readonly provenance: ParserProvenance;
}
export type LiteratureSectionRole =
  | "background-and-objectives"
  | "methods"
  | "data"
  | "conclusions-and-limitations"
  | "additional";
export interface LiteratureSubsection {
  readonly title: string;
  readonly markdown: string;
}
export interface LiteratureSection {
  readonly role: LiteratureSectionRole;
  readonly title: string | null;
  readonly markdown: string;
  readonly subsections: readonly LiteratureSubsection[];
}
export interface LiteratureContent {
  readonly literature_content_sha256: Sha256;
  readonly metadata_revision: number;
  readonly metadata_sha256: Sha256;
  readonly sections: readonly LiteratureSection[];
  readonly references: readonly string[];
  readonly markdown: ArtifactRef;
  readonly provenance: Provenance;
}

function fail(): never {
  throw new ContractValidationError();
}
function compareUnicode(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function number(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    fail();
  return value;
}
function string(value: unknown): string {
  if (
    typeof value !== "string" ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    fail();
  return value;
}
function nonblank(value: unknown): string {
  const result = string(value).trim();
  if (!result) fail();
  return result;
}
function hash(value: unknown): Sha256 {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail();
  return value as Sha256;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}
/** Parser and content hashes preserve Unicode/code units in already normalized domain fields. */
export function contentCanonicalJsonBytes(value: unknown): Uint8Array {
  const encode = (v: unknown): string => {
    if (typeof v === "string") return JSON.stringify(string(v));
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isSafeInteger(v))
      return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v && typeof v === "object")
      return `{${Object.entries(v)
        .sort(([a], [b]) => compareUnicode(a, b))
        .map(([k, item]) => `${JSON.stringify(k)}:${encode(item)}`)
        .join(",")}}`;
    return fail();
  };
  return new TextEncoder().encode(encode(value));
}
export function parseArtifactRef(value: unknown): ArtifactRef {
  const r = exact(value, ["sha256", "media_type", "byte_size"]);
  return Object.freeze({
    sha256: hash(r.sha256),
    media_type: nonblank(r.media_type),
    byte_size: number(r.byte_size, 0),
  });
}
function markdownRef(value: unknown): ArtifactRef {
  const r = parseArtifactRef(value);
  if (r.media_type !== "text/markdown" || !r.byte_size) fail();
  return r;
}
function identity(value: unknown): string {
  const s = string(value);
  if (
    !s ||
    s !== s.trim() ||
    s.startsWith("~") ||
    /[\\?#]/u.test(s) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(s) ||
    [...s].some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || (n >= 127 && n <= 159);
    }) ||
    s.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail();
  return s;
}
function parseParserProvenance(value: unknown): ParserProvenance {
  const r = exact(value, [
    "provenance",
    "parser_version",
    "mode",
    "model_identity",
  ]);
  const provenance = parseProvenance(r.provenance);
  if (
    provenance.source_kind !== "parser" ||
    provenance.source_record_id !== null ||
    provenance.input_sha256 === null ||
    provenance.parameters_sha256 === null
  )
    fail();
  return Object.freeze({
    provenance,
    parser_version: identity(r.parser_version),
    mode: r.mode === null ? null : identity(r.mode),
    model_identity:
      r.model_identity === null ? null : identity(r.model_identity),
  });
}
export async function parserResultSha256(
  result: Omit<ParserResult, "result_sha256">,
): Promise<Sha256> {
  const p = result.provenance;
  return sha256(
    contentCanonicalJsonBytes({
      source_asset_id: result.source_asset_id,
      source_sha256: result.source_sha256,
      page_count: result.page_count,
      markdown: result.markdown,
      resources: [...result.resources].sort((a, b) =>
        compareUnicode(a.reference, b.reference),
      ),
      parser: {
        name: p.provenance.source_name,
        version: p.parser_version,
        mode: p.mode,
        model_identity: p.model_identity,
        parameters_sha256: p.provenance.parameters_sha256,
      },
    }),
  );
}
export async function parseParserResult(value: unknown): Promise<ParserResult> {
  const r = exact(value, [
    "source_asset_id",
    "source_sha256",
    "page_count",
    "markdown",
    "resources",
    "result_sha256",
    "provenance",
  ]);
  const source_asset_id = parseAssetId(r.source_asset_id);
  const source_sha256 = hash(r.source_sha256);
  const resources = array(r.resources)
    .map((value) => {
      const resource = exact(value, ["reference", "artifact"]);
      const reference = nonblank(resource.reference);
      if (
        /[\\?#]/u.test(reference) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) ||
        [...reference].some(
          (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127,
        ) ||
        reference.split("/").some((p) => !p || p === "." || p === "..")
      )
        fail();
      return Object.freeze({
        reference,
        artifact: parseArtifactRef(resource.artifact),
      });
    })
    .sort((a, b) => compareUnicode(a.reference, b.reference));
  if (new Set(resources.map((r) => r.reference)).size !== resources.length)
    fail();
  const result = Object.freeze({
    source_asset_id,
    source_sha256,
    page_count: number(r.page_count, 1),
    markdown: markdownRef(r.markdown),
    resources: Object.freeze(resources),
    result_sha256: hash(r.result_sha256),
    provenance: parseParserProvenance(r.provenance),
  });
  if (
    result.provenance.provenance.input_sha256 !== result.source_sha256 ||
    (await parserResultSha256(result)) !== result.result_sha256
  )
    fail();
  return result;
}
const fixedRoles = [
  "background-and-objectives",
  "methods",
  "data",
  "conclusions-and-limitations",
] as const;
const reservedTitles = [
  "元数据",
  "摘要",
  "参考文献",
  "研究背景与目标",
  "研究方法",
  "数据",
  "结论与局限性",
];
function parseSection(value: unknown): LiteratureSection {
  const r = exact(value, ["role", "title", "markdown", "subsections"]);
  if (
    typeof r.role !== "string" ||
    ![...fixedRoles, "additional"].includes(r.role)
  )
    fail();
  const title = r.title === null ? null : nonblank(r.title);
  const markdown = string(r.markdown);
  const subsections = Object.freeze(
    array(r.subsections).map((value) => {
      const s = exact(value, ["title", "markdown"]);
      const markdown = string(s.markdown);
      if (!markdown.trim()) fail();
      return Object.freeze({ title: nonblank(s.title), markdown });
    }),
  );
  if (markdown !== "未提供" && markdown.trim() === "未提供") fail();
  if (r.role === "additional") {
    if (
      title === null ||
      reservedTitles.includes(title) ||
      markdown === "未提供" ||
      (!markdown.trim() && !subsections.length)
    )
      fail();
  } else if (
    title !== null ||
    (markdown === "未提供"
      ? subsections.length
      : !markdown.trim() && !subsections.length)
  )
    fail();
  return Object.freeze({
    role: r.role as LiteratureSectionRole,
    title,
    markdown,
    subsections,
  });
}
export async function literatureContentSha256(
  value: Pick<LiteratureContent, "metadata_sha256" | "sections" | "references">,
): Promise<Sha256> {
  return sha256(
    contentCanonicalJsonBytes({
      metadata_sha256: value.metadata_sha256,
      sections: value.sections,
      references: value.references,
    }),
  );
}
export async function parseLiteratureContent(
  value: unknown,
): Promise<LiteratureContent> {
  const r = exact(value, [
    "literature_content_sha256",
    "metadata_revision",
    "metadata_sha256",
    "sections",
    "references",
    "markdown",
    "provenance",
  ]);
  const sections = Object.freeze(array(r.sections).map(parseSection));
  if (
    sections
      .filter((s) => s.role !== "additional")
      .map((s) => s.role)
      .join() !== fixedRoles.join()
  )
    fail();
  const references = Object.freeze(array(r.references).map(nonblank));
  if (references.includes("未提供")) fail();
  const provenance = parseProvenance(r.provenance);
  if (
    provenance.source_kind !== "analysis" ||
    provenance.source_record_id !== null ||
    provenance.input_sha256 === null ||
    provenance.parameters_sha256 === null
  )
    fail();
  const result = Object.freeze({
    literature_content_sha256: hash(r.literature_content_sha256),
    metadata_revision: number(r.metadata_revision, 1),
    metadata_sha256: hash(r.metadata_sha256),
    sections,
    references,
    markdown: markdownRef(r.markdown),
    provenance,
  });
  if (
    (await literatureContentSha256(result)) !== result.literature_content_sha256
  )
    fail();
  return result;
}

export interface AnalysisInputIdentity {
  readonly literature_id: ReturnType<typeof parseLiteratureId>;
  readonly primary_asset_id: AssetId;
  readonly primary_pdf_sha256: Sha256;
  readonly parser_result_sha256: Sha256;
  readonly input_metadata_revision: number;
  readonly input_metadata_sha256: Sha256;
}
export function parseAnalysisInputIdentity(
  value: unknown,
): AnalysisInputIdentity {
  const r = exact(value, [
    "literature_id",
    "primary_asset_id",
    "primary_pdf_sha256",
    "parser_result_sha256",
    "input_metadata_revision",
    "input_metadata_sha256",
  ]);
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    primary_asset_id: parseAssetId(r.primary_asset_id),
    primary_pdf_sha256: hash(r.primary_pdf_sha256),
    parser_result_sha256: hash(r.parser_result_sha256),
    input_metadata_revision: number(r.input_metadata_revision, 1),
    input_metadata_sha256: hash(r.input_metadata_sha256),
  });
}
export interface LiteratureContentProposal
  extends Omit<LiteratureContent, "metadata_revision">,
    AnalysisInputIdentity {
  readonly final_metadata: import("./index.js").LiteratureMetadata;
}
export async function analysisInputSha256(
  primaryPdf: Sha256,
  parserResult: Sha256,
  metadata: Sha256,
): Promise<Sha256> {
  return sha256(
    contentCanonicalJsonBytes({
      schema: "sciretriever-literature-content-input-v1",
      primary_pdf_sha256: primaryPdf,
      parser_result_sha256: parserResult,
      metadata_sha256: metadata,
    }),
  );
}
export async function parseLiteratureContentProposal(
  value: unknown,
): Promise<LiteratureContentProposal> {
  const r = exact(value, [
    "literature_id",
    "primary_asset_id",
    "primary_pdf_sha256",
    "parser_result_sha256",
    "input_metadata_revision",
    "input_metadata_sha256",
    "final_metadata",
    "metadata_sha256",
    "sections",
    "references",
    "literature_content_sha256",
    "markdown",
    "provenance",
  ]);
  const input_metadata_revision = number(r.input_metadata_revision, 1);
  const content = await parseLiteratureContent({
    literature_content_sha256: r.literature_content_sha256,
    metadata_revision: input_metadata_revision,
    metadata_sha256: r.metadata_sha256,
    sections: r.sections,
    references: r.references,
    markdown: r.markdown,
    provenance: r.provenance,
  });
  const body = {
    literature_content_sha256: content.literature_content_sha256,
    metadata_sha256: content.metadata_sha256,
    sections: content.sections,
    references: content.references,
    markdown: content.markdown,
    provenance: content.provenance,
  };
  const final_metadata = parseLiteratureMetadata(r.final_metadata);
  const primary_pdf_sha256 = hash(r.primary_pdf_sha256),
    parser_result_sha256 = hash(r.parser_result_sha256);
  if (
    (await sha256(contentCanonicalJsonBytes(final_metadata))) !==
      content.metadata_sha256 ||
    (await analysisInputSha256(
      primary_pdf_sha256,
      parser_result_sha256,
      content.metadata_sha256,
    )) !== content.provenance.input_sha256
  )
    fail();
  return Object.freeze({
    ...body,
    literature_id: parseLiteratureId(r.literature_id),
    primary_asset_id: parseAssetId(r.primary_asset_id),
    primary_pdf_sha256,
    parser_result_sha256,
    input_metadata_revision,
    input_metadata_sha256: hash(r.input_metadata_sha256),
    final_metadata,
  });
}
