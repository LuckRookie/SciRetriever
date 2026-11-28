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
  pointLabel,
  pointWords,
  reasonWords,
  richHTML,
  sectionLabel,
  sectionLine,
  sentenceWords,
  words,
  type LayersModel,
  type LayersPort,
  type ReadingLayer,
} from "./model.js";
import { paragraphOf } from "./leaf.js";
import type { ReadLayersPoint } from "./read.js";

/**
 * 导图 (reading-experience 3.3.4): the book's 纲目 drawn as a tree on a
 * fold-out leaf as wide as the desk. A level is a column; a parent stands at
 * the middle of its children. The tree is set again at its real size for
 * every scale, never stretched. A note is read in the panel beside the tree
 * without leaving it.
 */
export interface LayersMap {
  show(mode: DocumentTextMode): void;
  /** Coming from a layer: the note that was being read is marked and shown. */
  arrive(point: number | null): void;
  selected(): number | null;
  destroy(): void;
}
interface MapNode {
  kind: "root" | "sec" | "leaf";
  id: string;
  title?: string;
  /** A section's line's label (节旨的题). */
  label?: string | null;
  depth: number;
  point?: ReadLayersPoint;
  kids: MapNode[];
  up: MapNode | null;
  i: number;
  el?: HTMLElement;
  w: number;
  h: number;
  /** The height it takes, with a section's label under its rule. */
  b: number;
  x: number;
  y: number;
  d: number;
}
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function createMap(
  host: HTMLElement,
  model: LayersModel,
  port: LayersPort,
  hooks: {
    mode(): DocumentTextMode;
    open(layer: ReadingLayer, point: number): void;
    enlarge(segmentId: string): void;
  },
): LayersMap {
  const M = {
    mz: 1,
    ox: 40,
    oy: 40,
    auto: true,
    side: null as number | null,
    lit: null as string | null,
    pin: null as string | null,
    els: [] as MapNode[],
    size: { W: 0, H: 0 },
    fold: new Set<string>(),
    bare: new Set<string>(),
    here: null as number | null,
  };
  let mode = hooks.mode(),
    panned = false,
    wait = 0;
  const $ = <T extends HTMLElement>(s: string) => host.querySelector<T>(s);
  const hasFigure = (p: ReadLayersPoint) =>
    p.evidence.some((e) => e.kind === "block");
  const node = (
    kind: MapNode["kind"],
    id: string,
    depth: number,
    extra: Partial<MapNode> = {},
  ): MapNode => ({
    kind,
    id,
    depth,
    kids: [],
    up: null,
    i: 0,
    w: 0,
    h: 0,
    b: 0,
    x: 0,
    y: 0,
    d: 0,
    ...extra,
  });
  /** The tree: the title, the titled sections by their levels, the notes as leaves. */
  const nodes = (): MapNode => {
    const root = node("root", "root", 0);
    let top: MapNode | null = null;
    model.sections.forEach((s, index) => {
      const leaves = s.numbers
        .map((n) => model.byNumber.get(n))
        .filter((p): p is ReadLayersPoint => !!p)
        .map((p) => node("leaf", `k${p.number}`, 0, { point: p }));
      if (s.title === null) {
        root.kids.push(...leaves);
        return;
      }
      const info = s.section_id ? port.section(s.section_id) : null;
      const title = (mode !== "original" && info?.translation) || s.title;
      const level = info?.level ?? 1;
      const id = s.section_id ?? `s${index}`;
      const label = sectionLabel(s.line, mode);
      if (level <= 1 || !top) {
        top = node("sec", id, 1, { title, label, kids: leaves });
        root.kids.push(top);
      } else top.kids.push(node("sec", id, 2, { title, label, kids: leaves }));
    });
    // A section's own notes stand before its subsections.
    for (const sec of root.kids)
      if (sec.kind === "sec")
        sec.kids = [
          ...sec.kids.filter((k) => k.kind === "leaf"),
          ...sec.kids.filter((k) => k.kind !== "leaf"),
        ];
    return root;
  };
  const leavesIn = (n: MapNode): number =>
    n.kids.reduce((x, k) => x + (k.kind === "leaf" ? 1 : leavesIn(k)), 0);
  const shownKids = (n: MapNode) =>
    n.kind !== "sec"
      ? n.kids
      : M.fold.has(n.id)
        ? []
        : M.bare.has(n.id)
          ? n.kids.filter((k) => k.kind !== "leaf")
          : n.kids;
  const hiddenIn = (n: MapNode) =>
    n.kind !== "sec"
      ? 0
      : M.fold.has(n.id)
        ? leavesIn(n)
        : M.bare.has(n.id)
          ? n.kids.filter((k) => k.kind === "leaf").length
          : 0;

  const applyPad = () => {
    const pad = $(".rl-map-pad"),
      tree = $(".rl-tree");
    if (!pad || !tree) return;
    pad.style.transform = `translate(${Math.round(M.ox)}px, ${Math.round(M.oy)}px)`;
    tree.style.width = `${M.size.W}px`;
    tree.style.height = `${M.size.H}px`;
  };
  const match = (p: ReadLayersPoint, key: string | null) =>
    !key ||
    (key === "primary"
      ? p.primary
      : key === "fig"
        ? hasFigure(p)
        : p.kind === key.slice(5));
  const applyLit = () => {
    const key = M.lit ?? M.pin,
      tree = $(".rl-tree");
    if (!tree) return;
    for (const leaf of tree.querySelectorAll<HTMLElement>(".rl-mn-leaf")) {
      const p = model.byNumber.get(Number(leaf.dataset.leaf));
      leaf.classList.toggle("rl-dim", !!p && !match(p, key));
    }
    for (const path of tree.querySelectorAll<SVGPathElement>("path.rl-twig")) {
      const n = M.els[Number(path.dataset.to)];
      path.classList.toggle("rl-dim", !!n?.point && !match(n.point, key));
    }
    for (const b of host.querySelectorAll<HTMLElement>(".rl-tb[data-lit]"))
      b.setAttribute("aria-pressed", String(M.pin === b.dataset.lit));
  };
  const relations = (p: ReadLayersPoint) =>
    p.relations
      .map(
        (r) =>
          `<span>${RELATION_NAMES[r.word]} ${r.targets
            .map((t) =>
              t.kind === "point"
                ? `<a data-side="${t.number}">¶${paragraphNo(model, t.number, t.paragraph)}</a>`
                : `<a data-zoom="${escape(t.segment_id)}">${escape(
                    figureName(port.figure(t.segment_id), t.block_kind, mode),
                  )}</a>`,
            )
            .join("、")}</span>`,
      )
      .join("");
  const fillImages = (root: ParentNode) => {
    for (const img of root.querySelectorAll<HTMLImageElement>(
      "img[data-image]:not([src])",
    )) {
      const figure = port.figure(img.dataset.image!);
      const drop = () => img.closest("figure")?.remove();
      if (!figure) drop();
      else
        void figure.image().then(
          (url) => {
            if (!img.isConnected) return;
            if (url) img.src = url;
            else drop();
          },
          () => drop(),
        );
    }
  };
  const renderSide = () => {
    const side = $(".rl-map-side");
    if (!side) return;
    const p = M.side === null ? null : (model.byNumber.get(M.side) ?? null);
    const ov = model.overview;
    if (!p) {
      const summary = words(
        mode,
        ov.summary.text,
        ov.summary.key_terms,
        ov.summary.translation,
      );
      side.innerHTML =
        `<p class="rl-ms-sum" lang="${langOf(summary.text)}">${richHTML(summary.text, summary.terms)}</p>` +
        `<ul class="rl-ms-list">${model.primary
          .map((k) => {
            const w = pointWords(k, mode);
            return `<li data-side="${k.number}">${numberHTML(k, paragraphNo(model, k.number), "rl-gang-no")}<span lang="${langOf(w.text)}">${richHTML(w.text, w.terms)}</span></li>`;
          })
          .join("")}</ul>` +
        `<p class="rl-ms-hint">指针移到一段上，这里显示它的批语、被批的句子和图表。</p>`;
      return;
    }
    const w = pointWords(p, mode);
    const reason = reasonWords(p, mode);
    const own = paragraphNo(model, p.number);
    const info = p.section_id ? port.section(p.section_id) : null;
    const where = (
      (mode !== "original" && info?.translation) ||
      p.section_title ||
      ""
    ).replace(/[.。]$/u, "");
    const section = model.sections.find((s) => s.section_id === p.section_id);
    const line = section ? sectionLine(section.line, mode) : null;
    const rel = relations(p);
    side.innerHTML =
      `<div class="rl-ms-h">${numberHTML(p, own, "rl-gang-no")}${p.kind ? `<span>${KIND_NAMES[p.kind]}</span>` : ""}<span class="rl-where">${escape(where)}</span></div>` +
      (line
        ? `<p class="rl-ms-sl" lang="${langOf(line)}">${richHTML(line)}</p>`
        : "") +
      `<p class="rl-ms-t" lang="${langOf(w.text)}">${richHTML(w.text, w.terms)}` +
      (reason
        ? `<span class="rl-reason" lang="${langOf(reason)}">${richHTML(reason)}</span>`
        : "") +
      `</p>` +
      (rel ? `<p class="rl-ms-x">${rel}</p>` : "") +
      `<div class="rl-ms-mu">${p.evidence
        .map((e) => {
          if (e.kind !== "sentence") return "";
          const s = sentenceWords(e, mode);
          const terms = s.translated
            ? (p.translation?.key_terms ?? [])
            : p.key_terms;
          const n = paragraphOf(port, e.start_utf8, e.paragraph);
          // A quote inside its sentence: a faint “…” where it is cut (ADR 0074).
          const cut =
            !s.translated || alignedTranslation(e)
              ? cutClass(evidenceCut(port, e))
              : "";
          return `<p lang="${langOf(s.text)}"><span${cut ? ` class="${cut}"` : ""}>${richHTML(s.text, terms)}</span>${n === own ? "" : `<span class="rl-src">¶${n}</span>`}</p>`;
        })
        .join("")}</div>` +
      p.evidence
        .map((e) => {
          if (e.kind !== "block" || e.block_kind === "table") return "";
          const f = port.figure(e.segment_id);
          const parts = captionParts(f?.caption(mode) ?? e.caption);
          const name = f
            ? figureName(f, e.block_kind, mode)
            : (parts.lead ?? figureName(null, e.block_kind, mode));
          const id = escape(e.segment_id);
          return `<figure class="rl-ms-plate"><img alt="${escape(name)}" data-image="${id}" data-zoom="${id}"><figcaption>${captionHTML(name, parts.rest)}</figcaption></figure>`;
        })
        .join("") +
      `<p class="rl-ms-go"><a data-leave="outline" data-point="${p.number}">到脉络里读</a><a data-leave="full" data-point="${p.number}">到全文里读</a><a data-side="">本文提要</a></p>`;
    fillImages(side);
    side.scrollTop = 0;
  };
  const setSide = (number: number | null) => {
    if (number === M.side) return;
    M.side = number;
    for (const leaf of host.querySelectorAll<HTMLElement>(".rl-mn-leaf"))
      leaf.classList.toggle("rl-sel", Number(leaf.dataset.leaf) === number);
    renderSide();
  };

  const drawTree = () => {
    const tree = $(".rl-tree"),
      view = $(".rl-map-view");
    if (!tree || !view) return;
    const root = nodes(),
      els: MapNode[] = [];
    let html = "";
    const make = (n: MapNode, up: MapNode | null) => {
      n.i = els.length;
      n.up = up;
      if (n.kind === "root")
        html += `<div class="rl-mn rl-mn-root" data-mi="${n.i}" tabindex="0" role="button"><span class="rl-t" lang="${langOf(port.title ?? "")}">${richHTML(port.title ?? "未命名资料")}</span><span class="rl-meta">批语 ${model.points.length} 条</span></div>`;
      else if (n.kind === "sec") {
        const more = hiddenIn(n);
        html +=
          `<div class="rl-mn rl-mn-sec rl-d${n.depth}" data-mi="${n.i}" data-sec="${escape(n.id)}" tabindex="0" role="button" aria-expanded="${!more}" lang="${langOf(n.title ?? "")}">${headingHTML(n.title ?? "")}${more ? `<span class="rl-more">余 ${more} 段</span>` : ""}` +
          (n.label
            ? `<span class="rl-sl" lang="${langOf(n.label)}">${escape(n.label)}</span>`
            : "") +
          `</div>`;
      } else {
        const p = n.point!;
        const label = pointLabel(p, mode);
        html +=
          `<div class="rl-mn rl-mn-leaf${p.primary ? " rl-main" : ""}${M.here === p.number ? " rl-here" : ""}${M.side === p.number ? " rl-sel" : ""}" data-mi="${n.i}" data-leaf="${p.number}" tabindex="0" role="button" ` +
          `aria-label="¶${paragraphNo(model, p.number)}${p.kind ? `（${KIND_NAMES[p.kind]}）` : ""}：${escape(pointWords(p, mode).text)}">` +
          `<span class="rl-no">¶${paragraphNo(model, p.number)}</span><span class="rl-t" lang="${langOf(label)}">${escape(label)}</span>` +
          (hasFigure(p) ? '<span class="rl-hasfig">图</span>' : "") +
          (p.kind ? `<span class="rl-kind">${KIND_NAMES[p.kind]}</span>` : "") +
          `</div>`;
      }
      els.push(n);
      for (const kid of shownKids(n)) make(kid, n);
    };
    make(root, null);
    tree.innerHTML = `<svg></svg>${html}`;
    for (const el of tree.querySelectorAll<HTMLElement>(".rl-mn"))
      els[Number(el.dataset.mi)]!.el = el;
    const lay = (mz: number) => {
      tree.style.setProperty("--mz", String(mz));
      for (const n of els) {
        n.w = n.el!.offsetWidth;
        n.h = n.el!.offsetHeight;
        const label = n.el!.querySelector<HTMLElement>(":scope > .rl-sl");
        n.b = label ? label.offsetTop + label.offsetHeight : n.h;
      }
      const GAP = Math.round(52 * mz),
        colW: number[] = [];
      const widths = (n: MapNode, d: number) => {
        n.d = d;
        colW[d] = Math.max(colW[d] ?? 0, n.w);
        for (const k of shownKids(n)) widths(k, d + 1);
      };
      widths(root, 0);
      const colX: number[] = [];
      let x = 0;
      colW.forEach((w, d) => {
        colX[d] = x;
        x += w + GAP;
      });
      const shift = (n: MapNode, dy: number) => {
        n.y += dy;
        for (const k of shownKids(n)) shift(k, dy);
      };
      const gap = (a: MapNode, b: MapNode) =>
        Math.round(
          (a.kind === "leaf" && b.kind === "leaf"
            ? 5
            : a.depth === 1 || b.depth === 1
              ? 30
              : 18) * mz,
        );
      const put = (n: MapNode, y: number): number => {
        n.x = colX[n.d]!;
        const kids = shownKids(n);
        if (!kids.length) {
          n.y = y;
          return n.b;
        }
        let cy = y;
        kids.forEach((k, i) => {
          cy += put(k, cy);
          if (i < kids.length - 1) cy += gap(k, kids[i + 1]!);
        });
        const a = kids[0]!,
          b = kids.at(-1)!;
        n.y = Math.round((a.y + a.h / 2 + b.y + b.h / 2) / 2 - n.h / 2);
        if (n.y < y) {
          const dy = y - n.y;
          for (const k of kids) shift(k, dy);
          n.y = y;
          cy += dy;
        }
        return Math.max(cy, n.y + n.b) - y;
      };
      return { W: x - GAP, H: put(root, 0) };
    };
    const vw = view.clientWidth,
      vh = view.clientHeight,
      PAD = vw < 1000 ? 24 : 44;
    if (M.auto && vw > 0 && vh > 0) {
      const s1 = lay(1);
      M.mz =
        Math.round(
          clamp(
            Math.min((vw - 2 * PAD - 70) / s1.W, (vh - 2 * PAD) / s1.H),
            0.85,
            1.45,
          ) * 100,
        ) / 100;
      M.size = M.mz === 1 ? s1 : lay(M.mz);
      M.ox = Math.max(PAD, Math.round((vw - 70 - M.size.W) / 2));
      M.oy = Math.max(PAD, Math.round((vh - M.size.H) / 2));
    } else M.size = lay(M.mz);
    let paths = "";
    for (const n of els) {
      n.el!.style.left = `${n.x}px`;
      n.el!.style.top = `${n.y}px`;
      for (const k of shownKids(n)) {
        // A section's line leaves from the rule under its name; a leaf is met at its middle.
        const x1 = n.x + n.w,
          y1 = n.kind === "sec" ? n.y + n.h - 1 : n.y + n.h / 2,
          x2 = k.x - 2,
          y2 = k.kind === "sec" ? k.y + k.h - 1 : k.y + k.h / 2,
          c = Math.max(14, (x2 - x1) * 0.55);
        paths += `<path class="${k.kind === "leaf" ? "rl-twig" : ""}" data-to="${k.i}" d="M${x1} ${y1} C${x1 + c} ${y1} ${x2 - c} ${y2} ${x2} ${y2}"/>`;
      }
    }
    const svg = tree.querySelector("svg")!;
    svg.setAttribute("width", String(M.size.W));
    svg.setAttribute("height", String(M.size.H));
    svg.innerHTML = paths;
    M.els = els;
    applyPad();
    const zoom = $(".rl-map-zoom");
    if (zoom) zoom.textContent = `${Math.round(M.mz * 100)}%`;
    applyLit();
    renderSide();
  };
  const nudge = (dx: number, dy: number) => {
    const view = $(".rl-map-view");
    if (!view) return;
    M.ox = clamp(M.ox + dx, 120 - M.size.W, view.clientWidth - 120);
    M.oy = clamp(M.oy + dy, 120 - M.size.H, view.clientHeight - 120);
    applyPad();
  };
  const zoomMap = (
    f: number,
    cx: number | null = null,
    cy: number | null = null,
  ) => {
    const view = $(".rl-map-view");
    if (!view) return;
    const r = view.getBoundingClientRect();
    const x = cx ?? r.left + r.width / 2,
      y = cy ?? r.top + r.height / 2;
    const z0 = M.mz,
      z1 = clamp(Math.round(z0 * f * 100) / 100, 0.6, 2.2);
    if (z1 === z0) return;
    const px = (x - r.left - M.ox) / z0,
      py = (y - r.top - M.oy) / z0;
    M.auto = false;
    M.mz = z1;
    drawTree();
    M.ox = x - r.left - px * z1;
    M.oy = y - r.top - py * z1;
    nudge(0, 0);
  };
  const foldSection = (id: string) => {
    const find = (n: MapNode): MapNode | null =>
      n.kind === "sec" && n.id === id
        ? n
        : n.kids.reduce<MapNode | null>((f, k) => f ?? find(k), null);
    const n = find(nodes());
    const sel = `.rl-mn-sec[data-sec="${CSS.escape(id)}"]`;
    const before = $(sel)?.getBoundingClientRect();
    if (!n || !before) return;
    if (M.fold.has(id) || M.bare.has(id)) {
      const open = (x: MapNode) => {
        if (x.kind === "sec") {
          M.fold.delete(x.id);
          M.bare.delete(x.id);
        }
        x.kids.forEach(open);
      };
      open(n);
    } else M.fold.add(id);
    const auto = M.auto;
    M.auto = false;
    drawTree();
    M.auto = auto;
    // The node that was pressed stays where it is on the screen.
    const after = $(sel)?.getBoundingClientRect();
    if (after) nudge(before.left - after.left, before.top - after.top);
  };
  const build = () => {
    const used = new Set(model.points.map((p) => p.kind));
    const lit = (key: string, name: string) =>
      `<button type="button" class="rl-tb" data-lit="${key}" aria-pressed="${M.pin === key}">${name}</button>`;
    host.innerHTML =
      `<div class="rl-map-bar"><div class="rl-g"><button type="button" class="rl-tb" data-mm="all">全部展开</button><button type="button" class="rl-tb" data-mm="secs">只看章节</button></div>` +
      `<i class="rl-sep"></i><div class="rl-g"><span class="rl-cap">标出</span>${Object.entries(
        KIND_NAMES,
      )
        .filter(([kind]) => used.has(kind as keyof typeof KIND_NAMES))
        .map(([kind, name]) => lit(`kind:${kind}`, name))
        .join(
          "",
        )}${lit("primary", "主干")}${lit("fig", "有图表")}</div><span class="rl-grow"></span>` +
      `<div class="rl-g"><button type="button" class="rl-tb" data-mz="out">缩小</button><output class="rl-map-zoom">100%</output><button type="button" class="rl-tb" data-mz="in">放大</button><button type="button" class="rl-tb" data-mz="fit">适应窗口</button></div></div>` +
      `<div class="rl-map-view"><div class="rl-map-pad"><div class="rl-tree"></div></div></div><aside class="rl-map-side"></aside>`;
    M.auto = true;
    drawTree();
  };

  // ── the pointer and the keys ──
  const over = (event: Event) => {
    const t = event.target as Element;
    const lt = t.closest<HTMLElement>("[data-lit]");
    const key = lt?.dataset.lit ?? null;
    if (key !== M.lit) {
      M.lit = key;
      applyLit();
    }
    const leaf = t.closest<HTMLElement>(".rl-mn-leaf");
    clearTimeout(wait);
    if (leaf)
      wait = window.setTimeout(() => {
        if (leaf.isConnected) setSide(Number(leaf.dataset.leaf));
      }, 70);
  };
  const focus = (event: Event) => {
    const leaf = (event.target as Element).closest?.<HTMLElement>(
      ".rl-mn-leaf",
    );
    if (leaf) setSide(Number(leaf.dataset.leaf));
  };
  const down = (event: PointerEvent) => {
    const t = event.target as Element;
    const view = t.closest<HTMLElement>(".rl-map-view");
    if (!view || event.button !== 0 || t.closest(".rl-mn")) return;
    const x0 = event.clientX,
      y0 = event.clientY,
      ox0 = M.ox,
      oy0 = M.oy;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      view.classList.add("rl-panning");
      M.ox = ox0;
      M.oy = oy0;
      nudge(ev.clientX - x0, ev.clientY - y0);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      view.classList.remove("rl-panning");
      panned = moved;
      setTimeout(() => {
        panned = false;
      }, 0);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const wheel = (event: WheelEvent) => {
    if (!(event.target as Element).closest?.(".rl-map-view")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.altKey) {
      zoomMap(event.deltaY < 0 ? 1.08 : 1 / 1.08, event.clientX, event.clientY);
      return;
    }
    const k = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 600 : 1;
    nudge(
      -(event.shiftKey ? event.deltaY : event.deltaX) * k,
      event.shiftKey ? 0 : -event.deltaY * k,
    );
  };
  const key = (event: KeyboardEvent) => {
    const at = (event.target as Element).closest?.<HTMLElement>(".rl-mn");
    if (!at) return;
    const n = M.els[Number(at.dataset.mi)];
    if (!n) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (n.kind === "leaf") hooks.open("outline", n.point!.number);
      else if (n.kind === "sec") {
        foldSection(n.id);
        $(`.rl-mn-sec[data-sec="${CSS.escape(n.id)}"]`)?.focus();
      }
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    let to: MapNode | null | undefined = null;
    if (event.key === "ArrowLeft") to = n.up;
    else if (event.key === "ArrowRight") to = shownKids(n)[0];
    else {
      const step = event.key === "ArrowDown" ? 1 : -1,
        sibs = n.up ? shownKids(n.up) : [n];
      to = sibs[sibs.indexOf(n) + step];
      if (!to) {
        const col = M.els.filter((x) => x.d === n.d).sort((a, b) => a.y - b.y);
        to = col[col.indexOf(n) + step];
      }
    }
    if (to?.el) {
      event.preventDefault();
      event.stopPropagation();
      to.el.focus();
    }
  };
  const click = (event: MouseEvent) => {
    if (panned) return;
    const t = event.target as Element;
    const zoom = t.closest<HTMLElement>("[data-zoom]");
    if (zoom) return hooks.enlarge(zoom.dataset.zoom!);
    const side = t.closest<HTMLElement>("[data-side]");
    if (side)
      return setSide(side.dataset.side ? Number(side.dataset.side) : null);
    const leave = t.closest<HTMLElement>("[data-leave]");
    if (leave)
      return hooks.open(
        leave.dataset.leave as ReadingLayer,
        Number(leave.dataset.point),
      );
    const lt = t.closest<HTMLElement>("[data-lit]");
    if (lt) {
      M.pin = M.pin === lt.dataset.lit ? null : (lt.dataset.lit ?? null);
      return applyLit();
    }
    const mz = t.closest<HTMLElement>("[data-mz]");
    if (mz) {
      if (mz.dataset.mz === "fit") {
        M.auto = true;
        drawTree();
      } else zoomMap(mz.dataset.mz === "in" ? 1.15 : 1 / 1.15);
      return;
    }
    const mm = t.closest<HTMLElement>("[data-mm]");
    if (mm) {
      M.fold = new Set();
      M.bare = new Set();
      if (mm.dataset.mm === "secs") {
        const all = (n: MapNode) => {
          if (n.kind === "sec") M.bare.add(n.id);
          n.kids.forEach(all);
        };
        all(nodes());
      }
      M.auto = true;
      return drawTree();
    }
    if (t.closest(".rl-mn-root")) return setSide(null);
    const leaf = t.closest<HTMLElement>(".rl-mn-leaf");
    if (leaf) return hooks.open("outline", Number(leaf.dataset.leaf));
    const sec = t.closest<HTMLElement>(".rl-mn-sec");
    if (sec) foldSection(sec.dataset.sec!);
  };
  host.addEventListener("mouseover", over);
  host.addEventListener("focusin", focus);
  host.addEventListener("pointerdown", down);
  host.addEventListener("wheel", wheel, { passive: false });
  host.addEventListener("keydown", key);
  host.addEventListener("click", click);
  const resized = new ResizeObserver(() => {
    if (!host.hidden && host.firstChild) drawTree();
  });
  resized.observe(host);
  let built = false;
  return {
    show(next) {
      mode = next;
      if (!built) {
        built = true;
        build();
      } else drawTree();
    },
    arrive(point) {
      M.here = point;
      M.side = point;
      if (built) drawTree();
    },
    selected: () => M.side ?? M.here,
    destroy() {
      clearTimeout(wait);
      resized.disconnect();
      host.removeEventListener("mouseover", over);
      host.removeEventListener("focusin", focus);
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("wheel", wheel);
      host.removeEventListener("keydown", key);
      host.removeEventListener("click", click);
      host.replaceChildren();
    },
  };
}
