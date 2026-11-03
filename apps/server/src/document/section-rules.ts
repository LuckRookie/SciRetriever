import {
  parseSectionRole,
  type SectionRole,
  type DocumentPartRole,
  type DocumentStructureV2,
} from "@sciretriever/contracts";
export const SECTION_RULES_VERSION = "roles-rules-v1";
export type { AssignedSection } from "@sciretriever/contracts";
import type {
  AssignedSection,
  SectionRoleSource as RoleSource,
} from "@sciretriever/contracts";
export interface RoleModelInput {
  readonly title: string;
  readonly prefix: string;
  readonly previous_role: SectionRole | null;
  readonly next_role: SectionRole | null;
  readonly part: DocumentPartRole;
}
const main: readonly [SectionRole, readonly string[]][] = [
  [
    "front-matter",
    ["front matter", "article information", "author information"],
  ],
  ["abstract", ["abstract", "摘要", "内容摘要"]],
  ["keywords", ["keywords", "key words", "关键词", "关键字"]],
  ["introduction", ["introduction", "background", "引言", "绪论", "前言"]],
  [
    "methods",
    [
      "methods",
      "materials and methods",
      "experimental",
      "experimental section",
      "experimental methods",
      "methodology",
      "computational details",
      "theoretical methods",
      "实验",
      "实验部分",
      "材料与方法",
      "研究方法",
      "计算方法",
    ],
  ],
  [
    "results-discussion",
    [
      "results and discussion",
      "results & discussion",
      "results and discussions",
      "结果与讨论",
      "结果和讨论",
    ],
  ],
  ["results", ["results", "结果", "研究结果"]],
  ["discussion", ["discussion", "讨论"]],
  [
    "conclusion",
    ["conclusion", "conclusions", "concluding remarks", "结论", "总结"],
  ],
  [
    "acknowledgements",
    ["acknowledgments", "acknowledgements", "acknowledgment", "致谢"],
  ],
  [
    "references",
    ["references", "bibliography", "literature cited", "参考文献"],
  ],
  [
    "appendix",
    [
      "appendix",
      "appendices",
      "supporting information",
      "supplementary information",
      "附录",
      "补充材料",
    ],
  ],
];
const supplementary: readonly [SectionRole, readonly string[]][] = [
  [
    "si-methods",
    [
      "experimental",
      "experimental section",
      "experimental details",
      "general methods",
      "general experimental procedures",
      "materials and methods",
      "supplementary methods",
      "实验部分",
      "实验细节",
      "补充实验",
    ],
  ],
  [
    "si-characterization",
    [
      "characterization",
      "characterisation",
      "spectra",
      "nmr spectra",
      "spectroscopic data",
      "compound characterization",
      "表征",
      "表征数据",
      "谱图",
    ],
  ],
  [
    "si-computation",
    [
      "computational details",
      "computational methods",
      "calculations",
      "计算细节",
      "计算方法",
    ],
  ],
  ["si-tables", ["tables", "supplementary tables", "补充表格"]],
  ["si-figures", ["figures", "supplementary figures", "补充图"]],
  ["si-references", ["references", "bibliography", "参考文献"]],
  [
    "body",
    [
      "supporting information",
      "supplementary information",
      "supplementary materials",
      "补充材料",
    ],
  ],
];
export function sectionTitleKey(title: string): string {
  return title
    .normalize("NFKC")
    .trim()
    .replace(/^(?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?\s+(?=\S)/iu, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/u, "")
    .replace(/[.：:]\s*$/u, "")
    .toLowerCase()
    .replace(/\s+/gu, " ");
}
export function ruleSectionRole(
  title: string,
  part: DocumentPartRole,
): SectionRole | null {
  const key = sectionTitleKey(title);
  return (
    (part === "main" ? main : supplementary).find(([, names]) =>
      names.includes(key),
    )?.[0] ?? null
  );
}
/** Inheritance follows actual heading levels. A failed classification produces an explicit fallback, never a guessed label. */
export async function assignSectionRoles(input: {
  readonly structure: DocumentStructureV2;
  readonly markdown: Uint8Array;
  readonly part: DocumentPartRole;
  readonly max_prefix_characters: number;
  readonly locked: Readonly<Record<string, SectionRole>>;
  /** Explicit manual editing may reuse fixed automatic decisions without invoking a model. */
  readonly known?: ReadonlyMap<string, AssignedSection>;
  readonly unavailable_code?: string;
  readonly classify:
    | ((input: RoleModelInput, signal?: AbortSignal) => Promise<unknown>)
    | null;
  readonly signal?: AbortSignal;
}): Promise<readonly AssignedSection[]> {
  if (
    !Number.isSafeInteger(input.max_prefix_characters) ||
    input.max_prefix_characters < 0 ||
    input.max_prefix_characters > 65536
  )
    throw new Error("annotation-prefix-limit");
  const ids = new Set(input.structure.sections.map((s) => s.section_id));
  if (Object.keys(input.locked).some((id) => !ids.has(id)))
    throw new Error("annotation-manual-conflict");
  const rules = input.structure.sections.map((s) =>
    ruleSectionRole(s.title ?? "", input.part),
  );
  const result: AssignedSection[] = [];
  const stack: { level: number; assigned: AssignedSection }[] = [];
  for (const [index, section] of input.structure.sections.entries()) {
    if (input.signal?.aborted) throw new Error("annotation-cancelled");
    while (stack.length && stack.at(-1)!.level >= section.level) stack.pop();
    const parent = stack.at(-1)?.assigned;
    let role: SectionRole,
      source: RoleSource,
      inherited: string | null = null,
      failure: string | null = null;
    const locked = Object.hasOwn(input.locked, section.section_id);
    if (locked) {
      role = parseSectionRole(input.locked[section.section_id], input.part);
      source = "manual";
    } else if (rules[index]) {
      role = rules[index]!;
      source = "rule";
    } else if (parent) {
      role = parent.role;
      source = parent.role_source;
      inherited = parent.section_id;
    } else if (input.known?.has(section.section_id)) {
      const known = input.known.get(section.section_id)!;
      role = known.role;
      source = known.role_source;
      failure = known.failure_code;
    } else {
      role = "body";
      source = "fallback";
      const paragraph = input.structure.segments.find(
        (s) => s.section_id === section.section_id && s.kind !== "heading",
      );
      const prefix = paragraph
        ? Array.from(
            new TextDecoder("utf-8", { fatal: true }).decode(
              input.markdown.subarray(paragraph.start_utf8, paragraph.end_utf8),
            ),
          )
            .slice(0, input.max_prefix_characters)
            .join("")
        : "";
      if (!input.classify)
        failure = input.unavailable_code ?? "role-model-unavailable";
      else
        try {
          role = parseSectionRole(
            await input.classify(
              {
                title: section.title ?? "",
                prefix,
                part: input.part,
                previous_role: result.at(-1)?.role ?? null,
                next_role: rules[index + 1] ?? null,
              },
              input.signal,
            ),
            input.part,
          );
          source = "model";
        } catch {
          if (input.signal?.aborted) throw new Error("annotation-cancelled");
          failure = "role-model-failed";
        }
    }
    if (input.signal?.aborted) throw new Error("annotation-cancelled");
    const assigned = {
      section_id: section.section_id,
      role,
      role_source: source,
      inherited_from: inherited,
      locked,
      failure_code: failure,
    };
    result.push(assigned);
    stack.push({ level: section.level, assigned });
  }
  return result;
}
