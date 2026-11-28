import type {
  LayersReadBasis,
  LayersReadEvidence,
  LayersReadPoint,
  LayersReadUnitRef,
} from "@sciretriever/contracts";
import type { DocumentTextMode } from "../contract.js";
import {
  KIND_NAMES,
  RELATION_NAMES,
  alignedTranslation,
  captionHTML,
  captionParts,
  cutClass,
  escape,
  evidenceCut,
  figureName,
  headingHTML,
  langOf,
  numberHTML,
  paragraphNo,
  pointWords,
  reasonWords,
  richHTML,
  sectionLine,
  sentenceWords,
  words,
  type LayerFigure,
  type LayersModel,
  type LayersModelSection,
  type LayersPort,
} from "./model.js";
import { blockCopy } from "./notes.js";
import type { ReadLayersPoint } from "./read.js";

/**
 * The two leaves that are not the full text (reading-experience 3.2, 3.3):
 * 概览, what stands at the front of the book, and 脉络, the notes set as the
 * text with the author's sentences under them. Each returns the column and
 * what stands in the margin beside it; the view places the margin.
 *
 * A thing that is the same thing on two leaves carries the same `data-f`:
 * the change between layers moves it from its old place to its new one.
 */
export interface Leaf {
  readonly column: string;
  readonly side: string;
}

/** The paragraph number the full text shows beside a place. */
export function paragraphOf(
  port: LayersPort,
  start: number | null,
  fallback: number,
): number {
  const shown =
    start === null ? undefined : port.blockAt(start)?.dataset.paragraph;
  return shown ? Number(shown) : fallback;
}
/** A note's relations: to another paragraph's note by its number (“承接 ¶41”), to a figure by its name. */
export const relationsHTML = (
  model: LayersModel,
  p: LayersReadPoint,
  port: LayersPort,
  mode: DocumentTextMode,
  drawn: ReadonlySet<string> = new Set(),
) =>
  p.relations
    .map((r) => ({
      word: r.word,
      targets: r.targets.filter(
        (t) => t.kind === "point" || !drawn.has(t.segment_id),
      ),
    }))
    .filter((r) => r.targets.length > 0)
    .map(
      (r) =>
        `<span>${RELATION_NAMES[r.word]} ${r.targets
          .map((t) =>
            t.kind === "point"
              ? `<a data-point="${t.number}">¶${paragraphNo(model, t.number, t.paragraph)}</a>`
              : `<a data-fig="${escape(t.segment_id)}">${escape(
                  figureName(port.figure(t.segment_id), t.block_kind, mode),
                )}</a>`,
          )
          .join("、")}</span>`,
    )
    .join("");
export const titleHTML = (port: LayersPort) =>
  port.title
    ? `<h1 class="rl-title" data-f="title" lang="${langOf(port.title)}">${richHTML(port.title)}</h1><div class="rl-title-end"></div>`
    : "";
export const rulesHTML = () =>
  `<div class="rl-rules" data-f="rules"><h3>凡例</h3><dl>` +
  `<dt class="rl-ink">宋体</dt><dd>作者原文</dd>` +
  `<dt>楷体</dt><dd>机器所写；批在页边时用朱色</dd>` +
  `<dt class="rl-zhu"><span class="rl-nm rl-ring">¶8</span></dt><dd>实心朱圈里的段号是全篇主干</dd>` +
  `<dt><b class="rl-kt">朱字</b></dt><dd>被批句子里的要紧字词</dd>` +
  `<dt class="rl-lan">蓝字</dt><dd>读者自己的批注</dd></dl></div>`;
export const endHTML = (model: LayersModel, figures: number) =>
  `<div class="rl-end"><p>批语 ${model.points.length} 条${figures ? `\u3000图表 ${figures} 件` : ""}</p></div>`;
/**
 * A note as a 纲 (ADR 0073): its paragraph's number in the left margin (in a
 * filled ring for a primary one), the note, and in 脉络 its reason after it
 * in the same paragraph; its 目 under it.
 */
