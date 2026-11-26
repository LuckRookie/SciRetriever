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
  captionHTML,
  captionParts,
  escape,
  headingHTML,
  langOf,
  numberHTML,
  pointWords,
  richHTML,
  sentenceWords,
  words,
  type LayerFigure,
  type LayersModel,
  type LayersPort,
} from "./model.js";

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

const figureName = (f: LayerFigure | null, kind: string) =>
  f?.label ?? (kind === "table" ? "表" : kind === "scheme" ? "方案" : "图");
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
export const relationsHTML = (p: LayersReadPoint, port: LayersPort) =>
  p.relations
    .map(
      (r) =>
        `<span>${RELATION_NAMES[r.word]} ${r.targets
          .map((t) =>
            t.kind === "point"
              ? `<a data-point="${t.number}">${t.number}</a>`
              : `<a data-fig="${escape(t.segment_id)}">${escape(
                  figureName(port.figure(t.segment_id), t.block_kind),
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
  `<dt class="rl-zhu"><span class="rl-nm">7</span><span class="rl-nm rl-ring">8</span></dt><dd>批语的编号；实心的是全篇主干</dd>` +
  `<dt><b class="rl-kt">朱字</b></dt><dd>被批句子里的要紧字词</dd>` +
  `<dt class="rl-lan">蓝字</dt><dd>读者自己的批注</dd></dl></div>`;
export const endHTML = (model: LayersModel, figures: number) =>
  `<div class="rl-end"><p>批语 ${model.points.length} 条${figures ? `\u3000图表 ${figures} 件` : ""}</p></div>`;
const gangHTML = (p: LayersReadPoint, mode: DocumentTextMode, body: string) => {
  const w = pointWords(p, mode);
  return (
    `<section class="rl-gang${p.primary ? " rl-main" : ""}" data-point="${p.number}">` +
    numberHTML(p, "rl-gang-no", `no:${p.number}`) +
    `<p class="rl-gang-t" data-f="note:${p.number}" lang="${langOf(w.text)}">${richHTML(w.text, w.terms)}</p>` +
    `<div class="rl-mu">${body}</div></section>`
  );
};
/** A sentence evidence as a 目: the author's words, its paragraph in the left margin. */
function sentenceHTML(
  e: Extract<LayersReadEvidence | LayersReadBasis, { kind: "sentence" }>,
  key: string,
  terms: { original: readonly string[]; translation: readonly string[] },
  port: LayersPort,
  mode: DocumentTextMode,
  cut = false,
): string {
  const n = paragraphOf(port, e.start_utf8, e.paragraph);
  const original = `<span lang="${langOf(e.text)}">${richHTML(e.text, terms.original)}</span>`;
  const t =
    "translation" in e && mode !== "original"
      ? sentenceWords(
          e as Extract<LayersReadEvidence, { kind: "sentence" }>,
          mode,
        )
      : null;
  const body =
    t?.translated && mode === "translation"
      ? `<span lang="${langOf(t.text)}">${richHTML(t.text, terms.translation)}</span>`
      : t?.translated && mode === "bilingual"
        ? `${original}<span class="rl-mu-tr" lang="${langOf(t.text)}">${richHTML(t.text, terms.translation)}</span>`
        : original;
  return (
    `<p class="rl-mu-s${cut ? " rl-cut" : ""}" data-ev="${key}" data-f="ev:${key}" ` +
    `data-start="${e.start_utf8}"><span class="rl-pn"><i>¶${n}</i></span>${body}</p>`
  );
}
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
  const name = parts.lead ?? figureName(f, kind);
  const id = escape(segmentId);
  if (!plate || kind === "table")
    return `<p class="rl-mu-s rl-fig"><a data-fig="${id}">${escape(name)}</a><span>${richHTML(parts.rest)}</span></p>`;
  return (
    `<figure class="rl-plate" data-fig="${id}"><img alt="${escape(name)}" data-image="${id}" data-zoom="${id}" data-f="fig:${id}">` +
    `<p class="rl-cap">${captionHTML(name, parts.rest)}</p></figure>`
  );
}
const termsOf = (p: LayersReadPoint) => ({
  original: p.key_terms,
  translation: p.translation?.key_terms ?? [],
});

/** 脉络: every note as a 纲, the author's sentences it stands on as its 目, its figures beneath. */
export function outlineLeaf(
  model: LayersModel,
  port: LayersPort,
  mode: DocumentTextMode,
): Leaf {
  let column = titleHTML(port),
    side = rulesHTML();
  const figures = new Set<string>();
  for (const section of model.sections) {
    if (section.title !== null) {
      const info = section.section_id ? port.section(section.section_id) : null;
      const title = (mode !== "original" && info?.translation) || section.title;
      const tag = (info?.level ?? 1) <= 1 ? "h2" : "h3";
      column += `<${tag} class="rl-h" data-f="sec:${escape(section.section_id ?? "")}" data-part="${escape(title)}" lang="${langOf(title)}">${headingHTML(title)}</${tag}>`;
    }
    for (const number of section.numbers) {
      const p = model.byNumber.get(number);
      if (!p) continue;
      let body = "";
      p.evidence.forEach((e, i) => {
        if (e.kind === "sentence")
          body += sentenceHTML(e, `${p.number}:${i}`, termsOf(p), port, mode);
      });
      for (const e of p.evidence)
        if (e.kind === "block") {
          figures.add(e.segment_id);
          body += figureHTML(
            port.figure(e.segment_id),
            e.segment_id,
            e.block_kind,
            e.caption,
            mode,
            true,
          );
        }
      column += gangHTML(p, mode, body);
      const rel = relationsHTML(p, port);
      side +=
        `<aside class="rl-pi rl-rel" data-point="${p.number}"><div class="rl-pi-h">` +
        (p.kind
          ? `<span class="rl-pi-kind" data-f="kind:${p.number}">${KIND_NAMES[p.kind]}</span>`
          : "") +
        `</div>${rel ? `<p class="rl-pi-x" data-f="rel:${p.number}">${rel}</p>` : ""}</aside>`;
    }
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
 * 概览: the 提要, the main notes with the line or the plate each stands on
 * (plates in the margin), the figures the text gives, what the notes hold
 * back, and where to begin reading.
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
  let notes = `<p class="rl-onote">全文共 ${model.points.length} 条批语，这里是其中 ${model.primary.length} 条主干。<a data-layer-go="outline">看全部</a></p>`;
  for (const p of model.primary) {
    let body = "";
    const basis = p.basis;
    if (basis.kind === "sentence")
      body = sentenceHTML(
        basis,
        `${p.number}:basis`,
        termsOf(p),
        port,
        "original",
        true,
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
      if (basis.block_kind !== "table") {
        const parts = captionParts(f?.caption(mode) ?? basis.caption);
        const name = parts.lead ?? figureName(f, basis.block_kind);
        const id = escape(basis.segment_id);
        side +=
          `<figure class="rl-oplate" data-point="${p.number}" data-fig="${id}"><img alt="${escape(name)}" data-image="${id}" data-zoom="${id}" data-f="fig:${id}">` +
          `<figcaption>${numberHTML(p, "rl-gang-no")}${captionHTML(name, parts.rest)}</figcaption></figure>`;
      }
    }
    notes += gangHTML(p, mode, body);
  }
  column += section("要点", notes);
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
