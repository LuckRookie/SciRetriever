import {
  ContractValidationError,
  parseAssetId,
  parseIdentifier,
  canonicalJsonBytes,
  sha256,
} from "./index.js";
import {
  parseSectionRole,
  type SectionRole,
  type DocumentPartRole,
} from "./section-roles.js";
export type SectionRoleSource = "rule" | "model" | "fallback" | "manual";
export interface AssignedSection {
  readonly section_id: string;
  readonly role: SectionRole;
  readonly role_source: SectionRoleSource;
  readonly inherited_from: string | null;
  readonly locked: boolean;
  readonly failure_code: string | null;
}
export interface SegmentRole {
  readonly segment_id: string;
  readonly section_id: string | null;
  readonly role: SectionRole;
}
export interface StructureFigure {
  readonly object_segment_id: string;
  readonly caption_segment_id: string | null;
  readonly kind: "figure" | "table" | "scheme";
  readonly label: string | null;
  /** Zero based in immutable storage; readers return page + 1. */ readonly page: number;
}
export interface StructureReference {
  readonly reference_index: number;
  readonly text: string;
  readonly segment_ids: readonly string[];
  readonly doi: string | null;
}
export interface StructureAnnotation {
  readonly schema_version: 1;
  readonly annotation_id: string;
  readonly document_version_id: string;
  readonly part: DocumentPartRole;
  readonly method: {
    readonly mode: "automatic" | "manual";
    readonly base_annotation_id: string | null;
    readonly rules_version: string;
    readonly extraction_version: string;
    readonly model_method_version: string;
    readonly max_prefix_characters: number;
    readonly model: {
      readonly provider: string;
      readonly model: string;
      readonly reasoning: string;
      readonly stream: boolean;
      readonly configuration_sha256: string;
    } | null;
  };
  readonly manual_revision: number;
  readonly sections: readonly AssignedSection[];
  readonly segment_roles: readonly SegmentRole[];
  readonly figures: readonly StructureFigure[];
  readonly references: readonly StructureReference[];
}
export function annotationRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new ContractValidationError();
  return value as Record<string, unknown>;
}
export function annotationInteger(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new ContractValidationError();
  return Number(value);
}
function text(value: unknown, max = 65536): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.includes("\0")
  )
    throw new ContractValidationError();
  return value;
}
export function annotationToken(value: unknown): string {
  const v = text(value, 128);
  if (!/^[a-z0-9][a-z0-9._:/-]*$/u.test(v)) throw new ContractValidationError();
  return v;
}
function list<T>(
  value: unknown,
  parse: (v: unknown, i: number) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > 100000)
    throw new ContractValidationError();
  return value.map(parse);
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length)
    throw new ContractValidationError();
}
export function parseStructureAnnotation(value: unknown): StructureAnnotation {
  const r = annotationRecord(value, [
    "schema_version",
    "annotation_id",
    "document_version_id",
    "part",
    "method",
    "manual_revision",
    "sections",
    "segment_roles",
    "figures",
    "references",
  ]);
  if (
    r.schema_version !== 1 ||
    !["main", "supplementary"].includes(String(r.part)) ||
    typeof r.annotation_id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(r.annotation_id)
  )
    throw new ContractValidationError();
  const part = r.part as DocumentPartRole;
  const m = annotationRecord(r.method, [
    "mode",
    "base_annotation_id",
    "rules_version",
    "extraction_version",
    "model_method_version",
    "max_prefix_characters",
    "model",
  ]);
  if (
    (m.mode !== "automatic" && m.mode !== "manual") ||
    (m.mode === "automatic"
      ? m.base_annotation_id !== null
      : typeof m.base_annotation_id !== "string" ||
        !/^[a-f0-9]{64}$/u.test(m.base_annotation_id))
  )
    throw new ContractValidationError();
  const model =
    m.model === null
      ? null
      : annotationRecord(m.model, [
          "provider",
          "model",
          "reasoning",
          "stream",
          "configuration_sha256",
        ]);
  if (
    model &&
    (typeof model.stream !== "boolean" ||
      typeof model.configuration_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(model.configuration_sha256))
  )
    throw new ContractValidationError();
  const sections = list(r.sections, (v) => {
    const s = annotationRecord(v, [
      "section_id",
      "role",
      "role_source",
      "inherited_from",
      "locked",
      "failure_code",
    ]);
    if (
      !["rule", "model", "fallback", "manual"].includes(
        String(s.role_source),
      ) ||
      typeof s.locked !== "boolean" ||
      (s.locked && (s.role_source !== "manual" || s.inherited_from !== null))
    )
      throw new ContractValidationError();
    return {
      section_id: annotationToken(s.section_id),
      role: parseSectionRole(s.role, part),
      role_source: s.role_source as SectionRoleSource,
      inherited_from:
        s.inherited_from === null ? null : annotationToken(s.inherited_from),
      locked: s.locked,
      failure_code:
        s.failure_code === null ? null : annotationToken(s.failure_code),
    };
  });
  unique(sections.map((s) => s.section_id));
  const sectionIds = new Set(sections.map((s) => s.section_id));
  for (const s of sections)
    if (s.inherited_from && !sectionIds.has(s.inherited_from))
      throw new ContractValidationError();
  const segment_roles = list(r.segment_roles, (v) => {
    const s = annotationRecord(v, ["segment_id", "section_id", "role"]);
    const section =
      s.section_id === null ? null : annotationToken(s.section_id);
    if (section !== null && !sectionIds.has(section))
      throw new ContractValidationError();
    return {
      segment_id: annotationToken(s.segment_id),
      section_id: section,
      role: parseSectionRole(s.role, part),
    };
  });
  unique(segment_roles.map((s) => s.segment_id));
  const segments = new Set(segment_roles.map((s) => s.segment_id));
  const segment = (v: unknown) => {
    const id = annotationToken(v);
    if (!segments.has(id)) throw new ContractValidationError();
    return id;
  };
  const figures = list(r.figures, (v) => {
    const f = annotationRecord(v, [
      "object_segment_id",
      "caption_segment_id",
      "kind",
      "label",
      "page",
    ]);
    if (!["figure", "table", "scheme"].includes(String(f.kind)))
      throw new ContractValidationError();
    return {
      object_segment_id: segment(f.object_segment_id),
      caption_segment_id:
        f.caption_segment_id === null ? null : segment(f.caption_segment_id),
      kind: f.kind as StructureFigure["kind"],
      label: f.label === null ? null : text(f.label, 256),
      page: annotationInteger(f.page, 0, 9999),
    };
  });
  unique(figures.map((f) => f.object_segment_id));
  const references = list(r.references, (v, i) => {
    const f = annotationRecord(v, [
      "reference_index",
      "text",
      "segment_ids",
      "doi",
    ]);
    if (f.reference_index !== i) throw new ContractValidationError();
    const ids = list(f.segment_ids, segment);
    unique(ids);
    if (!ids.length) throw new ContractValidationError();
    return {
      reference_index: i,
      text: text(f.text, 8 * 1024 * 1024),
      segment_ids: ids,
      doi:
        f.doi === null
          ? null
          : parseIdentifier({ namespace: "doi", value: f.doi }).value,
    };
  });
  return {
    schema_version: 1,
    annotation_id: r.annotation_id,
    document_version_id: parseAssetId(r.document_version_id),
    part,
    method: {
      mode: m.mode,
      base_annotation_id: m.base_annotation_id as string | null,
      rules_version: annotationToken(m.rules_version),
      extraction_version: annotationToken(m.extraction_version),
      model_method_version: annotationToken(m.model_method_version),
      max_prefix_characters: annotationInteger(
        m.max_prefix_characters,
        0,
        65536,
      ),
      model: model
        ? {
            provider: text(model.provider, 256),
            model: text(model.model, 256),
            reasoning: text(model.reasoning, 64),
            stream: model.stream as boolean,
            configuration_sha256: model.configuration_sha256 as string,
          }
        : null,
    },
    manual_revision: annotationInteger(r.manual_revision),
    sections,
    segment_roles,
    figures,
    references,
  };
}
export function structureAnnotationHash(
  value: Omit<StructureAnnotation, "annotation_id">,
): Promise<string> {
  return sha256(canonicalJsonBytes(value));
}
export async function verifyStructureAnnotation(
  value: unknown,
): Promise<StructureAnnotation> {
  const parsed = parseStructureAnnotation(value);
  const { annotation_id, ...body } = parsed;
  if ((await structureAnnotationHash(body)) !== annotation_id)
    throw new ContractValidationError();
  return parsed;
}