const gangHTML = (
  model: LayersModel,
  p: LayersReadPoint,
  mode: DocumentTextMode,
  body: string,
  withReason = true,
) => {
  const w = pointWords(p, mode);
  const reason = withReason ? reasonWords(p, mode) : null;
  return (
    `<section class="rl-gang${p.primary ? " rl-main" : ""}" data-point="${p.number}">` +
    numberHTML(
      p,
      paragraphNo(model, p.number),
      "rl-gang-no",
      `no:${p.number}`,
    ) +
    `<p class="rl-gang-t" data-f="note:${p.number}" lang="${langOf(w.text)}">${richHTML(w.text, w.terms)}` +
    (reason
      ? `<span class="rl-reason" lang="${langOf(reason)}">${richHTML(reason)}</span>`
      : "") +
    `</p><div class="rl-mu">${body}</div></section>`
  );
};
/**
 * A sentence evidence as a 目: the author's words. Its paragraph's number
 * stands in the left margin when it is not the note's own; `gap` puts a
 * faint “…” before it (not the sentence after the one before). A quote
 * that begins or ends inside a sentence (ADR 0074) has the same faint “…”
 * there; so has its translated quote, while a whole paragraph's
 * translation standing in for one has none.
 */
function sentenceHTML(
  e: Extract<LayersReadEvidence | LayersReadBasis, { kind: "sentence" }>,
  key: string,
  terms: { original: readonly string[]; translation: readonly string[] },
  port: LayersPort,
  mode: DocumentTextMode,
  own: number | null = null,
  gap = false,
): string {
  const n = paragraphOf(port, e.start_utf8, e.paragraph);
  const cut = cutClass(evidenceCut(port, e));
  const span = (text: string, cls: string, words: readonly string[]) =>
    `<span${cls ? ` class="${cls}"` : ""} lang="${langOf(text)}">${richHTML(text, words)}</span>`;
  const original = span(e.text, cut, terms.original);
  const sentence =
    "translation" in e || "translated" in e
      ? (e as Extract<LayersReadEvidence, { kind: "sentence" }>)
      : null;
  const t =
    sentence && mode !== "original" ? sentenceWords(sentence, mode) : null;
  const trCut = sentence && alignedTranslation(sentence) ? cut : "";
  const body =
    t?.translated && mode === "translation"
      ? span(t.text, trCut, terms.translation)
      : t?.translated && mode === "bilingual"
        ? `${original}${span(t.text, `rl-mu-tr${trCut ? ` ${trCut}` : ""}`, terms.translation)}`
        : original;
  return (
    `<p class="rl-mu-s${gap ? " rl-gap" : ""}" data-ev="${key}" data-f="ev:${key}" ` +
    `data-start="${e.start_utf8}">${n === own ? "" : `<span class="rl-pn"><i>¶${n}</i></span>`}${body}</p>`
  );
}
/** Whether a sentence evidence follows the one before it in its paragraph. */
const follows = (
  before: LayersReadEvidence | undefined,
  e: Extract<LayersReadEvidence, { kind: "sentence" }>,
) =>
  before?.kind === "sentence" &&
  before.unit_id === e.unit_id &&
  (e.sentences[0] ?? 0) === (before.sentences.at(-1) ?? -1) + 1;
/** A figure a note stands on: a plate under the sentences; a table as its name and one line. */
function figureHTML(
  f: LayerFigure | null,
  segmentId: string,
  kind: string,
  caption: string | null,
  mode: DocumentTextMode,
  plate: boolean,
): string {
  const parts = captionParts(f?.caption(mode) ?? caption);
  const name = f
    ? figureName(f, kind, mode)
    : (parts.lead ?? figureName(null, kind, mode));
  const id = escape(segmentId);
  if (!plate || kind === "table")
    return `<p class="rl-mu-s rl-fig"><a data-fig="${id}">${escape(name)}</a><span>${richHTML(parts.rest)}</span></p>`;
  // The whole figure: every picture of its group side by side.
  const panels = f?.panels.length ? f.panels : [segmentId];
  const images = panels
    .map((panel) => {
      const p = escape(panel);
      return `<img alt="${escape(name)}" data-image="${p}" data-zoom="${p}"${
        panel === segmentId ? ` data-f="fig:${id}"` : ""
      }>`;
    })
    .join("");
  return (
    `<figure class="rl-plate" data-fig="${id}"><div class="rl-panels">${images}</div>` +
    `<p class="rl-cap">${captionHTML(name, parts.rest)}</p></figure>`
  );
}
/** The figures a note stands on and the ones it points to (“见 图 8”), in that order. */
function namedFigures(
  p: LayersReadPoint,
  ground: readonly {
    segment_id: string;
    block_kind: string;
    caption: string | null;
  }[],
): { id: string; kind: string; caption: string | null; pointed: boolean }[] {
  return [
    ...ground.map((g) => ({
      id: g.segment_id,
      kind: g.block_kind,
      caption: g.caption,
      pointed: false,
    })),
    ...p.relations.flatMap((r) =>
      r.targets.flatMap((t) =>
        t.kind === "point"
          ? []
          : [
              {
                id: t.segment_id,
                kind: t.block_kind,
                caption: null,
                pointed: true,
              },
            ],
      ),
    ),
  ];
}
/**
 * A figure as a small plate in the margin: its pictures side by side, its
 * name and caption under them (“图 8 …”).
 */
