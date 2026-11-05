import { longDocumentInfo } from "@sciretriever/contracts";
import {
  parseArchiveTextBundleV2,
  parseDocumentStructureV2,
  canonicalJsonBytes,
  type ArchiveTextBundleV2,
  type DocumentStructureV2,
  type ArrangementStructureAnnotationV2,
  type RawParseResource,
  type ProofreadSegmentKind,
  type DocumentLayout,
} from "@sciretriever/contracts";
import { BODY_ROLES } from "./arrangement.js";
import { byteHash, textHash } from "./text-source.js";
import { structureReferences } from "../document/structure-extract.js";
import { arrangeSourceLayout, headingLevels } from "./source-layout.js";
import { renderLegacyArrangement } from "./render-legacy.js";
export const ARRANGED_DOCUMENT_BUILDER = "source-order-leaves-v3";
export const LEGACY_ARRANGED_DOCUMENT_BUILDER = "arranged-leaves-v2";
export const isArrangedBuilder = (value: string) =>
  value === ARRANGED_DOCUMENT_BUILDER ||
  value === LEGACY_ARRANGED_DOCUMENT_BUILDER;
export interface LeafSourceMap {
  readonly leaf_id: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly source: ArchiveTextBundleV2["leaves"][number]["leaf"]["source"];
  readonly correction_ids: readonly string[];
}
/** New source-order layout; historical builders are reproduced byte for byte. */
export function renderArrangement(
  value: ArchiveTextBundleV2,
  available: readonly RawParseResource[],
  builder: string = ARRANGED_DOCUMENT_BUILDER,
) {
  if (builder === LEGACY_ARRANGED_DOCUMENT_BUILDER)
    return renderLegacyArrangement(value, available);
  if (builder !== ARRANGED_DOCUMENT_BUILDER)
    throw Error("render-builder-unsupported");
  const bundle = parseArchiveTextBundleV2(value);
  if (!bundle.arrangement) throw Error("arrangement-required");
  const rows = new Map(bundle.leaves.map((r) => [r.leaf.leaf_id, r])),
    planned = arrangeSourceLayout(bundle),
    levels = headingLevels(bundle);
  type Section = {
    -readonly [K in keyof DocumentStructureV2["sections"][number]]: DocumentStructureV2["sections"][number][K];
  };
  const sections: Section[] = [],
    stack: Section[] = [],
    segments: DocumentStructureV2["segments"][number][] = [],
    source_map: LeafSourceMap[] = [],
    structural_ranges: {
      kind: string;
      start_utf8: number;
      end_utf8: number;
    }[] = [];
  const emitted = new Set<string>(),
    resources = new Map<string, RawParseResource>();
  let text = "",
    offset = 0,
    activeRole: string | null = null,
    infoRun = false;
  const append = (s: string) => {
    const start = offset;
    text += s;
    offset += Buffer.byteLength(s);
    return { start_utf8: start, end_utf8: offset };
  };
  const structure = (s: string, kind: string) => {
    if (s) structural_ranges.push({ kind, ...append(s) });
  };
  const begin = (id: string, title: string | null, level: number) => {
    while (stack.length && stack.at(-1)!.level >= level)
      stack.pop()!.end_utf8 = offset;
    const section: Section = {
      section_id: id,
      title,
      level,
      start_utf8: offset,
      end_utf8: 0,
      role: null,
      role_source: null,
    };
    sections.push(section);
    stack.push(section);
  };
  for (const node of planned.nodes) {
    const first = rows.get(node.leaf_ids[0]!)!,
      d = first.destination;
    if (d.kind !== "assigned") throw Error("render-dropped");
    const info = planned.article_info.has(first.leaf.leaf_id),
      heading = levels.has(first.leaf.leaf_id) && !info,
      float = ["footnote", "image", "table", "caption", "equation"].includes(
        first.leaf.type,
      );
    const newRole = activeRole !== d.target.role && !node.out_of_flow && !float;
    if (heading) {
      begin(
        `h-${first.leaf.leaf_id}`,
        first.corrected_text,
        levels.get(first.leaf.leaf_id)!,
      );
      activeRole = d.target.role;
    } else if (!stack.length || info !== infoRun || newRole) {
      begin(`s-${first.leaf.leaf_id}`, null, 2);
      activeRole = d.target.role;
    }
    infoRun = info;
    for (const [i, id] of node.leaf_ids.entries()) {
      if (emitted.has(id)) throw Error("render-duplicate-leaf");
      emitted.add(id);
      const row = rows.get(id)!,
        leaf = row.leaf;
      if (i) structure(node.joiners[i - 1]!, "merge-joiner");
      const start = offset;
      if (i === 0 && heading && !/^\s*#{1,6}\s/u.test(row.corrected_text))
        structure(`${"#".repeat(levels.get(id)!)} `, "heading-marker");
      if (leaf.image_ref) {
        const r = available.find((r) => r.reference === leaf.image_ref);
        if (!r) throw Error("render-resource-missing");
        resources.set(r.reference, r);
        structure(`![](${r.reference})\n`, "resource-reference");
      }
      const math =
        leaf.type === "equation" &&
        !!row.corrected_text.trim() &&
        !/^\s*(?:\$\$|\\\[)/u.test(row.corrected_text);
      if (math) structure("$$\n", "equation-delimiter");
      source_map.push({
        leaf_id: id,
        ...append(row.corrected_text),
        source: leaf.source,
        correction_ids: row.correction_ids,
      });
      if (math) structure("\n$$", "equation-delimiter");
      for (const r of available)
        if (row.corrected_text.includes(r.reference))
          resources.set(r.reference, r);
      if (offset === start) structure("\n", "empty-object");
      const kind: ProofreadSegmentKind =
        i === 0 && heading
          ? "heading"
          : leaf.type === "reference"
            ? "reference-item"
            : [
                  "aside",
                  "header",
                  "footer",
                  "page-number",
                  "discarded",
                  "title",
                ].includes(leaf.type)
              ? "text"
              : (leaf.type as ProofreadSegmentKind);
      segments.push({
        segment_id: id,
        block_id: id,
        kind,
        section_id: stack.at(-1)!.section_id,
        start_utf8: start,
        end_utf8: offset,
        page: leaf.page_index,
        region: leaf.region,
        continuation_regions: [],
        locate: leaf.region ? "region" : "page",
        source: row.text_source,
        basis: row.basis,
      });
    }
    structure("\n\n", "paragraph-separator");
  }
  for (const s of stack) s.end_utf8 = offset;
  if (
    !offset ||
    emitted.size !==
      bundle.leaves.filter((r) => r.destination.kind === "assigned").length
  )
    throw Error("render-payload-missing");
  const bySegment = new Map(segments.map((s) => [s.segment_id, s]));
  const range = (id: string) => {
    const s = bySegment.get(id)!;
    return { segment_id: id, start_utf8: s.start_utf8, end_utf8: s.end_utf8 };
  };
  const layout: DocumentLayout = {
    schema_version: 1,
    article_info: segments
      .filter((s) => planned.article_info.has(s.segment_id))
      .map((s) => ({ start_utf8: s.start_utf8, end_utf8: s.end_utf8 })),
    figure_groups: planned.groups.map((g) => ({
      group_id: `g-${g.objects[0]}`,
      kind: g.kind,
      objects: g.objects.map((id) => ({
        ...range(id),
        ...g.positions.get(id)!,
      })),
      captions: g.captions.map(range),
      rows: g.rows,
    })),
    footnotes: segments
      .filter((s) => s.kind === "footnote")
      .map((s) => ({ ...range(s.segment_id), page_index: s.page })),
  };
  const markdown = Buffer.from(text),
    documentStructure = parseDocumentStructureV2(
      {
        schema_version: 2,
        text_encoding: "utf8",
        page_count: bundle.page_count,
        ...(longDocumentInfo(bundle.arrangement.classification)
          ? {
              long_document: longDocumentInfo(
                bundle.arrangement.classification,
              ),
            }
          : {}),
        sections,
        segments,
        layout,
      },
      markdown.length,
    );
  for (const r of source_map)
    if (
      markdown.subarray(r.start_utf8, r.end_utf8).toString("utf8") !==
      rows.get(r.leaf_id)!.corrected_text
    )
      throw Error("render-text-difference");
  const bytes = canonicalJsonBytes(documentStructure);
  return {
    markdown,
    structure: documentStructure,
    bytes,
    sha256: byteHash(bytes),
    source_map,
    structural_ranges,
    resources: [...resources.values()],
  };
}
export function arrangementAnnotation(
  document: string,
  part: "main" | "supplementary",
  bundle: ArchiveTextBundleV2,
  rendered: ReturnType<typeof renderArrangement>,
): ArrangementStructureAnnotationV2 {
  const snapshot = bundle.arrangement!;
  const destination = new Map(snapshot.destinations.map((d) => [d.leaf_id, d]));
  const sections = rendered.structure.sections.map((s) => {
    const source_leaf_ids = rendered.structure.segments
        .filter((g) => g.start_utf8 >= s.start_utf8 && g.end_utf8 <= s.end_utf8)
        .map((g) => g.segment_id),
      first = destination.get(source_leaf_ids[0]!)!,
      d = first.destination;
    if (d.kind !== "assigned") throw new Error("render-role");
    const locked = source_leaf_ids.some((id) => destination.get(id)!.locked);
    return {
      section_id: s.section_id,
      role: d.target.role,
      role_source: locked ? ("manual" as const) : ("arrangement" as const),
      source_leaf_ids,
      locked,
    };
  });
  const segment_roles = rendered.structure.segments.map((s) => {
    const d = destination.get(s.segment_id)!.destination;
    if (d.kind !== "assigned") throw new Error("render-role");
    return {
      segment_id: s.segment_id,
      section_id: s.section_id!,
      role: d.target.role,
    };
  });
  const figures = bundle.leaves
    .filter(
      (l) =>
        l.destination.kind === "assigned" &&
        ["image", "table"].includes(l.leaf.type),
    )
    .map((l) => {
      const o = snapshot.operations.find(
        (o) => o.kind === "caption" && o.object_leaf_id === l.leaf.leaf_id,
      );
      return {
        object_segment_id: l.leaf.leaf_id,
        caption_segment_id:
          o?.kind === "caption" ? (o.caption_leaf_ids[0] ?? null) : null,
        caption_segment_ids: o?.kind === "caption" ? o.caption_leaf_ids : [],
        kind:
          o?.kind === "caption"
            ? o.object_kind
            : l.leaf.type === "table"
              ? ("table" as const)
              : ("figure" as const),
        label: null,
        page: l.leaf.page_index,
      };
    });
  const body_content_leaf_ids = bundle.leaves
    .filter(
      (l) =>
        l.destination.kind === "assigned" &&
        BODY_ROLES.has(l.destination.target.role) &&
        l.destination.presentation.kind === "content" &&
        l.corrected_text.trim().length > 0,
    )
    .map((l) => l.leaf.leaf_id);
  const body = {
    body_content_leaf_ids,
    schema_version: 2 as const,
    document_version_id: document,
    part,
    arrangement_id: snapshot.arrangement_id,
    method: {
      generator: "arrangement-v1" as const,
      method_sha256: textHash({
        generator: "arrangement-v1",
        arrangement: snapshot.arrangement_id,
      }),
    },
    manual_revision: 0,
    sections,
    segment_roles,
    figures,
    references: structureReferences(
      rendered.structure,
      rendered.markdown,
      segment_roles,
    ),
  };
  return { ...body, annotation_id: textHash(body) };
}
export function arrangedStructureSatisfied(
  a: ArrangementStructureAnnotationV2,
  bundle: ArchiveTextBundleV2,
) {
  return (
    a.part === "main" &&
    bundle.leaves.some(
      (l) =>
        l.destination.kind === "assigned" &&
        BODY_ROLES.has(l.destination.target.role) &&
        l.destination.presentation.kind === "content" &&
        l.corrected_text.trim().length > 0,
    )
  );
}
