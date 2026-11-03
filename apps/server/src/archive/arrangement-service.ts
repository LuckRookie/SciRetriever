import {
  programChromeDrops,
  CHROME_RULE,
  articleInformationText,
} from "./preprocess.js";
import {
  ARCHIVE_SECTION_ROLES,
  parseArchiveModelUsage,
  type ArchiveModelUsage,
  type ArchiveSectionRole,
  type ArchiveTextStop,
  type ArrangementOperation,
  type ArrangementSnapshot,
  type ArrangementSourceBlock,
  type ParagraphBreakDecision,
  type SourceSpan,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { PdfPages, ProofreadCache } from "../proofread/contract.js";
import { textTokens } from "../proofread/suspects.js";
import {
  ARRANGEMENT_METHOD,
  PARAGRAPH_BREAK_RULE,
  arrangementLeafSpans,
  reviewArrangement,
  acceptArrangement,
  verifyArrangement,
  type ArrangementConstraints,
  type ArrangementReview,
} from "./arrangement.js";
import {
  ArchiveTextError,
  cpSlice,
  textHash,
  type ArchiveTextSource,
} from "./text-source.js";
import {
  archiveTextModelIdentity,
  TextProgress,
  ARCHIVE_TEXT_STOP_POLICY,
  toolDeclaration,
  textReply,
  toolRecord,
  runArchiveTextSession,
  emptyArchiveUsage,
  sumArchiveUsage,
  archiveUsageFailure,
  stopFor,
  type ArchiveTextSessionResult,
} from "./text-session.js";

/** ADR 0048: one request answers every block; a second decides every paragraph break. */
export const ARRANGEMENT_TOOLS = "arrangement-single-pass-v2";
/**
 * The arrangement identity a proofread version records: a whole version is reused only
 * when it was arranged by this same workflow and break rule.
 */
export const ARRANGEMENT_WORKFLOW = `${ARRANGEMENT_METHOD}/${ARRANGEMENT_TOOLS}/${PARAGRAPH_BREAK_RULE}`;
export const ARRANGEMENT_SYSTEM = `You arrange the parsed blocks of one scientific article into a fixed skeleton without changing any characters.
Program-removed page chrome is absent. You receive the remaining blocks in reading order with its short ID (r1, r2, ...), type, page hint and exact text. Answer with exactly one submit_arrangement call. Never output block text.
Skeleton roles: ${ARCHIVE_SECTION_ROLES.join(", ")}.
- sections: consecutive ranges of blocks in the given order that together cover every block exactly once; each range has one role. Figures, schemes, tables, captions, equations and footnotes stay in the section where they appear, except author notes (corresponding author, e-mail, present address, equal contribution), which belong to end-matter: give them a range of their own. A section starts at its heading; a block that continues the previous block's sentence (it starts mid-sentence, often after a page or column break) stays in the previous block's section. Use additional only for a body section that fits none of the body roles (introduction, methods, results-discussion, conclusion), with heading = the ID of its own title block; otherwise heading is null.
- title is the article title only. authors contains names only. Affiliations, author information, corresponding author, ORCID, notes, funding, acknowledgments, abbreviations, associated content, author contributions, conflicts of interest and supporting-information notices belong to end-matter.
- The reference list is content: its heading and every entry go to references. Reference entries are never dropped.
- headings: the title blocks that head a skeleton section or a top-level heading of end-matter such as ASSOCIATED CONTENT, AUTHOR INFORMATION, Acknowledgements, Conflicts of interest, Data availability (section-heading), and the original subheadings under them (subheading, level 2-6). Every block not listed there is content; figure, scheme and table titles are content.
- drops: this article's own bibliographic lines (journal, volume, pages, DOI, cite-this lines) as bibliography; running heads as header; page numbers and running feet as footer; download, navigation or link labels near the title (Read Online, Metrics & More, Article Recommendations, Supporting Information) as interface; copyright and license lines as copyright; ornaments as decoration. A dropped block may sit inside any section range; the drop wins.
- First-page received/accepted/published dates are article information and belong to end-matter; retain them.
- captions: link each image or table block to its caption blocks, with kind figure, scheme or table. Multiple panels of the same figure may share the same caption.
- Some blocks arrive already split into parts named r5#1, r5#2, ...: treat each part as a block in headings, drops and captions; sections use block IDs.
- splits: only when one block still holds text that must be dropped together with text that must be kept. cuts are Unicode code-point offsets into the block text; the parts are named r5#1, r5#2, ... Never split for any other reason.
Page hints come from the parser and can be wrong; they never decide a role. Image and table blocks carry their region on the page (0-1000 coordinates, x0, y0, x1, y1): a small image in a page corner or margin (logo, badge, license or open-access icon) is decoration; figures, schemes, structures and the graphical abstract are content.`;
export const BREAK_SYSTEM = `You decide paragraph breaks in a scientific article. Each candidate is a place where a body paragraph may have been cut by a page or column end, or by a figure, scheme, table, caption, footnote or first-page article information placed in between (skipped).
You see the end of the left block (left_tail; the whole block when left_is_whole) and the start of the right block (right_head), and the types of the elements in between (skipped).
merge when the right side continues the same sentence or paragraph, also when it starts with a capital letter, a formula or a number that completes the left sentence. keep when the right side starts a new paragraph or when either side is not running text: a panel label, a legend entry, a symbol, a list item, a heading-like fragment. keep needs a short reason of one line.
Answer with exactly one submit_breaks call that decides every candidate.`;
/** A larger part stops as request-too-large until segmented arrangement is verified (ADR 0048 §5). */
export const ARRANGE_INPUT_MAX_BYTES = 384 * 1024;
/** Code points of each side shown for a break; a shorter block is sent whole. */
const BREAK_CONTEXT = 120,
  BREAK_WHOLE = 200;
const id = { type: "string" },
  dropReasons = [
    "header",
    "footer",
    "interface",
    "bibliography",
    "copyright",
    "decoration",
  ] as const;
const arrangementTool = toolDeclaration(
  "submit_arrangement",
  "Submit the whole arrangement at once.",
  {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          first: id,
          last: id,
          role: { type: "string", enum: ARCHIVE_SECTION_ROLES },
          heading: { anyOf: [id, { type: "null" }] },
        },
        required: ["first", "last", "role", "heading"],
        additionalProperties: false,
      },
    },
    headings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block: id,
          kind: { type: "string", enum: ["section-heading", "subheading"] },
          level: {
            anyOf: [
              { type: "integer", minimum: 2, maximum: 6 },
              { type: "null" },
            ],
          },
        },
        required: ["block", "kind", "level"],
        additionalProperties: false,
      },
    },
    drops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block: id,
          reason: { type: "string", enum: dropReasons },
        },
        required: ["block", "reason"],
        additionalProperties: false,
      },
    },
    captions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          object: id,
          captions: { type: "array", items: id },
          kind: { type: "string", enum: ["figure", "table", "scheme"] },
        },
        required: ["object", "captions", "kind"],
        additionalProperties: false,
      },
    },
    splits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block: id,
          cuts: { type: "array", items: { type: "integer", minimum: 1 } },
        },
        required: ["block", "cuts"],
        additionalProperties: false,
      },
    },
  },
);
const breakTool = toolDeclaration(
  "submit_breaks",
  "Decide every paragraph-break candidate at once.",
  {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate: id,
          decision: { type: "string", enum: ["merge", "keep"] },
          reason: { type: "string" },
        },
        required: ["candidate", "decision", "reason"],
        additionalProperties: false,
      },
    },
  },
);
type Issue = { code: string; id: string | null };
const invalid = (issues: readonly Issue[]) =>
  new ArchiveTextError("arrangement-invalid", issues.slice(0, 20));