function marginPlateHTML(
  f: LayerFigure | null,
  n: { id: string; kind: string; caption: string | null },
  mode: DocumentTextMode,
  cls: string,
  attrs: string,
  lead: string,
): string {
  const parts = captionParts(f?.caption(mode) ?? n.caption);
  const name = f
    ? figureName(f, n.kind, mode)
    : (parts.lead ?? figureName(null, n.kind, mode));
  const id = escape(n.id);
  const images = (f?.panels.length ? f.panels : [n.id])
    .map((panel) => {
      const at = escape(panel);
      return `<img alt="${escape(name)}" data-image="${at}" data-zoom="${at}"${
        panel === n.id ? ` data-f="fig:${id}"` : ""
      }>`;
    })
    .join("");
  return (
    `<figure class="${cls}"${attrs} data-fig="${id}"><div class="rl-panels">${images}</div>` +
    `<figcaption>${lead}${captionHTML(name, parts.rest)}</figcaption></figure>`
  );
}
const termsOf = (p: LayersReadPoint) => ({
  original: p.key_terms,
  translation: p.translation?.key_terms ?? [],
});

/**
 * What 脉络 sets, in the full text's order (ADR 0073): a section's heading
 * with its line, a paragraph's note, or a paragraph without one, set as it
 * is.
 */
export type OutlineItem =
  | { readonly kind: "heading"; readonly section: LayersModelSection }
  | { readonly kind: "line"; readonly section: LayersModelSection }
  | { readonly kind: "note"; readonly number: number }
  | {
      readonly kind: "plain";
      readonly start: number;
      readonly paragraph: number;
      readonly html: string;
    };
/** A block's own element (the page may put a control before it). */
const own = (b: HTMLElement, tags: string) =>
  b.querySelector(`:scope > :is(${tags})`);
/** A block that is a paragraph of the author's text: a paragraph, a list, a caption. */
/**
 * A block 脉络 sets as it is when it has no note: a paragraph or a list.
 * Figures, tables and their captions are not set in the column: a figure
 * stands as a plate in the margin beside the note that names it (3.3).
 */
const isParagraph = (b: HTMLElement) =>
  !b.matches(
    ".reading-article-info, .reading-footnote, .reading-figure-caption, .reading-figure-cell",
  ) &&
  !b.querySelector("[data-resource], table") &&
  (b.dataset.paragraph !== undefined || !!own(b, "ul, ol"));
/**
 * Walks the full text's blocks (reading-experience 3.3): each listed
 * section's heading, each note at its paragraph, and the paragraphs without
 * a note in the sections listed. A section the layers do not list (no note,
 * no line: the references, say) is left out with its paragraphs. Without
 * the blocks, the sections and their notes in order.
 */
