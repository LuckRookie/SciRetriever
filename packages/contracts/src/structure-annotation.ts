import {
  ContractValidationError,
  parseAssetId,
  parseIdentifier,
  canonicalJsonBytes,
  sha256,
  ARCHIVE_SECTION_ROLES,
  type ArchiveSectionRole,
} from "./index.js";
import {
  parseSectionRole,
  type SectionRole,
  type DocumentPartRole,
} from "./section-roles.js";
export type SectionRoleSource =
  | "rule"
  | "model"
  | "fallback"
  | "manual"
  | "arrangement";
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
export interface StructureAnnotationV1 {
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
export function parseStructureAnnotationV1(
  value: unknown,
): StructureAnnotationV1 {
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
  value:
    | Omit<StructureAnnotationV1, "annotation_id">
    | Omit<ArrangementStructureAnnotationV2, "annotation_id">,
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

export interface ArrangementStructureAnnotationV2 {
  readonly body_content_leaf_ids: readonly string[];
  readonly schema_version: 2;
  readonly annotation_id: string;
  readonly document_version_id: string;
  readonly part: DocumentPartRole;
  readonly arrangement_id: string;
  readonly method: {
    readonly generator: "arrangement-v1";
    readonly method_sha256: string;
  };
  readonly manual_revision: number;
  readonly sections: readonly {
    readonly section_id: string;
    readonly role: ArchiveSectionRole;
    readonly role_source: "arrangement" | "manual";
    readonly source_leaf_ids: readonly string[];
    readonly locked: boolean;
  }[];
  readonly segment_roles: readonly {
    readonly segment_id: string;
    readonly section_id: string;
    readonly role: ArchiveSectionRole;
  }[];
  readonly figures: readonly (StructureFigure & {
    readonly caption_segment_ids: readonly string[];
  })[];
  readonly references: readonly StructureReference[];
}
export type StructureAnnotation =
  | StructureAnnotationV1
  | ArrangementStructureAnnotationV2;
export function parseStructureAnnotation(value: unknown): StructureAnnotation {
  if (
    value &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version === 1
  )
    return parseStructureAnnotationV1(value);
  const r = annotationRecord(value, [
    "schema_version",
    "annotation_id",
    "document_version_id",
    "part",
    "arrangement_id",
    "method",
    "manual_revision",
    "sections",
    "segment_roles",
    "figures",
    "references",
    "body_content_leaf_ids",
  ]);
  const m = annotationRecord(r.method, ["generator", "method_sha256"]);
  const hash = (v: unknown) => {
    if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v))
      throw new ContractValidationError();
    return v;
  };
  const role = (v: unknown): ArchiveSectionRole => {
    if (
      typeof v !== "string" ||
      !(ARCHIVE_SECTION_ROLES as readonly string[]).includes(v)
    )
      throw new ContractValidationError();
    return v as ArchiveSectionRole;
  };
  if (
    r.schema_version !== 2 ||
    m.generator !== "arrangement-v1" ||
    !["main", "supplementary"].includes(String(r.part))
  )
    throw new ContractValidationError();
  const sections = list(r.sections, (v) => {
    const q = annotationRecord(v, [
      "section_id",
      "role",
      "role_source",
      "source_leaf_ids",
      "locked",
    ]);
    if (
      !["arrangement", "manual"].includes(String(q.role_source)) ||
      typeof q.locked !== "boolean" ||
      q.locked !== (q.role_source === "manual")
    )
      throw new ContractValidationError();
    return {
      section_id: annotationToken(q.section_id),
      role: role(q.role),
      role_source: q.role_source as "arrangement" | "manual",
      source_leaf_ids: list(q.source_leaf_ids, parseAssetId),
      locked: q.locked,
    };
  });
  const sectionIds = new Set(sections.map((s) => s.section_id));
  if (sectionIds.size !== sections.length) throw new ContractValidationError();
  const segment_roles = list(r.segment_roles, (v) => {
    const q = annotationRecord(v, ["segment_id", "section_id", "role"]);
    const section_id = annotationToken(q.section_id);
    if (!sectionIds.has(section_id)) throw new ContractValidationError();
    return {
      segment_id: annotationToken(q.segment_id),
      section_id,
      role: role(q.role),
    };
  });
  const segIds = new Set(segment_roles.map((s) => s.segment_id));
  if (segIds.size !== segment_roles.length) throw new ContractValidationError();
  const seg = (v: unknown) => {
    const id = annotationToken(v);
    if (!segIds.has(id)) throw new ContractValidationError();
    return id;
  };
  const figures = list(r.figures, (v) => {
    const q = annotationRecord(v, [
      "object_segment_id",
      "caption_segment_id",
      "caption_segment_ids",
      "kind",
      "label",
      "page",
    ]);
    if (!["figure", "table", "scheme"].includes(String(q.kind)))
      throw new ContractValidationError();
    return {
      object_segment_id: seg(q.object_segment_id),
      caption_segment_id:
        q.caption_segment_id === null ? null : seg(q.caption_segment_id),
      caption_segment_ids: list(q.caption_segment_ids, seg),
      kind: q.kind as StructureFigure["kind"],
      label: q.label === null ? null : text(q.label, 256),
      page: annotationInteger(q.page, 0, 9999),
    };
  });
  const references = list(r.references, (v, i) => {
    const q = annotationRecord(v, [
      "reference_index",
      "text",
      "segment_ids",
      "doi",
    ]);
    if (q.reference_index !== i) throw new ContractValidationError();
    return {
      reference_index: i,
      text: text(q.text, 8 * 1024 * 1024),
      segment_ids: list(q.segment_ids, seg),
      doi:
        q.doi === null
          ? null
          : parseIdentifier({ namespace: "doi", value: q.doi }).value,
    };
  });
  const body_content_leaf_ids = list(r.body_content_leaf_ids, seg);
  unique(body_content_leaf_ids);
  if (
    body_content_leaf_ids.some(
      (id) =>
        !segment_roles.some(
          (s) =>
            s.segment_id === id &&
            [
              "introduction",
              "methods",
              "results-discussion",
              "conclusion",
              "additional",
            ].includes(s.role),
        ),
    )
  )
    throw new ContractValidationError();
  return {
    body_content_leaf_ids,
    schema_version: 2,
    annotation_id: hash(r.annotation_id),
    document_version_id: parseAssetId(r.document_version_id),
    part: r.part as DocumentPartRole,
    arrangement_id: hash(r.arrangement_id),
    method: {
      generator: "arrangement-v1",
      method_sha256: hash(m.method_sha256),
    },
    manual_revision: annotationInteger(r.manual_revision),
    sections,
    segment_roles,
    figures,
    references,
  };
}