const COPYRIGHT_LINE =
  /^\s*(?:©|\(c\)\s*\d{4}|copyright\b|this (?:article|journal) is licensed)/iu;
const NO_SPLIT_TYPES = new Set(["header", "footer", "page-number"]);
/** Where a copyright or license line glued to a block starts (ADR 0048 §2), or null. */
export function copyrightCut(text: string): number | null {
  let at = 0;
  for (const line of text.split("\n")) {
    if (at > 0 && COPYRIGHT_LINE.test(line)) return at;
    at += [...line].length + 1;
  }
  const tail = /©\s*\d{4}[^\n]*$/u.exec(text);
  return tail && tail.index > 0 ? [...text.slice(0, tail.index)].length : null;
}
/**
 * The page a leaf belongs to by the text layer: every one of its words (at least four
 * distinct) printed on exactly one text-layer page other than its hint (ADR 0048 §2).
 */
export function textLayerPage(
  text: string,
  hint: number,
  layers: readonly ReadonlyMap<string, number>[],
): number | null {
  const need = new Map<string, number>();
  for (const t of textTokens(text)) need.set(t, (need.get(t) ?? 0) + 1);
  if (need.size < 4) return null;
  const pages = layers.flatMap((layer, page) =>
    layer.size && [...need].every(([t, n]) => (layer.get(t) ?? 0) >= n)
      ? [page]
      : [],
  );
  return pages.length === 1 && pages[0] !== hint ? pages[0]! : null;
}
interface Part {
  readonly name: string;
  readonly block: string;
  readonly root: ArrangementSourceBlock;
  readonly leaf_id: string;
  readonly start: number;
  readonly end: number;
}
interface Answer {
  readonly sections: readonly {
    first: string;
    last: string;
    role: ArchiveSectionRole;
    heading: string | null;
  }[];
  readonly headings: readonly {
    block: string;
    kind: "section-heading" | "subheading";
    level: number | null;
  }[];
  readonly drops: readonly {
    block: string;
    reason: (typeof dropReasons)[number];
  }[];
  readonly captions: readonly {
    object: string;
    captions: readonly string[];
    kind: "figure" | "table" | "scheme";
  }[];
  readonly splits: readonly { block: string; cuts: readonly number[] }[];
}
function rows<T>(value: unknown, field: string, issues: Issue[]): T[] {
  if (!Array.isArray(value)) {
    issues.push({ code: "tool-input", id: field });
    return [];
  }
  return value.filter((row: unknown, i) => {
    const ok = !!row && typeof row === "object" && !Array.isArray(row);
    if (!ok) issues.push({ code: "tool-input", id: `${field}[${i}]` });
    return ok;
  }) as T[];
}
export class ArchiveArrangementService {
  constructor(
    private readonly runtime: DshAgentRuntime,
    private readonly pages: PdfPages,
    private readonly cache: ProofreadCache,
  ) {}
  async build(
    source: ArchiveTextSource,
    signal?: AbortSignal,
    seed?: ArrangementSnapshot,
    lockedTextSpans: readonly SourceSpan[] = [],
  ): Promise<ArchiveTextSessionResult<ArrangementSnapshot>> {
    signal?.throwIfAborted();
    const method = textHash({
      arrange: ARRANGEMENT_METHOD,
      tools: ARRANGEMENT_TOOLS,
      prompt: textHash([ARRANGEMENT_SYSTEM, BREAK_SYSTEM]),
      breaks: PARAGRAPH_BREAK_RULE,
      chrome: CHROME_RULE,
      stop: ARCHIVE_TEXT_STOP_POLICY,
      pages: this.pages.method,
      model: archiveTextModelIdentity(this.runtime),
    });
    const key = textHash({
      stage: "arrangement-checkpoint-v2",
      manual: seed?.destinations.filter((d) => d.locked) ?? [],
      manual_revision: seed?.manual_revision ?? 0,
      locked_text_spans: lockedTextSpans,
      source: source.input_sha256,
      method,
    });
    const old = await this.cache.read(key, signal);
    if (old) {
      try {
        if (old.media_type !== "application/json")
          throw new ArchiveTextError("source-integrity");
        const stored = toolRecord(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(old.bytes),
          ),
          [
            "schema_version",
            "stage",
            "source_input_sha256",
            "method_sha256",
            "snapshot",
            "usage",
            "evidence",
          ],
        );
        if (
          stored.schema_version !== 2 ||
          stored.stage !== "arrange" ||
          stored.source_input_sha256 !== source.input_sha256 ||
          stored.method_sha256 !== method
        )
          throw new ArchiveTextError("source-integrity");
        parseArchiveModelUsage(stored.usage);
        const evidence = toolRecord(stored.evidence, [
          "evidence_pages",
          "caption_fixes",
        ]);
        if (
          !Array.isArray(evidence.evidence_pages) ||
          evidence.evidence_pages.some(
            (p) =>
              !Number.isSafeInteger(p) ||
              p < 0 ||
              p >= source.raw.page_count ||
              source.pages[p as number]?.kind !== "text-layer",
          ) ||
          !Array.isArray(evidence.caption_fixes)
        )
          throw new ArchiveTextError("source-integrity");
        return {
          value: verifyArrangement(source, stored.snapshot, method, {
            evidence_pages: new Set<number>(evidence.evidence_pages),
          }),
          usage: emptyArchiveUsage(),
          stop: null,
        };
      } catch {
        throw new ArchiveTextError("source-integrity");
      }
    }
    const locked = new Map(
        seed?.destinations
          .filter((d) => d.locked)
          .map((d) => [d.leaf_id, d.destination]) ?? [],
      ),
      constraints: ArrangementConstraints = {
        locked_spans: lockedTextSpans,
        manual_revision: seed?.manual_revision ?? 0,
        locked_destinations: locked,
        locked_decisions: new Map(
          seed?.destinations
            .filter((d) => d.locked)
            .map((d) => [d.leaf_id, d.decision_id!]) ?? [],
        ),
      };
    // Roots whose leaves a person fixed keep the seed's split; glued copyright lines are
    // split by the program; the model may split only what is left.
    const seedLeaves = new Map(seed?.leaves.map((l) => [l.leaf_id, l]) ?? []);
    const keptRoots = new Set([
      ...[...locked.keys()].flatMap((id) => {
        const leaf = seedLeaves.get(id);
        return leaf ? [leaf.source.root_block_id] : [];
      }),
      ...lockedTextSpans.map((s) => s.root_block_id),
    ]);
    const chrome = programChromeDrops(
      source.blocks,
      source.raw.page_count,
      keptRoots,
    );
    const modelBlocks = source.blocks.filter(
      (b) => !chrome.has(b.root_block_id),
    );
    const fixedCuts = new Map<string, readonly number[]>();
    for (const b of source.blocks) {
      if (keptRoots.has(b.root_block_id)) {
        const split = seed?.operations.find(
          (o) => o.kind === "split" && o.root_block_id === b.root_block_id,
        );
        if (split?.kind === "split") fixedCuts.set(b.root_block_id, split.cuts);
        continue;
      }
      if (chrome.has(b.root_block_id) || NO_SPLIT_TYPES.has(b.type)) continue;
      const cut = copyrightCut(b.text);
      if (cut !== null) fixedCuts.set(b.root_block_id, [cut]);
    }
    const blockName = new Map(
      modelBlocks.map((b, i) => [b.root_block_id, `r${i + 1}`]),
    );
    const byName = new Map(
      modelBlocks.map((b) => [blockName.get(b.root_block_id)!, b]),
    );
    const partsOf = (b: ArrangementSourceBlock, cuts: readonly number[]) => {
      const name = blockName.get(b.root_block_id)!,
        spans = arrangementLeafSpans(b, source.raw.result_sha256, cuts);
      return spans.map(
        (s, i): Part => ({
          name: spans.length > 1 ? `${name}#${i + 1}` : name,
          block: name,
          root: b,
          leaf_id: s.leaf_id,
          start: s.start,
          end: s.end,
        }),
      );
    };
    const initial = {
      source_input_sha256: source.input_sha256,
      page_count: source.raw.page_count,
      blocks: modelBlocks.flatMap((b) =>
        partsOf(b, fixedCuts.get(b.root_block_id) ?? []).map((p) => ({
          id: p.name,
          type: b.type,
          page: b.page_hint,
          ...(b.title_level !== null ? { title_level: b.title_level } : {}),
          ...(["image", "table"].includes(b.type) && b.region_hint
            ? { region: b.region_hint }
            : {}),
          text: cpSlice(b.text, p.start, p.end),
        })),
      ),
    };
    if (Buffer.byteLength(JSON.stringify(initial)) > ARRANGE_INPUT_MAX_BYTES)
      return {
        value: null,
        usage: emptyArchiveUsage(),
        stop: stopFor(
          new ArchiveTextError("request-too-large"),
          "arrange",
          null,
        ),
      };
    const layers = source.pages.map((p) => {
      const counts = new Map<string, number>();
      if (p.kind === "text-layer")
        for (const t of textTokens(p.text))
          counts.set(t, (counts.get(t) ?? 0) + 1);
      return counts;
    });
    const evidencePages = new Set<number>(),
      captionFixes: string[] = [];
    let review: ArrangementReview | null = null,
      ops: ArrangementOperation[] = [];
    // Short names in rejections, so the model can correct its own answer.
    const shortIssue = (i: Issue, names: ReadonlyMap<string, string>) => ({
      code: i.code,
      id:
        i.id === null ? null : (names.get(i.id) ?? blockName.get(i.id) ?? i.id),
    });
    const expand = (args: Record<string, unknown>) => {
      evidencePages.clear();
      captionFixes.length = 0;
      const r = toolRecord(args, [
          "sections",
          "headings",
          "drops",
          "captions",
          "splits",
        ]),
        issues: Issue[] = [];
      const a: Answer = {
        sections: rows(r.sections, "sections", issues),
        headings: rows(r.headings, "headings", issues),
        drops: rows(r.drops, "drops", issues),
        captions: rows(r.captions, "captions", issues),
        splits: rows(r.splits, "splits", issues),
      };
      const cuts = new Map(fixedCuts);
      for (const s of a.splits) {
        const b = byName.get(s.block);
        if (!b || fixedCuts.has(b.root_block_id) || !Array.isArray(s.cuts))
          issues.push({ code: "split-invalid", id: s.block });
        else
          cuts.set(
            b.root_block_id,
            [...new Set(s.cuts)].sort((x, y) => x - y),
          );
      }
      const parts = modelBlocks.flatMap((b) =>
        partsOf(b, cuts.get(b.root_block_id) ?? []),
      );
      const part = new Map(parts.map((p) => [p.name, p])),
        names = new Map(parts.map((p) => [p.leaf_id, p.name])),
        order = new Map([...byName.keys()].map((k, i) => [k, i]));
      const leafOf = (name: string, field: string) => {
        const p = part.get(name);
        if (!p) issues.push({ code: "unknown-block", id: `${field}:${name}` });
        return p;
      };
      const section = new Array<Answer["sections"][number] | null>(
        modelBlocks.length,
      ).fill(null);
      for (const s of a.sections) {
        const i = order.get(String(s.first).split("#")[0]!),
          j = order.get(String(s.last).split("#")[0]!);
        if (i === undefined || j === undefined || j < i) {
          issues.push({ code: "section-invalid", id: `${s.first}-${s.last}` });
          continue;
        }
        for (let k = i; k <= j; k++) {
          if (section[k])
            issues.push({ code: "section-overlap", id: `r${k + 1}` });
          section[k] = s;
        }
      }
      section.forEach((s, k) => {
        if (!s) issues.push({ code: "block-without-section", id: `r${k + 1}` });
      });
      const headings = new Map(a.headings.map((h) => [h.block, h])),
        drops = new Map(a.drops.map((d) => [d.block, d.reason]));
      for (const name of [...headings.keys(), ...drops.keys()])
        leafOf(name, "headings/drops");
      const next: ArrangementOperation[] = source.blocks.flatMap((b) => {
        const rule = chrome.get(b.root_block_id);
        return rule
          ? arrangementLeafSpans(b, source.raw.result_sha256).map((p) => ({
              kind: "drop" as const,
              leaf_id: p.leaf_id,
              ...rule,
            }))
          : [];
      });
      for (const [root, c] of cuts)
        if (c.length)
          next.push({ kind: "split", root_block_id: root, cuts: c });
      for (const p of parts) {
        const lock = locked.get(p.leaf_id);
        if (lock) {
          next.push(
            lock.kind === "dropped"
              ? { kind: "drop", leaf_id: p.leaf_id, reason: lock.reason }
              : {
                  kind: "assign",
                  leaf_id: p.leaf_id,
                  target: lock.target,
                  presentation: lock.presentation,
                },
          );
          continue;
        }
        const s = section[order.get(p.block)!],
          drop = drops.get(p.name) ?? drops.get(p.block);
        if (drop) {
          next.push({ kind: "drop", leaf_id: p.leaf_id, reason: drop });
          continue;
        }
        if (!s) continue;
        const h = headings.get(p.name) ?? headings.get(p.block);
        const heading =
          s.role === "additional" && s.heading
            ? (leafOf(s.heading, "sections.heading")?.leaf_id ?? null)
            : null;
        next.push({
          kind: "assign",
          leaf_id: p.leaf_id,
          target:
            s.role === "additional"
              ? { role: "additional", original_heading_leaf_id: heading }
              : { role: s.role },
          presentation: !h
            ? { kind: "content" }
            : h.kind === "subheading"
              ? {
                  kind: "subheading",
                  level: Math.min(
                    6,
                    Math.max(2, Math.round(Number(h.level ?? 2)) || 2),
                  ) as 2 | 3 | 4 | 5 | 6,
                }
              : { kind: "section-heading" },
        });
      }
      // A leaf with a locked text correction stays retained where the person left it.
      for (const span of lockedTextSpans) {
        const p = parts.find(
          (x) =>
            x.root.root_block_id === span.root_block_id &&
            x.start === span.start &&
            x.end === span.end,
        );
        const prior =
          p && seed?.destinations.find((d) => d.leaf_id === p.leaf_id);
        const at = p
          ? next.findIndex((o) => "leaf_id" in o && o.leaf_id === p.leaf_id)
          : -1;
        if (
          prior?.destination.kind === "assigned" &&
          at >= 0 &&
          next[at]!.kind === "drop"
        )
          next[at] = {
            kind: "assign",
            leaf_id: p!.leaf_id,
            target: prior.destination.target,
            presentation: prior.destination.presentation,
          };
      }
      const dropped = new Set(
          next.filter((o) => o.kind === "drop").map((o) => o.leaf_id),
        ),
        captioned = new Map<string, string>();
      for (const c of a.captions) {
        const object = part.get(c.object);
        const ids = (Array.isArray(c.captions) ? c.captions : []).flatMap(
          (n) => {
            const p = part.get(n);
            const ok =
              p &&
              p.root.type === "caption" &&
              (!captioned.has(p.leaf_id) ||
                captioned.get(p.leaf_id) === textHash([c.kind, c.captions])) &&
              !dropped.has(p.leaf_id);
            if (!ok) captionFixes.push(`${c.object}<${n}`);
            return ok ? [p.leaf_id] : [];
          },
        );
        if (
          object &&
          ["image", "table"].includes(object.root.type) &&
          !dropped.has(object.leaf_id) &&
          ids.length
        ) {
          ids.forEach((x) => captioned.set(x, textHash([c.kind, c.captions])));
          next.push({
            kind: "caption",
            object_leaf_id: object.leaf_id,
            caption_leaf_ids: ids,
            object_kind: c.kind,
          });
        } else if (ids.length) captionFixes.push(`object ${c.object}`);
      }
      if (issues.length) throw invalid(issues);
      for (const p of parts) {
        if (dropped.has(p.leaf_id)) continue;
        const page = textLayerPage(
          cpSlice(p.root.text, p.start, p.end),
          p.root.page_hint,
          layers,
        );
        if (page === null) continue;
        evidencePages.add(page);
        next.push({
          kind: "assign-page",
          leaf_id: p.leaf_id,
          page_index: page,
          basis_page_index: page,
          reason: "The text layer prints it on this page.",
        });
      }
      try {
        review = reviewArrangement(source, next, {
          ...constraints,
          evidence_pages: evidencePages,
        });
      } catch (error) {
        if (error instanceof ArchiveTextError && error.issues.length)
          throw new ArchiveTextError(
            error.code,
            error.issues.map((i) => shortIssue(i, names)),
            { cause: error },
          );
        throw error;
      }
      ops = next;
    };
    const usages: ArchiveModelUsage[] = [];
    // One request, one correction of a rejected answer, one resend of a failed request.
    const ask = async (
      name: "arrange" | "breaks",
      system: string,
      tool: typeof arrangementTool,
      input: unknown,
      accept: (args: Record<string, unknown>) => void,
    ): Promise<ArchiveTextStop | null> => {
      let stop: ArchiveTextStop | null = null;
      for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
        let done = false,
          rejected = 0;
        const progress = new TextProgress("arrange", null);
        const session = await runArchiveTextSession(
          this.runtime,
          {
            step: "arrange",
            page_index: null,
            input_sha256: textHash({ key, request: name }),
            progress,
            system,
            initial: input,
            tools: [tool],
            toolChoice: "required",
            accepted: () => (done ? true : null),
            execute: async (call, args, context) => {
              if (call !== tool.name) throw new ArchiveTextError("tool-input");
              try {
                accept(args);
              } catch (error) {
                if (++rejected > 1)
                  throw Object.assign(new Error("arrangement rejected twice"), {
                    code: "arrangement-invalid",
                  });
                throw error;
              }
              done = true;
              progress.progress(name, true);
              context.concludeTurn();
              return textReply({ accepted: true });
            },
          },
          signal,
        );
        usages.push(session.usage);
        if (done) return null;
        stop = session.stop;
        if (stop?.cause_code === "arrangement-invalid") break;
      }
      return stop;
    };
    try {
      const stop = modelBlocks.length
        ? await ask(
            "arrange",
            ARRANGEMENT_SYSTEM,
            arrangementTool,
            initial,
            expand,
          )
        : (expand({
            sections: [],
            headings: [],
            drops: [],
            captions: [],
            splits: [],
          }),
          null);
      if (stop || !review)
        return {
          value: null,
          usage: sumArchiveUsage(usages),
          stop:
            stop ?? stopFor(new Error("arrangement missing"), "arrange", null),
        };
      const reviewed: ArrangementReview = review;
      const text = new Map(
          reviewed.leaves.map((l) => [l.leaf_id, l.original_text]),
        ),
        types = new Map(
          reviewed.leaves.map((l) => {
            const d = reviewed.destinations.get(l.leaf_id);
            return [
              l.leaf_id,
              l.page_index === 0 &&
              d?.kind === "assigned" &&
              d.target.role === "end-matter" &&
              articleInformationText(l.original_text)
                ? "article-information"
                : l.type,
            ];
          }),
        );
      const candidates = reviewed.candidates.map((c, i) => ({
        c,
        name: `c${i + 1}`,
      }));
      let decisions: ParagraphBreakDecision[] = candidates
          .filter(({ c }) => c.automatic)
          .map(({ c }) => ({
            candidate_id: c.candidate_id,
            decision: "merge",
          })),
        merged = new Set(
          candidates.filter(({ c }) => c.automatic).map(({ name }) => name),
        );
      const pending = candidates.filter(({ c }) => !c.automatic);
      if (pending.length) {
        const side = (id: string, tail: boolean) => {
          const chars = [...(text.get(id) ?? "")];
          return chars.length <= BREAK_WHOLE
            ? chars.join("")
            : (tail
                ? chars.slice(-BREAK_CONTEXT)
                : chars.slice(0, BREAK_CONTEXT)
              ).join("");
        };
        const stopBreaks = await ask(
          "breaks",
          BREAK_SYSTEM,
          breakTool,
          {
            source_input_sha256: source.input_sha256,
            candidates: pending.map(({ c, name }) => ({
              candidate: name,
              left_tail: side(c.left_leaf_id, true),
              right_head: side(c.right_leaf_id, false),
              left_is_whole:
                [...(text.get(c.left_leaf_id) ?? "")].length <= BREAK_WHOLE,
              left_ends_with_hyphen: c.left_ends_with_hyphen,
              skipped: c.skipped_leaf_ids.map((x) => types.get(x)),
            })),
          },
          (args) => {
            const r = toolRecord(args, ["decisions"]),
              issues: Issue[] = [],
              given = rows<{
                candidate: string;
                decision: string;
                reason: string;
              }>(r.decisions, "decisions", issues),
              by = new Map<string, { decision: string; reason: string }>();
            for (const d of given) {
              if (
                by.has(d.candidate) ||
                !pending.some((c) => c.name === d.candidate)
              )
                issues.push({
                  code: "break-decision-invalid",
                  id: String(d.candidate),
                });
              by.set(d.candidate, d);
            }
            const next = pending.map(({ c, name }) => {
              const d = by.get(name);
              if (!d) issues.push({ code: "break-decision-missing", id: name });
              if (d?.decision === "merge")
                return {
                  candidate_id: c.candidate_id,
                  decision: "merge" as const,
                };
              const reason = String(d?.reason ?? "")
                .split("\n")[0]!
                .trim();
              if (d && !reason)
                issues.push({ code: "break-reason-missing", id: name });
              return {
                candidate_id: c.candidate_id,
                decision: "keep" as const,
                reason: [...reason].slice(0, 120).join(""),
              };
            });
            if (issues.length) throw invalid(issues);
            decisions = [
              ...decisions.filter((d) =>
                candidates.some(
                  ({ c }) => c.automatic && c.candidate_id === d.candidate_id,
                ),
              ),
              ...next,
            ];
            merged = new Set(
              candidates
                .filter(
                  ({ c, name }) =>
                    c.automatic || by.get(name)?.decision === "merge",
                )
                .map(({ name }) => name),
            );
          },
        );
        if (stopBreaks)
          return {
            value: null,
            usage: sumArchiveUsage(usages),
            stop: stopBreaks,
          };
      }
      // Adjacent merges a-b and b-c become one merge a-b-c.
      const chains: string[][] = [];
      for (const { c, name } of candidates)
        if (merged.has(name)) {
          const chain = chains.find((x) => x.at(-1) === c.left_leaf_id);
          if (chain) chain.push(c.right_leaf_id);
          else chains.push([c.left_leaf_id, c.right_leaf_id]);
        }
      const operations = [
        ...ops,
        ...chains.map(
          (leaf_ids): ArrangementOperation => ({
            kind: "merge",
            leaf_ids,
            ...(candidates
              .filter(
                ({ c }) =>
                  leaf_ids.includes(c.left_leaf_id) &&
                  leaf_ids.includes(c.right_leaf_id),
              )
              .every(({ c }) => c.automatic)
              ? {
                  source: "program" as const,
                  rule: PARAGRAPH_BREAK_RULE + "/text-boundary",
                }
              : {}),
          }),
        ),
      ];
      const pageConstraints = { ...constraints, evidence_pages: evidencePages },
        final = reviewArrangement(source, operations, pageConstraints);
      const value = acceptArrangement(
        source,
        {
          schema_version: 1,
          source_input_sha256: source.input_sha256,
          reviewed_candidates_sha256: final.candidates_sha256,
          operations,
          break_decisions: decisions,
        },
        method,
        pageConstraints,
      );
      const usage = sumArchiveUsage(usages);
      if (!signal?.aborted)
        try {
          await this.cache.save(
            key,
            Buffer.from(
              JSON.stringify({
                schema_version: 2,
                stage: "arrange",
                source_input_sha256: source.input_sha256,
                method_sha256: method,
                snapshot: value,
                usage,
                evidence: {
                  evidence_pages: [...evidencePages].sort((x, y) => x - y),
                  caption_fixes: captionFixes.slice(0, 200),
                },
              }),
            ),
            "application/json",
            signal,
          );
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "proofread-cache-conflict"
          )
            throw error;
          const winner = await this.build(
            source,
            signal,
            seed,
            lockedTextSpans,
          );
          return { value: winner.value, usage, stop: null };
        }
      return { value, usage, stop: null };
    } catch (failure) {
      throw archiveUsageFailure(failure, sumArchiveUsage(usages));
    }
  }
}