export function outlineItems(
  model: LayersModel,
  port: LayersPort,
  mode: DocumentTextMode,
  startOf: (p: ReadLayersPoint) => number | null,
): OutlineItem[] {
  const blocks = port.blocks?.() ?? [];
  const items: { item: OutlineItem; section: string | null }[] = [];
  const untitled = model.sections.find((s) => s.title === null);
  if (untitled && sectionLine(untitled.line, mode))
    items.push({ item: { kind: "line", section: untitled }, section: null });
  if (!blocks.length) {
    for (const s of model.sections) {
      if (s.title !== null)
        items.push({ item: { kind: "heading", section: s }, section: null });
      for (const number of s.numbers)
        items.push({ item: { kind: "note", number }, section: null });
    }
    return items.map((x) => x.item);
  }
  const headings = new Map<HTMLElement, LayersModelSection>();
  for (const s of model.sections) {
    const info = s.section_id && s.title !== null && port.section(s.section_id);
    const block = info ? port.blockAt(info.start) : undefined;
    if (block) headings.set(block, s);
  }
  const notes = new Map<HTMLElement, number[]>();
  const placed = new Set<number>();
  for (const p of model.points) {
    const start = startOf(p);
    const block = start === null ? undefined : port.blockAt(start);
    if (!block) continue;
    notes.set(block, [...(notes.get(block) ?? []), p.number]);
    placed.add(p.number);
  }
  // Before the first heading, the paragraphs outside the sections.
  let listed = !!untitled || !headings.size,
    current: string | null = null;
  for (const block of blocks) {
    const section = headings.get(block);
    if (section) {
      items.push({ item: { kind: "heading", section }, section: null });
      listed = true;
      current = section.section_id;
      continue;
    }
    const heading = own(block, "h1, h2, h3, h4, h5, h6");
    if (heading && !heading.matches(".reading-document-title")) {
      listed = false;
      current = null;
      continue;
    }
    const here = notes.get(block);
    if (here) {
      for (const number of here)
        items.push({ item: { kind: "note", number }, section: current });
      continue;
    }
    if (!listed || !isParagraph(block)) continue;
    const start = Number(block.dataset.byteStart);
    const copy = blockCopy(block, mode);
    items.push({
      item: {
        kind: "plain",
        start,
        paragraph: paragraphOf(port, start, 0),
        html: copy.innerHTML,
      },
      section: current,
    });
  }
  // A note whose paragraph was not found stands at the end of its section.
  for (const p of model.points) {
    if (placed.has(p.number)) continue;
    let at = items.length;
    for (let i = items.length - 1; i >= 0; i--)
      if (
        items[i]!.section === p.section_id ||
        (items[i]!.item.kind === "heading" &&
          (items[i]!.item as { section: LayersModelSection }).section
            .section_id === p.section_id)
      ) {
        at = i + 1;
        break;
      }
    items.splice(at, 0, {
      item: { kind: "note", number: p.number },
      section: p.section_id,
    });
  }
  return items.map((x) => x.item);
}

/**
 * 脉络 (ADR 0073): the full text pressed one step. The author's headings,
 * each with its section's line; every paragraph as its note (a 纲, with its
 * reason) and the sentences it stands on as its 目; a paragraph without a
 * note as it is. A note's figures stand in the margin beside it, in place of
 * their names among its relations (“见 图 8”); a sheet without a margin
 * sets them under the sentences. Each figure once, beside the first note
 * that names it.
 */
export function outlineLeaf(
  model: LayersModel,
  port: LayersPort,
  mode: DocumentTextMode,
  inMargin = false,
  items: readonly OutlineItem[] = outlineItems(model, port, mode, () => null),
): Leaf {
  let column = titleHTML(port),
    side = rulesHTML();
  const figures = new Set<string>();
  const lineHTML = (s: LayersModelSection) => {
    const line = sectionLine(s.line, mode);
    return line
      ? `<p class="rl-sline" data-f="sline:${escape(s.section_id ?? "")}" lang="${langOf(line)}">${richHTML(line)}</p>`
      : "";
  };
  for (const item of items) {
    if (item.kind === "line") {
      column += lineHTML(item.section);
      continue;
    }
    if (item.kind === "heading") {
      const section = item.section;
      const info = section.section_id ? port.section(section.section_id) : null;
      const title =
        (mode !== "original" && info?.translation) || section.title || "";
      const tag = (info?.level ?? 1) <= 1 ? "h2" : "h3";
      column +=
        `<${tag} class="rl-h" data-f="sec:${escape(section.section_id ?? "")}" data-part="${escape(title)}" lang="${langOf(title)}">${headingHTML(title)}</${tag}>` +
        lineHTML(section);
      continue;
    }
    if (item.kind === "plain") {
      column +=
        `<div class="rl-plain" data-start="${item.start}">` +
        (item.paragraph
          ? `<span class="rl-pn"><i>¶${item.paragraph}</i></span>`
          : "") +
        `<div class="rl-plain-t">${item.html}</div></div>`;
      continue;
    }
    const p = model.byNumber.get(item.number);
    if (!p) continue;
    const own = paragraphNo(model, p.number);
    let body = "",
      plates = "";
    p.evidence.forEach((e, i) => {
      if (e.kind === "sentence")
        body += sentenceHTML(
          e,
          `${p.number}:${i}`,
          termsOf(p),
          port,
          mode,
          own,
          i > 0 && !follows(p.evidence[i - 1], e),
        );
    });
    const drawn = new Set<string>();
    for (const n of namedFigures(
      p,
      p.evidence.flatMap((e) => (e.kind === "block" ? [e] : [])),
    )) {
      if (figures.has(n.id)) continue;
      const f = port.figure(n.id);
      if (inMargin && n.kind !== "table") {
        plates += marginPlateHTML(f, n, mode, "rl-mplate", "", "");
        drawn.add(n.id);
      } else if (!n.pointed || !inMargin)
        // A table the note stands on keeps its line under the sentences;
        // one it only points to stays a name among its relations.
        body += figureHTML(f, n.id, n.kind, n.caption, mode, true);
      else continue;
      figures.add(n.id);
    }
    column += gangHTML(model, p, mode, body);
    const rel = relationsHTML(model, p, port, mode, drawn);
    side +=
      `<aside class="rl-pi rl-rel" data-point="${p.number}"><div class="rl-pi-h">` +
      (p.kind
        ? `<span class="rl-pi-kind" data-f="kind:${p.number}">${KIND_NAMES[p.kind]}</span>`
        : "") +
      `</div>${rel ? `<p class="rl-pi-x" data-f="rel:${p.number}">${rel}</p>` : ""}${plates}</aside>`;
  }
  return { column: column + endHTML(model, figures.size), side };
}

