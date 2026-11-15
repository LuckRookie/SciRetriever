import {
  ARCHIVE_SECTION_ROLES,
  parseArchiveTextBundleV2,
  parseDocumentStructureV2,
  canonicalJsonBytes,
  type ArchiveTextBundleV2,
  type DocumentStructureV2,
  type DocumentBasis,
  type ArchiveSectionRole,
  type RawParseResource,
  type ProofreadSegmentKind,
} from "@sciretriever/contracts";
import { arrangementPreview } from "./arrangement.js";
import { byteHash } from "./text-source.js";

const titles: Record<ArchiveSectionRole, string> = {
  title: "标题",
  authors: "作者",
  abstract: "摘要",
  keywords: "关键词",
  introduction: "引言",
  methods: "方法",
  "results-discussion": "结果与讨论",
  conclusion: "结论",
  "end-matter": "文末信息",
  references: "参考文献",
  additional: "附加章节",
};
export interface LeafSourceMap {
  readonly leaf_id: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly source: ArchiveTextBundleV2["leaves"][number]["leaf"]["source"];
  readonly correction_ids: readonly string[];
}
/** Only structural bytes and recorded corrections may differ from retained originals. */
export function renderLegacyArrangement(
  value: ArchiveTextBundleV2,
  available: readonly RawParseResource[],
) {
  const bundle = parseArchiveTextBundleV2(value),
    snapshot = bundle.arrangement;
  if (!snapshot) throw new Error("arrangement-required");
  const rows = new Map(bundle.leaves.map((l) => [l.leaf.leaf_id, l]));
  const nodes = arrangementPreview(snapshot);
  const roleOf = (id: string) => {
    const d = rows.get(id)!.destination;
    if (d.kind !== "assigned") throw new Error("render-dropped");
    return d.target.role;
  };
  const sections: DocumentStructureV2["sections"][number][] = [],
    segments: DocumentStructureV2<DocumentBasis>["segments"][number][] = [],
    source_map: LeafSourceMap[] = [],
    structural_ranges: {
      kind: string;
      start_utf8: number;
      end_utf8: number;
    }[] = [];
  let text = "",
    offset = 0;
  const append = (s: string) => {
    const start = offset;
    text += s;
    offset += Buffer.byteLength(s);
    return { start_utf8: start, end_utf8: offset };
  };
  const structure = (s: string, kind: string) => {
    if (s.length) structural_ranges.push({ kind, ...append(s) });
  };
  const resources = new Map<string, RawParseResource>();
  const emitted = new Set<string>();
  const flows: (typeof nodes)[number][][] = [];
  for (const node of nodes) {
    if (node.out_of_flow && flows.length) flows.at(-1)!.push(node);
    else flows.push([node]);
  }
  for (const role of ARCHIVE_SECTION_ROLES) {
    const selected = flows
      .filter((flow) => roleOf(flow[0]!.leaf_ids[0]!) === role)
      .flat();
    if (!selected.length) continue;
    const start = offset,
      section_id = `s-${role}`,
      first = rows.get(selected[0]!.leaf_ids[0]!)!,
      nativeHeading =
        first.destination.kind === "assigned" &&
        (role === "title" ||
          first.destination.presentation.kind === "section-heading"),
      sectionLevel = role === "title" ? 1 : 2;
    if (!nativeHeading) structure(`## ${titles[role]}\n\n`, "skeleton");
    type MutableSection = {
      -readonly [K in keyof DocumentStructureV2["sections"][number]]: DocumentStructureV2["sections"][number][K];
    };
    const children: MutableSection[] = [],
      stack: MutableSection[] = [];
    let activeSection = section_id;
    for (const node of selected) {
      for (const [index, id] of node.leaf_ids.entries()) {
        if (emitted.has(id)) throw new Error("render-duplicate-leaf");
        emitted.add(id);
        const row = rows.get(id)!,
          leaf = row.leaf,
          d = row.destination;
        if (d.kind !== "assigned") throw new Error("render-dropped");
        if (index) structure(node.joiners[index - 1]!, "merge-joiner");
        const segmentStart = offset;
        if (nativeHeading && id === first.leaf.leaf_id) {
          if (!/^\s*#{1,6}\s/u.test(row.corrected_text))
            structure(`${"#".repeat(sectionLevel)} `, "section-heading-marker");
        } else if (d.presentation.kind !== "content") {
          const level =
            d.presentation.kind === "subheading"
              ? Math.max(3, d.presentation.level)
              : 3;
          while (stack.length && stack.at(-1)!.level >= level)
            stack.pop()!.end_utf8 = segmentStart;
          const child = {
            section_id: `h-${id}`,
            title: row.corrected_text,
            level,
            start_utf8: segmentStart,
            end_utf8: 0,
            role: null,
            role_source: null,
          };
          children.push(child);
          stack.push(child);
          activeSection = child.section_id;
          if (!/^\s*#{1,6}\s/u.test(row.corrected_text))
            structure(`${"#".repeat(level)} `, "subheading-marker");
        }
        if (leaf.image_ref) {
          const resource = available.find(
            (r) => r.reference === leaf.image_ref,
          );
          if (!resource) throw new Error("render-resource-missing");
          resources.set(resource.reference, resource);
          structure(`![](${resource.reference})\n`, "resource-reference");
        }
        const mathWrapper =
          leaf.type === "equation" &&
          row.corrected_text.trim().length > 0 &&
          !/^\s*(?:\$\$|\\\[)/u.test(row.corrected_text);
        if (mathWrapper) structure("$$\n", "equation-delimiter");
        const range = append(row.corrected_text);
        source_map.push({
          leaf_id: id,
          ...range,
          source: leaf.source,
          correction_ids: row.correction_ids,
        });
        if (mathWrapper) structure("\n$$", "equation-delimiter");
        for (const r of available)
          if (row.corrected_text.includes(r.reference))
            resources.set(r.reference, r);
        if (offset === segmentStart) structure("\n", "empty-object");
        const kind: ProofreadSegmentKind =
          d.presentation.kind !== "content" || leaf.type === "title"
            ? "heading"
            : leaf.type === "reference"
              ? "reference-item"
              : [
                    "aside",
                    "header",
                    "footer",
                    "page-number",
                    "discarded",
                  ].includes(leaf.type)
                ? "text"
                : (leaf.type as ProofreadSegmentKind);
        segments.push({
          segment_id: id,
          block_id: id,
          kind,
          section_id: activeSection,
          start_utf8: segmentStart,
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
    for (const child of stack) child.end_utf8 = offset;
    sections.push({
      section_id,
      title: nativeHeading ? first.corrected_text : titles[role],
      level: sectionLevel,
      start_utf8: start,
      end_utf8: offset,
      role: null,
      role_source: null,
    });
    sections.push(...children);
  }
  if (
    emitted.size !==
      bundle.leaves.filter((l) => l.destination.kind === "assigned").length ||
    !offset
  )
    throw new Error("render-payload-missing");
  const markdown = Buffer.from(text),
    documentStructure = parseDocumentStructureV2(
      {
        schema_version: 2,
        text_encoding: "utf8",
        page_count: bundle.page_count,
        sections,
        segments,
      },
      markdown.length,
    );
  for (const range of source_map)
    if (
      markdown.subarray(range.start_utf8, range.end_utf8).toString("utf8") !==
      rows.get(range.leaf_id)!.corrected_text
    )
      throw new Error("render-text-difference");
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