const sourceHTML = (
  units: readonly LayersReadUnitRef[],
  port: LayersPort,
  offsetOf: (unitId: string) => number | null,
) =>
  units.length
    ? `<span class="rl-src">${units
        .map((u) => {
          const start = offsetOf(u.unit_id);
          return `<a data-start="${start ?? ""}">¶${paragraphOf(port, start, u.paragraph)}</a>`;
        })
        .join(" ")}</span>`
    : "";
/** The advice with the places it names made into links. */
function adviceHTML(
  text: string,
  places: readonly { text: string | null; target: string }[],
): string {
  const hits: { start: number; end: number; target: string }[] = [];
  for (const place of places) {
    if (!place.text) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(place.text, from);
      if (at < 0) break;
      if (!hits.some((h) => h.start < at + place.text!.length && at < h.end)) {
        hits.push({
          start: at,
          end: at + place.text.length,
          target: place.target,
        });
        break;
      }
      from = at + 1;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let out = "",
    at = 0;
  for (const h of hits) {
    out += `${richHTML(text.slice(at, h.start))}<a data-place="${escape(h.target)}">${escape(text.slice(h.start, h.end))}</a>`;
    at = h.end;
  }
  return out + richHTML(text.slice(at));
}

/**
 * 概览: the 提要; the 纲目, each section with its line and its main notes,
 * each note with the line or the plate it stands on (plates in the margin);
 * the figures the text gives, what the notes hold back, and where to begin
 * reading.
 */
export function overviewLeaf(
  model: LayersModel,
  port: LayersPort,
  mode: DocumentTextMode,
  offsetOf: (segmentId: string) => number | null,
): Leaf {
  const ov = model.overview;
  const section = (name: string, body: string) =>
    `<section class="rl-osec"><h3 class="rl-oh">${name}</h3>${body}</section>`;
  const none = (what: string) =>
    `<p class="rl-none">原文未给出${what ? `：${escape(what)}` : ""}</p>`;
  let column = titleHTML(port),
    side = rulesHTML();
  const summary = words(
    mode,
    ov.summary.text,
    ov.summary.key_terms,
    ov.summary.translation,
  );
  column += section(
    "提要",
    `<p class="rl-ti" lang="${langOf(summary.text)}">${richHTML(summary.text, summary.terms)}</p>`,
  );
  const plates = new Set<string>();
  const primaryHTML = (p: (typeof model.primary)[number]) => {
    let body = "";
    const own = paragraphNo(model, p.number);
    const basis = p.basis;
    // The line is the note's first evidence (ADR 0074): in a translated
    // reading its translated quote, the same evidence among the note's own
    // carrying it; without a translation, the original's quote.
    const evidence = model.byNumber.get(p.number)?.evidence ?? [];
    const same =
      basis.kind === "sentence" && mode !== "original"
        ? evidence.findIndex(
            (e) =>
              e.kind === "sentence" &&
              e.start_utf8 === basis.start_utf8 &&
              e.end_utf8 === basis.end_utf8 &&
              ("translation" in e ? !!e.translation?.text : !!e.translated),
          )
        : -1;
    const sentence = evidence[same];
    if (sentence?.kind === "sentence")
      body = sentenceHTML(
        sentence,
        `${p.number}:${same}`,
        termsOf(p),
        port,
        mode,
        own,
      );
    else if (basis.kind === "sentence")
      body = sentenceHTML(
        basis,
        `${p.number}:basis`,
        termsOf(p),
        port,
        "original",
        own,
      );
    else {
      const f = port.figure(basis.segment_id);
      body = figureHTML(
        f,
        basis.segment_id,
        basis.block_kind,
        basis.caption,
        mode,
        false,
      );
    }
    // The figures the note stands on and the ones it points to (“见 图 8”)
    // stand in the margin beside it, each figure once, whole.
    for (const n of namedFigures(p, basis.kind === "sentence" ? [] : [basis])) {
      if (n.kind === "table" || plates.has(n.id)) continue;
      plates.add(n.id);
      side += marginPlateHTML(
        port.figure(n.id),
        n,
        mode,
        "rl-oplate",
        ` data-point="${p.number}"`,
        numberHTML(p, own, "rl-gang-no"),
      );
    }
    return gangHTML(model, p, mode, body, false);
  };
  // 纲目 (ADR 0073): each section's number, title and line, its main notes under it.
  let notes = `<p class="rl-onote">全文 ${model.points.length} 段，每段一条批语；主干 ${model.primary.length} 段。<a data-layer-go="outline">看全部</a></p>`;
  const shown = new Set<number>();
  for (const s of model.sections) {
    const main = model.primary.filter((p) => p.section_id === s.section_id);
    const info = s.section_id ? port.section(s.section_id) : null;
    const title = (mode !== "original" && info?.translation) || s.title;
    const line = sectionLine(s.line, mode);
    if (!title && !line && !main.length) continue;
    notes +=
      `<p class="rl-osl">` +
      (title
        ? `<span class="rl-osl-h" lang="${langOf(title)}">${headingHTML(title)}</span>`
        : "") +
      (line
        ? `<span class="rl-osl-t" lang="${langOf(line)}">${richHTML(line)}</span>`
        : "") +
      `</p>`;
    for (const p of main) {
      notes += primaryHTML(p);
      shown.add(p.number);
    }
  }
  for (const p of model.primary)
    if (!shown.has(p.number)) notes += primaryHTML(p);
  column += section("纲目", notes);
  column += section(
    "数据",
    ov.data.length
      ? `<table class="rl-dt"><thead><tr><th>量</th><th>数值</th><th>出处</th></tr></thead><tbody>${ov.data
          .map((row) => {
            const quantity =
              (mode !== "original" && row.translation?.quantity) ||
              row.quantity;
            const source =
              row.source.kind === "unit"
                ? (() => {
                    const start = offsetOf(row.source.unit_id);
                    return `<a data-start="${start ?? ""}">¶${paragraphOf(port, start, row.source.paragraph)}</a>`;
                  })()
                : `<a data-fig="${escape(row.source.segment_id)}">${escape(
                    figureName(
                      port.figure(row.source.segment_id),
                      row.source.block_kind,
                      mode,
                    ),
                  )}</a>`;
            return `<tr><td lang="${langOf(quantity)}">${richHTML(quantity)}</td><td class="rl-v">${richHTML(row.value)}</td><td class="rl-s">${source}</td></tr>`;
          })
          .join("")}</tbody></table>`
      : none(""),
  );
  column += section(
    "局限",
    ov.limits.length
      ? `<ul class="rl-ol">${ov.limits
          .map((l) => {
            const text = (mode !== "original" && l.translation?.text) || l.text;
            return `<li lang="${langOf(text)}">${richHTML(text)}${sourceHTML(l.units, port, offsetOf)}</li>`;
          })
          .join("")}</ul>`
      : none(""),
  );
  const advice = ov.advice;
  if (advice.text === null)
    column += section("精读建议", none(advice.not_given ?? ""));
  else {
    const translated = mode !== "original" && !!advice.translation?.text;
    const text = translated ? advice.translation!.text! : advice.text;
    const places = advice.places.map((place, i) => ({
      text: translated ? (advice.translation!.places[i] ?? null) : place.text,
      target: `${place.target.kind}:${place.target.segment_id}`,
    }));
    column += section(
      "精读建议",
      `<p class="rl-ti" lang="${langOf(text)}">${adviceHTML(text, places)}</p>`,
    );
  }
  return { column: column + endHTML(model, 0), side };
}
