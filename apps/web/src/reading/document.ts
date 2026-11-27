import {
  type DocumentLayout,
  type DocumentReadingRef,
  type DocumentResource,
  type DocumentReadRequestMap,
  type DocumentReadResultMap,
  type DocumentTranslationResult,
} from "@sciretriever/contracts";
import type { DocumentTextMode, ReadingContext } from "./contract.js";
import type { FixedSource } from "./source.js";
import { button, readerErrorMessage } from "./dom.js";
import type { ReaderFrame, ReadingAnchor } from "./contract.js";
import type { ReadingPosition } from "./state.js";
import {
  forgetDocumentRead,
  readDocument,
  readDocumentTranslation,
  readResourceBytes,
} from "./transport.js";
import { READER_PROBE, probeCount } from "./probe.js";
import {
  anchorRatio,
  placeDelta,
  pdfToText,
  readingArea,
  readingLine,
  textToPdf,
  type TextBlock,
} from "./anchor.js";
import { appendTitle, titleParts } from "./title.js";
import {
  documentMarkdown as markdown,
  markdown as plainMarkdown,
  markdownBlocks,
} from "./markdown.js";

import { blockSourceText } from "./block-text.js";
import {
  captionParts,
  figureNameIn,
  type LayerFigure,
  type LayersPort,
} from "./layers/model.js";
import { readLayers } from "./layers/read.js";
import { attachLayers, type LayersView } from "./layers/view.js";

export async function renderDocument(
  ctx: ReadingContext,
  frame: ReaderFrame,
  state: ReadingPosition,
  ref: DocumentReadingRef,
  source: FixedSource | null,
): Promise<void> {
  const docId = ref.document_version_id;
  const layer = frame.layer ?? frame.body;
  // Off screen: no scroll handling and no scrolling; `show` returns to the place.
  let hidden = !!frame.startHidden,
    // Replaced once the text is laid out; until then only the flag changes.
    onHide = () => {},
    onShow = () => {};
  frame.hide = () => {
    if (hidden) return;
    onHide();
    hidden = true;
  };
  frame.show = () => {
    if (!hidden) return;
    hidden = false;
    onShow();
  };
  const bound = (value: { document: DocumentReadingRef }) => {
    if (JSON.stringify(value.document) !== JSON.stringify(ref))
      throw new Error("文档版本校验失败，未替换为当前默认文档。");
    ctx.signal.throwIfAborted();
  };
  const segments: DocumentReadResultMap["segments"]["segments"][number][] = [];
  let total = 0,
    segmentCursor: string | null = null;
  const extendSegments = async () => {
    const page: DocumentReadResultMap["segments"] = await readDocument(
      ctx,
      "segments",
      {
        document_version_id: docId,
        section_id: null,
        limit: 200,
        cursor: segmentCursor,
      },
    );
    bound(page);
    for (const segment of page.segments) {
      segments.push(segment);
      total = Math.max(total, segment.end_utf8);
    }
    segmentCursor = page.next_cursor;
  };
  // Start with one known contiguous range; discover subsequent segment pages
  // only when reading reaches them. Each continuation stays bound to its range.
  await extendSegments();
  frame.onLoadStep?.("read", { done: segments.length, total: segments.length });
  if (!total) {
    // Spec 3.9: the sheet says there is no readable text.
    frame.onEmpty?.("text");
    return;
  }
  const resources = new Map<string, DocumentResource>();
  let cursor: string | null = null;
  do {
    const page: DocumentReadResultMap["resources"] = await readDocument(
      ctx,
      "resources",
      {
        document_version_id: docId,
        limit: 200,
        cursor,
      },
    );
    bound(page);
    for (const resource of page.resources)
      resources.set(resource.reference, resource);
    cursor = page.next_cursor;
  } while (cursor);
  const askedLanguage = frame.translationLanguage ?? null;
  const described: DocumentReadResultMap["describe"] = await readDocument(
    ctx,
    "describe",
    {
      document_version_id: docId,
      ...(askedLanguage ? { target_language: askedLanguage } : {}),
    },
  );
  bound(described);
  const layout: DocumentLayout | null = described.layout ?? null;
  frame.onLoadStep?.("layout");
  const article = document.createElement("article");
  article.className = "reading-article library-reading-text";
  // Reading-experience 9: the reading asked for, shown when this version has
  // a translation to read; else the original, the choice kept as it was.
  const translationSummary = described.translation ?? null;
  const language = translationSummary?.target_language ?? null;
  let textMode: DocumentTextMode =
    translationSummary?.state === "complete" ||
    translationSummary?.state === "partial"
      ? (frame.textMode ?? "original")
      : "original";
  article.dataset.textMode = textMode;
  // Folded front-page article information (ADR 0054); session state only.
  article.dataset.articleInfo = "collapsed";
  let documentTitle: HTMLElement | null = null;
  if (frame.documentTitle) {
    const title = document.createElement("h1");
    title.className = "reading-document-title";
    title.dataset.origin = "author";
    appendTitle(title, titleParts(frame.documentTitle));
    article.append(title);
    documentTitle = title;
  }
  /** Titles compared as a reader sees them: case, spacing, a final stop aside. */
  const sameTitle = (a: string, b: string) => {
    const plain = (text: string) =>
      text
        .normalize("NFKC")
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/[.。:：]$/u, "")
        .toLowerCase();
    return !!plain(a) && plain(a) === plain(b);
  };
  // Reading-experience 3.4: the text's level; a draft and a long document
  // (ADR 0055) say so above the text, scrolling with it, never dismissed.
  const level = described.text_level ?? "proofread";
  frame.onTextLevel?.(level);
  if (level === "draft" || described.long_document) {
    const note = document.createElement("p");
    note.className = "reading-long-document";
    note.dataset.origin = "machine";
    note.setAttribute("role", "note");
    note.textContent =
      level === "draft"
        ? "全文 · 未校对：文字可能含解析错误；以 PDF 为准"
        : `长文档：按简化流程解析全文，未逐页校对，文字可能含解析错误；以 PDF 为准（${described.long_document!.pages} 页）`;
    article.append(note);
  }
  layer.append(article);
  const urls = new Map<string, string>(),
    inFlight = new Map<string, Promise<string>>();
  const imageUrl = async (resource: DocumentResource): Promise<string> => {
    if (urls.has(resource.resource_id)) return urls.get(resource.resource_id)!;
    const pending = inFlight.get(resource.resource_id);
    if (pending) return pending;
    const read = async () => {
      if (
        !/^image\/(png|jpeg|gif|webp)$/.test(resource.artifact.media_type) ||
        resource.artifact.byte_size > 16 * 1024 * 1024
      )
        throw new Error("此资源不支持内嵌预览");
      const bytes = await readResourceBytes(ctx, ref, resource);
      ctx.signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([bytes], { type: resource.artifact.media_type }),
      );
      if (READER_PROBE) probeCount("objectUrlsCreated");
      urls.set(resource.resource_id, url);
      return url;
    };
    const promise = read();
    inFlight.set(resource.resource_id, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(resource.resource_id);
    }
  };
  frame.onResources?.(
    [...resources.values()].map((resource) => ({
      reference: resource.reference,
      open: async () => {
        const url = await imageUrl(resource);
        ctx.signal.throwIfAborted();
        frame.onImage?.(url, resource.reference);
      },
    })),
  );
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          const el = entry.target as HTMLElement;
          observer.unobserve(el);
          const resource = resources.get(el.dataset.resource!);
          if (!resource) {
            el.textContent = "图片未保存，无法在正文中显示。";
            continue;
          }
          el.textContent = "正在加载图片…";
          el.setAttribute("aria-busy", "true");
          void imageUrl(resource)
            .then(async (url) => {
              if (ctx.signal.aborted || !el.isConnected) return;
              const image = document.createElement("img");
              const label = el.dataset.resourceLabel || "正文图片";
              image.alt = label;
              image.src = url;
              image.decoding = "async";
              // The observer already defers off-screen resources. Decode before
              // replacing the loading message, avoiding a second lazy-load gate.
              try {
                await image.decode();
              } catch {
                throw new Error("图片无法解码，原正文仍可阅读。");
              }
              if (ctx.signal.aborted || !el.isConnected) return;
              if (frame.onImage) {
                image.tabIndex = 0;
                image.setAttribute("role", "button");
                image.setAttribute("aria-label", `放大图片：${label}`);
                image.onclick = () => frame.onImage?.(url, label);
                image.onkeydown = (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    image.click();
                  }
                };
              }
              el.removeAttribute("aria-busy");
              el.replaceChildren(image);
            })
            .catch((error: unknown) => {
              if (!ctx.signal.aborted && el.isConnected) {
                el.removeAttribute("aria-busy");
                el.textContent = readerErrorMessage(
                  error,
                  "图片暂不可读：读取或校验未完成，原正文仍可阅读。",
                );
              }
            });
        }
    },
    { root: frame.body, rootMargin: "300px" },
  );
  let text = "",
    end = 0,
    rangeStart = 0,
    continuation: string | null = null,
    finished = false,
    restoring = true,
    autoFailed = false;
  let pending: Promise<void> | null = null,
    jumpRevision = 0;
  const rendered: { html: string; element: HTMLElement }[] = [];
  const blocks = () => rendered.map((r) => r.element);
  type Unit = DocumentTranslationResult["units"][number];
  /** The stored translation by every segment it covers; null until read. */
  let units: Map<string, Unit> | null = null,
    unitsLoading: Promise<boolean> | null = null;
  const labels = frame.textLabels ?? {
    untranslated: "未译",
    marks: (count: number) => `批注 ${count}`,
    marksAction: (count: number) => `这段有 ${count} 条批注`,
    loadFailed: "译文没有读到，按原文显示。",
  };
  /** Reads the version's translation once; false when it could not be read. */
  const ensureUnits = () => {
    if (units) return Promise.resolve(true);
    unitsLoading ??= readDocumentTranslation(
      ctx,
      docId,
      undefined,
      askedLanguage,
    ).then(
      (list) => {
        const map = new Map<string, Unit>();
        for (const unit of list)
          for (const id of unit.segment_ids) map.set(id, unit);
        units = map;
        return true;
      },
      () => {
        unitsLoading = null;
        if (!ctx.signal.aborted) frame.onNote?.(labels.loadFailed);
        return false;
      },
    );
    return unitsLoading;
  };
  /** The first segment starting at or after `offset` (segments are in text order). */
  const segmentFrom = (offset: number) => {
    let low = 0,
      high = segments.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (segments[mid]!.start_utf8 < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  /** The translation units a block holds: those whose first segment starts in it. */
  const unitsOf = (el: HTMLElement): Unit[] => {
    if (!units) return [];
    const start = Number(el.dataset.byteStart),
      end = Number(el.dataset.byteEnd),
      found: Unit[] = [];
    for (
      let i = segmentFrom(start);
      i < segments.length && segments[i]!.start_utf8 < end;
      i++
    ) {
      const unit = units.get(segments[i]!.segment_id);
      if (unit && unit.unit_id === segments[i]!.segment_id) found.push(unit);
    }
    return found;
  };
  let markCounts: ReadonlyMap<number, number> = new Map();
  /**
   * Spec 9: in the translation reading a paragraph with marks shows a sign in
   * the right margin; pressing it switches to 对照 at that paragraph.
   */
  const decorateMarks = (el: HTMLElement) => {
    el.querySelector(":scope > .reading-translation-marks")?.remove();
    const count =
      textMode === "translation" && el.dataset.translation === "done"
        ? (markCounts.get(Number(el.dataset.byteStart)) ?? 0)
        : 0;
    if (!count) return;
    const sign = document.createElement("button");
    sign.type = "button";
    sign.className = "reading-translation-marks";
    sign.dataset.origin = "machine";
    sign.textContent = labels.marks(count);
    sign.setAttribute("aria-label", labels.marksAction(count));
    const start = Number(el.dataset.byteStart);
    sign.onclick = () => void frame.revealInBilingual?.(start);
    el.append(sign);
  };
  /**
   * A caption's translation names its figure as the layers do: from the
   * original's number in the reading language's way (layers/model.ts
   * `figureNameIn`). A machine translation keeps some leads in English
   * (“Fig. 2.”) and writes others with or without a space (“图4.”); only
   * that lead is rewritten, as shown. The stored translation is unchanged.
   */
  const captionTranslation = (el: HTMLElement, translation: string) => {
    if (!layout || !language) return translation;
    const start = Number(el.dataset.byteStart),
      end = Number(el.dataset.byteEnd);
    const group = layout.figure_groups.find((g) =>
      g.captions.some((c) => c.start_utf8 < end && c.end_utf8 > start),
    );
    if (!group) return translation;
    const lead = captionParts(blockSourceText(el, false)).lead;
    const own = captionParts(translation).lead;
    const name = figureNameIn(group.kind, lead, own, language, "translation");
    if (!own || !name || own === name) return translation;
    const at = translation.indexOf(own);
    return at < 0
      ? translation
      : translation.slice(0, at) + name + translation.slice(at + own.length);
  };
  /**
   * Spec 9: a block's translation below its own text. Which of the two shows
   * is the article's reading (CSS); a translatable block without its
   * translation is marked “未译”, what is never translated stays as it is.
   */
  const decorateTranslation = (el: HTMLElement) => {
    for (const old of el.querySelectorAll(
      ":scope > .reading-translation, :scope > .reading-untranslated",
    ))
      old.remove();
    delete el.dataset.translation;
    if (textMode !== "original" && units) {
      const found = unitsOf(el);
      const done = found.filter((unit) => unit.translation !== null);
      if (found.length) {
        el.dataset.translation =
          done.length === found.length ? "done" : "missing";
        if (done.length) {
          const box = document.createElement("div");
          box.className = "reading-translation";
          box.dataset.origin = "machine";
          if (language) box.lang = language;
          const heading = el.querySelector(
            ":scope > :is(h1, h2, h3, h4, h5, h6)",
          );
          for (const unit of done) {
            if (heading) {
              // A heading's translation is a heading of its own, not an h* tag:
              // links, the outline and the sections find the author's only.
              const level = heading.tagName.slice(1);
              const title = document.createElement("p");
              title.className = "reading-translation-heading";
              title.dataset.level = level;
              title.setAttribute("role", "heading");
              title.setAttribute("aria-level", level);
              title.innerHTML = plainMarkdown.parseInline(unit.translation!, {
                async: false,
              }) as string;
              box.append(title);
            } else
              box.insertAdjacentHTML(
                "beforeend",
                plainMarkdown.parse(captionTranslation(el, unit.translation!), {
                  async: false,
                }) as string,
              );
          }
          el.append(box);
        }
        if (el.dataset.translation === "missing") {
          const label = document.createElement("span");
          label.className = "reading-untranslated";
          label.dataset.origin = "machine";
          label.textContent = labels.untranslated;
          el.prepend(label);
        }
      }
    }
    decorateMarks(el);
  };
  /** Index of the first rendered block for which `after` holds; blocks are in document order. */
  const search = (after: (block: HTMLElement) => boolean) => {
    let low = 0,
      high = rendered.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (after(rendered[mid]!.element)) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const folded = (block: HTMLElement) =>
    article.dataset.articleInfo === "collapsed" &&
    block.classList.contains("reading-article-info");
  // Synchronous on purpose: a jump into folded text unfolds before measuring.
  const infoToggle = document.createElement("button");
  infoToggle.type = "button";
  infoToggle.className = "reading-article-info-toggle";
  infoToggle.textContent = "文章信息";
  infoToggle.setAttribute("aria-expanded", "false");
  const setInfoOpen = (open: boolean) => {
    article.dataset.articleInfo = open ? "open" : "collapsed";
    infoToggle.setAttribute("aria-expanded", String(open));
  };
  infoToggle.onclick = () =>
    setInfoOpen(article.dataset.articleInfo !== "open");
  const overlaps = (
    r: { start_utf8: number; end_utf8: number },
    start: number,
    end: number,
  ) => r.start_utf8 < end && r.end_utf8 > start;
  /** Presentation from the structure's byte ranges; the Markdown carries no markers. */
  /**
   * Reading-experience 2.2–2.4, presentation only (the text is unchanged):
   * a heading's own number apart, “表 1”/“图 2” set bold, numbers in tables
   * to the right, paragraphs without Chinese set as Latin, values with
   * their units kept on one line, and the author's text marked as such.
   */
  const typeset = (el: HTMLElement) => {
    el.dataset.origin = "author";
    for (const heading of el.querySelectorAll(
      ":scope > :is(h1, h2, h3, h4, h5, h6)",
    ))
      wrapLead(
        heading,
        /^\s*((?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+)/u,
        "reading-heading-number",
        true,
      );
    if (el.classList.contains("reading-figure-caption"))
      for (const p of el.querySelectorAll("p"))
        wrapLead(
          p,
          /^\s*((?:表|图|Table|Fig\.?|Figure|Scheme)\s*[S]?\d+[a-z]?[.:：]?)/iu,
          "reading-caption-label",
        );
    for (const cell of el.querySelectorAll("td"))
      if (
        /^[\s\d.,±+\-−–%()×eE^]*\d[\s\d.,±+\-−–%()×eE^]*$/u.test(
          cell.textContent ?? "",
        )
      )
        cell.dataset.numeric = "";
    for (const p of el.querySelectorAll<HTMLElement>(":scope > p"))
      if (
        !/[\u3400-\u9fff]/u.test(p.textContent ?? "") &&
        /[A-Za-z]/u.test(p.textContent ?? "")
      )
        p.dataset.script = "latin";
    keepUnits(el);
  };
  const decorate = (el: HTMLElement, start: number, end: number) => {
    if (!layout) return;
    if (layout.article_info.some((r) => overlaps(r, start, end)))
      el.classList.add("reading-article-info");
    if (layout.footnotes.some((r) => overlaps(r, start, end)))
      el.classList.add("reading-footnote");
    for (const group of layout.figure_groups) {
      const objects = group.objects.filter((o) => overlaps(o, start, end));
      if (objects.length === 1 && group.objects.length > 1) {
        const object = objects[0]!;
        el.classList.add("reading-figure-cell");
        el.style.setProperty(
          "--figure-columns",
          String(Math.max(1, group.rows[object.row] ?? 1)),
        );
        if (object.column === 0) el.dataset.figureRowStart = "true";
      }
      if (group.captions.some((c) => overlaps(c, start, end)))
        el.classList.add("reading-figure-caption");
    }
  };
  /** Spec 4.1: 28% down the visible desk, below the page header. */
  const line = () => readingLine(readingArea(frame.body, frame.header));
  const blockAt = (offset: number) =>
    rendered[search((b) => Number(b.dataset.byteEnd) > offset)]?.element ??
    blocks().at(-1);
  /** A point held in place while the reading size changes (spec 4.2). */
  let held: { el: HTMLElement; ratio: number; y: number } | null = null;
  frame.holdPoint = (point) => {
    if (!point) {
      if (!held) return;
      held = null;
      capture();
      return;
    }
    let at = Math.min(
      rendered.length - 1,
      search((b) => b.getBoundingClientRect().bottom > point.y),
    );
    while (at < rendered.length - 1 && folded(rendered[at]!.element)) at++;
    const el = rendered[at]?.element;
    if (!el) return;
    held = {
      el,
      ratio: anchorRatio(el.getBoundingClientRect(), point.y),
      y: point.y,
    };
  };
  /** The anchor block (spec 4.1) and its top on screen, as last measured. */
  let kept: { el: HTMLElement; top: number; area: number } | null = null;
  /** Another reading layer shows in the sheet: the full text keeps its place as it was. */
  let layerAway = false,
    layersView: LayersView | null = null;
  const capture = (closing = false) => {
    if (
      restoring ||
      hidden ||
      layerAway ||
      (!closing && ctx.signal.aborted) ||
      !frame.body.isConnected ||
      frame.body.clientHeight === 0
    )
      return;
    const y = line();
    // Folded article information has no height; take the next visible block.
    let at = Math.min(
      rendered.length - 1,
      search((b) => b.getBoundingClientRect().bottom > y),
    );
    while (at < rendered.length - 1 && folded(rendered[at]!.element)) at++;
    const block = rendered[at]?.element;
    if (block) {
      const box = block.getBoundingClientRect();
      state.textOffset = Number(block.dataset.byteStart);
      state.blockOffset = anchorRatio(box, y);
      kept = {
        el: block,
        top: box.top,
        area: frame.body.getBoundingClientRect().top,
      };
    }
    state.loadedEnd = end;
    state.scroll = frame.body.scrollTop;
    if (block) frame.onPosition?.(state.textOffset);
    frame.onAnchor?.();
  };
  /**
   * Spec 4.2: whatever changed a size (font, panel, window, find bar, a picture,
   * more text), the anchor block goes back to where it was in the same frame,
   * before paint. Not left to the browser's `overflow-anchor`.
   */
  const keep = () => {
    if (layerAway) return;
    if (held && !hidden && !restoring && held.el.isConnected) {
      // A change of reading size keeps the point under the pointer (spec 1.8.1).
      const box = held.el.getBoundingClientRect();
      const delta = box.top + held.ratio * box.height - held.y;
      if (Math.abs(delta) >= 0.5) frame.body.scrollTop += delta;
      return;
    }
    if (!kept || hidden || restoring || !kept.el.isConnected) return;
    const delta = kept.el.getBoundingClientRect().top - kept.top;
    if (Math.abs(delta) >= 0.5) frame.body.scrollTop += delta;
    // The block kept its top; where the reading line falls in it may have changed.
    capture();
  };
  /**
   * Puts the `ratio` point of the block holding `offset` on the reading line;
   * a jump back glides within a screen, further lands and flashes (spec 4.4).
   */
  const place = (offset: number, ratio = 0, jumped = false) => {
    if (hidden) {
      state.textOffset = offset;
      state.blockOffset = ratio;
      return;
    }
    const block = blockAt(offset);
    if (!block) return;
    if (folded(block)) setInfoOpen(true);
    const delta = placeDelta(block.getBoundingClientRect(), ratio, line());
    if (
      jumped &&
      frame.animateNavigation?.() &&
      Math.abs(delta) <= frame.body.clientHeight
    ) {
      frame.body.scrollTo({
        top: frame.body.scrollTop + delta,
        behavior: "smooth",
      });
      return;
    }
    frame.body.scrollTop += delta;
    if (jumped) flash(block);
    capture();
  };
  /** A jump (outline, link): near the top; within a screen it glides, further it lands and flashes. */
  const go = (offset: number, ratio = 0, animate = false) => {
    // A jump into the text from another layer shows the full text first.
    if (layerAway) layersView?.setLayer("full", { point: null, instant: true });
    if (hidden) {
      state.textOffset = offset;
      state.blockOffset = ratio;
      return;
    }
    const block = blockAt(offset);
    if (block && folded(block)) setInfoOpen(true);
    if (block) {
      // Just below the page header (spec 1.2), which stays over the text.
      const delta =
        block.getBoundingClientRect().top -
        readingArea(frame.body, frame.header).top +
        ratio * block.clientHeight -
        12;
      if (
        animate &&
        frame.animateNavigation?.() &&
        Math.abs(delta) <= frame.body.clientHeight
      )
        frame.body.scrollTo({
          top: frame.body.scrollTop + delta,
          behavior: "smooth",
        });
      else {
        frame.body.scrollTop += delta;
        if (animate) flash(block);
      }
    }
  };
  /**
   * The target block's `--sel` ground fades once (spec 4.4): set at once,
   * then from the next frame a colour transition takes it back.
   */
  const flash = (block: HTMLElement) => {
    block.classList.remove("reading-jump-fading");
    block.classList.add("reading-jump-flash");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        block.classList.add("reading-jump-fading");
        block.classList.remove("reading-jump-flash");
        const done = (event: TransitionEvent) => {
          if (
            event.target !== block ||
            event.propertyName !== "background-color"
          )
            return;
          block.classList.remove("reading-jump-fading");
          block.removeEventListener("transitionend", done);
        };
        block.addEventListener("transitionend", done);
      }),
    );
  };
  // The anchor keeper above restores the place; there is nothing to redo after a layout change.
  frame.beforeLayout = () => () => {};
  const regionOf = (el: HTMLElement | undefined) => {
    const parts = el?.dataset.region?.split(",").map(Number);
    return parts?.length === 4 && parts.every(Number.isFinite)
      ? (parts as [number, number, number, number])
      : null;
  };
  /** The anchor of the rendered block at `at`, `ratio` down it. */
  const anchorOf = (
    at: number,
    start: number,
    ratio: number,
  ): ReadingAnchor => {
    const el = rendered[at]?.element;
    return {
      kind: "doc",
      start,
      ratio,
      label: at >= 0 ? `¶${at + 1}` : "",
      page: el?.dataset.page ? Number(el.dataset.page) : null,
      region: regionOf(el),
      text: el ? blockSourceText(el, false).slice(0, 240) : "",
      pdf:
        at >= 0
          ? textToPdf(
              rendered.map(({ element }) => ({
                start: Number(element.dataset.byteStart),
                page: element.dataset.page
                  ? Number(element.dataset.page)
                  : null,
                region: regionOf(element),
              })),
              at,
            )
          : null,
    };
  };
  frame.anchor = () =>
    anchorOf(
      rendered.findIndex(
        (r) => Number(r.element.dataset.byteStart) === state.textOffset,
      ),
      state.textOffset,
      state.blockOffset,
    );
  frame.anchorAt = (offset) => {
    const at = search((b) => Number(b.dataset.byteEnd) > offset);
    const el = rendered[at]?.element;
    if (!el) return null;
    const start = Number(el.dataset.byteStart),
      end = Number(el.dataset.byteEnd);
    return anchorOf(
      at,
      start,
      end > start
        ? Math.min(1, Math.max(0, (offset - start) / (end - start)))
        : 0,
    );
  };
  frame.isVisible = (anchor) => {
    if (anchor.kind !== "doc" || hidden) return false;
    const el = blockAt(anchor.start);
    if (!el) return false;
    const box = el.getBoundingClientRect(),
      area = frame.body.getBoundingClientRect();
    return box.bottom > area.top && box.top < area.bottom;
  };
  /** Spec 9 and 4.2: another reading of the same text, the anchor block where it was. */
  let modeAsked = 0;
  frame.setTextMode = async (mode) => {
    const asked = ++modeAsked;
    if (mode !== "original" && !(await ensureUnits())) return false;
    if (asked !== modeAsked || ctx.signal.aborted || mode === textMode)
      return false;
    capture();
    textMode = mode;
    article.dataset.textMode = mode;
    for (const block of blocks()) decorateTranslation(block);
    layersView?.setText(mode);
    layersView?.painted();
    keep();
    // Marks find their places again, and their notes are measured anew.
    frame.onDocumentPaint?.();
    return true;
  };
  frame.revealInBilingual = async (start) => {
    frame.beforeJump?.();
    await frame.setTextMode!("bilingual");
    frame.onTextMode?.("bilingual");
    place(start, 0, true);
  };
  frame.translationOf = async (block) => {
    if (!(await ensureUnits())) return null;
    const found = unitsOf(block).flatMap((unit) =>
      unit.translation === null ? [] : [unit.translation],
    );
    return found.length ? found.join("\n\n") : null;
  };
  frame.markBlocks = (counts) => {
    markCounts = counts;
    for (const block of blocks()) decorateMarks(block);
  };
  const onScroll = () => {
    if (hidden || layerAway) return;
    capture();
    void prefetch();
  };
  frame.body.addEventListener("scroll", onScroll, { passive: true });
  ctx.signal.addEventListener(
    "abort",
    () => {
      capture(true);
      observer.disconnect();
      continuationObserver.disconnect();
      frame.body.removeEventListener("scroll", onScroll);
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
        if (READER_PROBE) probeCount("objectUrlsRevoked");
      }
      urls.clear();
      inFlight.clear();
      text = "";
      article.replaceChildren();
      rendered.length = 0;
    },
    { once: true },
  );
  const tail = document.createElement("div");
  tail.className = "reading-continuation";
  const more = button("重试加载正文", async () => {
    autoFailed = false;
    await append();
    void prefetch();
  });
  more.id = "reader-load-more";
  more.hidden = true;
  layer.append(tail, more);
  const wireDocumentLinks = () => {
    // Only an explicit fragment link resolving to a rendered Markdown heading
    // is navigable. Bare reference numbers and unverified PDF page maps stay text.
    const headings = new Map<string, HTMLElement>();
    const occurrences = new Map<string, number>();
    for (const heading of article.querySelectorAll<HTMLElement>(
      "section h1,section h2,section h3,section h4,section h5,section h6",
    )) {
      const slug = (heading.textContent ?? "")
        .trim()
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/\s/g, "-");
      const occurrence = occurrences.get(slug) ?? 0;
      occurrences.set(slug, occurrence + 1);
      headings.set(occurrence ? `${slug}-${occurrence}` : slug, heading);
    }
    for (const link of article.querySelectorAll<HTMLAnchorElement>(
      "a[data-reading-fragment]:not([data-reading-wired])",
    )) {
      let fragment = link.dataset.readingFragment!;
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        /* Invalid escapes cannot resolve. */
      }
      const heading = headings.get(fragment);
      link.onclick = (event) => event.preventDefault();
      if (!heading) {
        link.onmouseenter = null;
        link.onfocus = null;
        link.title = "目标尚未加载或无法核对，未推测引用位置";
        link.setAttribute("aria-disabled", "true");
        continue;
      }
      link.removeAttribute("aria-disabled");
      // A resolved link keeps its target; later chunks only add headings.
      link.dataset.readingWired = "";
      const section = heading.closest<HTMLElement>("[data-byte-start]")!;
      const snippets = [section.textContent ?? ""];
      let next = section.nextElementSibling;
      while (
        next &&
        !next.querySelector("h1,h2,h3,h4,h5,h6") &&
        snippets.join("\n").length < 1200
      ) {
        snippets.push(next.textContent ?? "");
        next = next.nextElementSibling;
      }
      const preview = {
        anchor: link,
        title: heading.textContent ?? "文内引用",
        text: snippets.join("\n").slice(0, 1200),
        activate: () => {
          ++jumpRevision;
          frame.beforeJump?.();
          go(Number(section.dataset.byteStart), 0, true);
        },
      };
      link.title = preview.text;
      const show = () => {
        // A late outline must not scroll away from a preview the user opened.
        ++jumpRevision;
        frame.onDocumentLink?.(preview);
      };
      link.onmouseenter = show;
      link.onfocus = show;
      link.onclick = (event) => {
        event.preventDefault();
        if (frame.onDocumentLink) show();
        else preview.activate();
      };
    }
  };
  // Blocks before this point are settled: later bytes cannot change them, so
  // each new chunk lexes and renders only the text after it.
  let settled = { index: 0, bytes: 0, count: 0 };
  /** Paints new text; returns where the first replaced block started (Infinity when it only appended). */
  const paint = () => {
    let index = settled.count,
      changed = Infinity;
    const fresh = markdownBlocks(
      text.slice(settled.index),
      settled.bytes,
    ).filter((block) => block.token.type !== "space");
    for (const block of fresh) {
      const html = markdown.parser([block.token]);
      const previous = rendered[index];
      // Keep stable DOM (including decoded images and tables) when more bytes
      // arrive. Reparse the tail so Markdown crossing a read boundary recovers.
      if (
        previous &&
        previous.html === html &&
        previous.element.dataset.byteStart === String(block.start) &&
        previous.element.dataset.byteEnd === String(block.end)
      ) {
        index++;
        continue;
      }
      const el = document.createElement("section");
      el.dataset.byteStart = String(block.start);
      el.dataset.byteEnd = String(block.end);
      el.innerHTML = html;
      decorate(el, block.start, block.end);
      typeset(el);
      // Spec 3.4: a paragraph's number in the left margin, as “↩ 回到 ¶n” counts.
      if (el.firstElementChild?.tagName === "P" && !el.classList.length)
        el.dataset.paragraph = String(index + 1);
      const segment = segments.find(
        (s) => s.start_utf8 < block.end && s.end_utf8 > block.start,
      );
      // The segment's one-based PDF page (the reader's public page, as read)
      // and region: where marks and the reading position find it in the PDF.
      if (segment && typeof segment.page === "number") {
        el.dataset.page = String(segment.page);
        if (segment.region) el.dataset.region = segment.region.join(",");
      }
      // A draft segment that agrees with the PDF's own text carries nothing:
      // only differences and segments with nothing to check are marked
      // (plan 25 block 30).
      if (segment && frame.onSegment && segment.basis !== "text-layer-match") {
        const source = document.createElement("button");
        source.className = "reading-block-source";
        source.type = "button";
        source.textContent =
          (
            {
              "text-layer": "对照 PDF 自带的文字",
              "image-only": "原图核对",
              manual: "人工核对",
              // A draft's three (technical 04 §8.3).
              "text-layer-match": "和 PDF 自带的文字一致",
              "text-layer-differs": "和 PDF 自带的文字不一样",
              "no-text-layer": "没有 PDF 自带的文字可以对照",
            } as Record<string, string>
          )[segment.basis ?? ""] ?? "查看来源";
        if (segment.locate === "page") source.textContent += " · 仅页级定位";
        source.setAttribute(
          "aria-label",
          `查看区块来源：${source.textContent}`,
        );
        source.onclick = () =>
          frame.onSegment?.(
            segment.segment_id,
            level === "draft" && typeof segment.page === "number"
              ? segment.page
              : undefined,
          );
        el.prepend(source);
      }
      // Reading-experience 2.5: a doubtful draft segment is marked in the
      // left margin; its saved differences open from “疑点”.
      if (
        segment &&
        (segment.basis === "text-layer-differs" ||
          segment.basis === "no-text-layer")
      ) {
        const differs = segment.basis === "text-layer-differs";
        const mark = document.createElement(differs ? "button" : "span");
        mark.className = "reading-doubt";
        mark.dataset.origin = "machine";
        mark.textContent = differs ? "疑点" : "无自带文字";
        if (mark instanceof HTMLButtonElement) {
          mark.type = "button";
          mark.setAttribute("aria-haspopup", "dialog");
          mark.onclick = () => frame.onDoubt?.(mark, segment.segment_id);
        }
        el.dataset.basis = segment.basis;
        el.prepend(mark);
      }
      if (frame.documentTitle) {
        for (const heading of el.querySelectorAll("h1,h2,h3,h4,h5")) {
          const presentation = document.createElement(
            `h${Number(heading.tagName.slice(1)) + 1}`,
          );
          presentation.replaceChildren(...heading.childNodes);
          heading.replaceWith(presentation);
        }
      }
      // Plan 25 block 30: the text's first heading the same as the paper's
      // title is printed once — the heading, in the title's place and size.
      const heading = el.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6");
      if (
        documentTitle &&
        heading &&
        !rendered
          .slice(0, index)
          .some((r) => r.element.querySelector("h1,h2,h3,h4,h5,h6"))
      ) {
        const same = sameTitle(
          heading.textContent ?? "",
          documentTitle.textContent ?? "",
        );
        if (same) heading.classList.add("reading-document-title");
        documentTitle.hidden = same;
      }
      if (
        source?.kind === "document" &&
        source.start_utf8 < block.end &&
        source.end_utf8 > block.start
      )
        el.classList.add("reading-evidence");
      for (const table of el.querySelectorAll("table")) {
        const wrap = document.createElement("div");
        wrap.className = "reading-table";
        table.before(wrap);
        wrap.append(table);
      }
      decorateTranslation(el);
      if (previous) {
        changed = Math.min(changed, Number(previous.element.dataset.byteStart));
        for (const resource of previous.element.querySelectorAll(
          "[data-resource]",
        ))
          observer.unobserve(resource);
        previous.element.replaceWith(el);
      } else article.append(el);
      rendered[index++] = { html, element: el };
      for (const resource of el.querySelectorAll<HTMLElement>(
        "[data-resource]",
      ))
        observer.observe(resource);
    }
    for (const previous of rendered.splice(index)) {
      changed = Math.min(changed, Number(previous.element.dataset.byteStart));
      for (const resource of previous.element.querySelectorAll(
        "[data-resource]",
      ))
        observer.unobserve(resource);
      previous.element.remove();
    }
    // Markdown crossing a read boundary recovers from the last blocks, so they
    // stay open until more text follows them.
    const open = finished ? 0 : 2;
    if (fresh.length > open) {
      const last = fresh[fresh.length - open - 1]!;
      settled = {
        index: settled.index + last.index,
        bytes: last.end,
        count: settled.count + fresh.length - open,
      };
    }
    const firstInfo = article.querySelector(".reading-article-info");
    if (firstInfo && firstInfo.previousElementSibling !== infoToggle)
      firstInfo.before(infoToggle);
    wireDocumentLinks();
    more.hidden = true;
    tail.hidden = finished;
    tail.textContent = finished ? "" : "继续向下阅读，正文将自动加载";
    frame.onIssue?.(null);
    ctx.root.dataset.readingReady = "true";
    layersView?.painted();
    frame.onDocumentPaint?.();
    return changed;
  };
  const loadChunk = async () => {
    more.disabled = true;
    tail.textContent = "正在加载后续正文…";
    let request: DocumentReadRequestMap["slice"] | null = null;
    try {
      if (!continuation && segmentCursor && end === total) {
        rangeStart = end;
        await extendSegments();
      }
      request = {
        document_version_id: docId,
        selector: { kind: "range", start_utf8: rangeStart, end_utf8: total },
        max_bytes: 65536,
        continuation,
      };
      const result = await readDocument(ctx, "slice", request);
      bound(result);
      if (
        !result.actual_range ||
        result.actual_range.start_utf8 !== end ||
        result.actual_range.end_utf8 <= end
      )
        throw new Error("正文续读范围不连续");
      const nextEnd = result.actual_range.end_utf8;
      if (nextEnd > total) throw new Error("正文续读超出固定范围");
      if (!result.continuation && nextEnd !== total)
        throw new Error("正文尚未完整，缺少续读游标");
      if (result.continuation && nextEnd === total)
        throw new Error("完整正文范围不应仍有续读游标");
      // Commit progress only after all range checks, so a rejected response
      // cannot poison the cursor or make an explicit retry a no-op.
      text += result.text;
      end = nextEnd;
      continuation = result.continuation;
      finished = !continuation && !segmentCursor;
      capture();
      const offset = state.textOffset,
        ratio = state.blockOffset;
      // Text above a replaced block keeps its place; only a reader inside the
      // replaced tail needs to be put back (measuring forces a full layout).
      const changed = paint();
      if (!restoring && offset >= changed) place(offset, ratio);
      state.loadedEnd = end;
    } catch (error) {
      // A rejected read must not be served again from the session cache.
      if (request) forgetDocumentRead("slice", request);
      if (!ctx.signal.aborted) {
        autoFailed = true;
        more.hidden = !!frame.onIssue;
        // The notice gives the reason in words; the internal cause goes to
        // its technical details.
        const detail = error instanceof Error ? error.message : String(error);
        frame.onIssue?.(
          /续读/u.test(detail)
            ? "正文续读位置失效，请重新打开。"
            : readerErrorMessage(error, "正文无法完成读取或校验，请重试。"),
          async () => {
            autoFailed = false;
            await append();
            void prefetch();
          },
          { retained: "加载暂停，已读正文保留。", detail },
        );
        tail.hidden = false;
        tail.textContent = "加载暂停，已读正文保留。请重试。";
      }
      throw error;
    } finally {
      more.disabled = false;
    }
  };
  const load = (): Promise<void> => {
    if (pending) return pending;
    if (finished) return Promise.resolve();
    pending = loadChunk().finally(() => {
      pending = null;
    });
    return pending;
  };
  const append = async () => {
    await load();
  };
  let prefetching = false;
  const prefetch = async () => {
    if (
      prefetching ||
      hidden ||
      restoring ||
      autoFailed ||
      finished ||
      ctx.signal.aborted
    )
      return;
    prefetching = true;
    try {
      while (
        !finished &&
        !autoFailed &&
        !ctx.signal.aborted &&
        tail.getBoundingClientRect().top <
          frame.body.getBoundingClientRect().bottom + 800
      ) {
        await append();
      }
    } catch {
      // loadChunk publishes the recoverable failure. Only explicit retry resumes.
    } finally {
      prefetching = false;
    }
  };
  // Leaving keeps the anchor block's distance from the top; coming back puts it there again.
  let left: { el: HTMLElement; offset: number } | null = null;
  // Measured when last read, not now: by the time a view is left, the scroll
  // area may already carry the next view's padding.
  onHide = () => {
    left = kept ? { el: kept.el, offset: kept.top - kept.area } : null;
  };
  onShow = () => {
    if (restoring) return;
    if (left?.el.isConnected)
      frame.body.scrollTop +=
        left.el.getBoundingClientRect().top -
        frame.body.getBoundingClientRect().top -
        left.offset;
    else place(state.textOffset, state.blockOffset);
    left = null;
    capture();
    void prefetch();
  };
  /** Spec 4.3, PDF → full text: the block of that page and place, else the nearest one before it. */
  const followPdf = async (pageNumber: number, ratio: number) => {
    const blocksOf = (): TextBlock[] =>
      segments.map((segment) => ({
        start: segment.start_utf8,
        page: typeof segment.page === "number" ? segment.page : null,
        region: segment.region ?? null,
      }));
    while (
      !finished &&
      !segments.some((segment) => (segment.page ?? 0) > pageNumber) &&
      !ctx.signal.aborted
    )
      await load();
    const found = pdfToText(blocksOf(), pageNumber, ratio);
    if (!found) {
      frame.onNote?.(`全文中找不到第 ${pageNumber} 页的对应段落。`);
      return;
    }
    const segment = segments[found.index]!;
    while (!finished && end <= segment.start_utf8 && !ctx.signal.aborted)
      await load();
    const block = blockAt(segment.start_utf8);
    // The segment's place, as a share of the rendered block that holds it.
    const blockStart = Number(block?.dataset.byteStart ?? segment.start_utf8),
      blockEnd = Number(block?.dataset.byteEnd ?? segment.end_utf8),
      at =
        segment.start_utf8 +
        found.ratio * (segment.end_utf8 - segment.start_utf8);
    place(
      segment.start_utf8,
      blockEnd > blockStart ? (at - blockStart) / (blockEnd - blockStart) : 0,
    );
    frame.onNote?.(
      found.exact
        ? null
        : `全文中找不到第 ${pageNumber} 页的对应段落，已停在最接近处。`,
    );
  };
  let pendingFollow: { anchor: ReadingAnchor; done: () => void } | null = null;
  if (frame.queuedFollow) {
    pendingFollow = frame.queuedFollow;
    delete frame.queuedFollow;
  }
  frame.follow = async (anchor, jumped = false) => {
    // While the text is first laid out the place waits; the promise settles once it is taken.
    if (restoring)
      return new Promise<void>((done) => {
        pendingFollow = { anchor, done };
      });
    if (layerAway && jumped)
      layersView?.setLayer("full", { point: null, instant: true });
    if (anchor.kind === "doc") place(anchor.start, anchor.ratio, jumped);
    else await followPdf(anchor.page, anchor.ratio);
  };
  const sizes = new ResizeObserver(keep);
  sizes.observe(frame.body);
  sizes.observe(article);
  ctx.signal.addEventListener("abort", () => sizes.disconnect(), {
    once: true,
  });
  const continuationObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void prefetch();
    },
    { root: frame.body, rootMargin: "800px" },
  );
  // Show the first body chunk before waiting for the auxiliary outline.
  const target =
    source?.kind === "document" ? source.start_utf8 : state.textOffset;
  const targetEnd = Math.max(
    state.loadedEnd,
    source?.kind === "document" ? source.end_utf8 : target + 1,
  );
  const initialRevision = jumpRevision;
  // The translation is read before the first text shows in it, so the page
  // does not open in the original and change under the reader.
  if (textMode !== "original" && !(await ensureUnits())) {
    textMode = "original";
    article.dataset.textMode = textMode;
  }
  await load();
  const sectionPlaces = new Map<string, { start: number; level: number }>();
  do {
    const page: DocumentReadResultMap["outline"] = await readDocument(
      ctx,
      "outline",
      {
        document_version_id: docId,
        limit: 200,
        cursor,
      },
    );
    bound(page);
    for (const section of page.sections) {
      // Spec 2.3: the abstract between two rules (its blocks, first and last).
      if (section.role === "abstract") {
        const inside = rendered
          .map((r) => r.element)
          .filter((el) => {
            const at = Number(el.dataset.byteStart);
            return at >= section.start_utf8 && at < section.end_utf8;
          });
        inside.forEach((el, i) => {
          el.dataset.abstract =
            [i === 0 ? "first" : "", i === inside.length - 1 ? "last" : ""]
              .join(" ")
              .trim() || "middle";
        });
      }
      if (section.section_id)
        sectionPlaces.set(section.section_id, {
          start: section.start_utf8,
          level: section.level,
        });
      const activate = async () => {
        frame.beforeJump?.();
        const revision = ++jumpRevision;
        while (!finished && end < section.start_utf8 + 4096) {
          await load();
          if (ctx.signal.aborted || revision !== jumpRevision) return;
        }
        if (!ctx.signal.aborted && revision === jumpRevision)
          go(section.start_utf8, 0, true);
      };
      if (frame.onOutline)
        frame.onOutline({
          title: section.title,
          role: section.role ?? null,
          level: section.level,
          start: section.start_utf8,
          end: section.end_utf8,
          activate,
        });
      else
        frame.outline.append(button(section.title || "未命名章节", activate));
    }
    cursor = page.next_cursor;
  } while (cursor);
  if (!frame.onOutline && !frame.outline.childElementCount)
    frame.outline.textContent = "没有可靠章节目录；正文仍可连续阅读。";
  while (!finished && end < targetEnd && initialRevision === jumpRevision)
    await load();
  if (initialRevision === jumpRevision) {
    // Restore before interaction without leaving an animated scroll in flight.
    if (source?.kind === "document") go(target, 0);
    // A remembered place from another text version: the block at or before
    // its offset, unless the new text ends before it (spec 4.5).
    else if (
      frame.remembered === "other-version" &&
      finished &&
      end <= target
    ) {
      frame.onNote?.("上次的位置在旧版本文本中，已从开头打开。");
      place(0, 0);
    } else if (frame.remembered || state.textOffset > 0)
      place(target, state.blockOffset);
    // A first opening starts at the very top, the document's title in view.
    else frame.body.scrollTop = 0;
  }
  restoring = false;
  capture();
  // Assigned by `follow` meanwhile, which narrowing cannot see.
  const waiting = pendingFollow as {
    anchor: ReadingAnchor;
    done: () => void;
  } | null;
  if (waiting) {
    pendingFollow = null;
    await frame.follow(waiting.anchor);
    waiting.done();
  }
  continuationObserver.observe(tail);
  void prefetch();
  /**
   * Spec 2.5: find marks only the matching words (CSS highlights, so the
   * text is untouched): every match --hl, the current one --hl-current.
   */
  const findRegistry =
    typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
  frame.onFind = (query, stay = false) => {
    frame.onFindNext?.(null);
    const needle = query.toLocaleLowerCase();
    const hits: { block: HTMLElement; range: Range }[] = [];
    if (needle)
      for (const block of blocks()) {
        // The block's text, with where each text node starts in it.
        // Spec 9: the text the current reading shows; 对照 looks in both.
        const translated = block.dataset.translation === "done";
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (
              parent?.closest(
                ".reading-block-source, .reading-doubt, .katex-mathml, .reading-margin-note, .reading-untranslated, .reading-translation-marks",
              )
            )
              return NodeFilter.FILTER_REJECT;
            // In 译文 a translated block shows only its translation, any
            // other block only its own text.
            const inTranslation = !!parent?.closest(".reading-translation");
            return textMode === "translation" && translated !== inTranslation
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
          },
        });
        const nodes: { node: Text; at: number }[] = [];
        let content = "";
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          nodes.push({ node: n as Text, at: content.length });
          content += n.textContent ?? "";
        }
        const haystack = content.toLocaleLowerCase();
        const point = (offset: number) => {
          let i = nodes.length - 1;
          while (i > 0 && nodes[i]!.at > offset) i--;
          return { node: nodes[i]!.node, offset: offset - nodes[i]!.at };
        };
        for (
          let at = haystack.indexOf(needle);
          at >= 0 && nodes.length;
          at = haystack.indexOf(needle, at + needle.length)
        ) {
          const range = document.createRange(),
            start = point(at),
            end = point(at + needle.length);
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          hits.push({ block, range });
        }
      }
    findRegistry?.delete("find-current");
    if (hits.length)
      findRegistry?.set("find-hit", new Highlight(...hits.map((h) => h.range)));
    else findRegistry?.delete("find-hit");
    const blocksHit = [...new Set(hits.map((h) => h.block))];
    frame.onFindHits?.(blocksHit.map((b) => Number(b.dataset.byteStart)));
    let index = -1;
    const status = () => {
      frame.findStatus.textContent = `${finished ? "全文" : "已加载范围"}：${
        !hits.length
          ? "没有匹配"
          : index < 0
            ? `共 ${hits.length} 处 · ${blocksHit.length} 段`
            : `第 ${index + 1} / ${hits.length} 处 · ${blocksHit.length} 段`
      }${finished ? "" : "；可继续加载后查找"}`;
    };
    status();
    const jump = (step: 1 | -1 = 1) => {
      index = (index + step + hits.length) % hits.length;
      const hit = hits[index];
      if (!hit) return;
      findRegistry?.set("find-current", new Highlight(hit.range));
      status();
      go(Number(hit.block.dataset.byteStart), 0, true);
    };
    if (hits.length) {
      // Found again in another reading (spec 9): the place stays.
      if (!stay) jump();
      if (frame.onFindNext) frame.onFindNext(jump);
      else frame.findStatus.append(button("下一处命中", () => jump()));
    }
  };
  // Reading layers (reading-experience 3, ADR 0070): a version that has them
  // is an annotated copy. They rest on the whole text, so it is read to the
  // end first; a version with layers is never a long document.
  if (described.layers?.state !== "complete" || level === "draft") return;
  try {
    // The layers' translation part has one language (spec 10.5): in another
    // language the notes are read in the paper's own (ADR 0072).
    const layersSummary =
      askedLanguage &&
      described.layers.target_language &&
      described.layers.target_language !== askedLanguage
        ? { ...described.layers, target_language: null }
        : described.layers;
    const data = await readLayers(ctx, docId, layersSummary);
    while (!finished && !ctx.signal.aborted) await load();
    ctx.signal.throwIfAborted();
    if (data.text !== "original") await ensureUnits();
    const starts = new Map(segments.map((s) => [s.segment_id, s.start_utf8]));
    const figures = new Map<string, LayerFigure>();
    for (const group of layout?.figure_groups ?? []) {
      const captionText = group.captions
        .map((c) => {
          const block = blockAt(c.start_utf8);
          return block ? blockSourceText(block, false) : "";
        })
        .join(" ")
        .trim();
      const lead = captionParts(captionText).lead;
      const translated =
        group.captions
          .map((c) => units?.get(c.segment_id)?.translation ?? "")
          .join(" ")
          .trim() || null;
      for (const object of group.objects)
        figures.set(object.segment_id, {
          segment_id: object.segment_id,
          panels: group.objects.map((o) => o.segment_id),
          kind: group.kind,
          label:
            lead ??
            (group.kind === "table"
              ? "表"
              : group.kind === "scheme"
                ? "方案"
                : "图"),
          caption: (mode) =>
            mode === "original" ? captionText || null : translated,
          // One way to name a figure per reading (layers/model.ts).
          name: (mode) =>
            figureNameIn(
              group.kind,
              lead,
              captionParts(translated).lead,
              language,
              mode,
            ) ??
            lead ??
            (group.kind === "table"
              ? "表"
              : group.kind === "scheme"
                ? "方案"
                : "图"),
          start: object.start_utf8,
          image: async () => {
            if (group.kind === "table") return null;
            const holder = blockAt(
              object.start_utf8,
            )?.querySelector<HTMLElement>("[data-resource]");
            const resource = holder
              ? resources.get(holder.dataset.resource!)
              : undefined;
            return resource ? imageUrl(resource) : null;
          },
        });
    }
    const port: LayersPort = {
      sheet: layer,
      article,
      body: frame.body,
      header: frame.header ?? null,
      title: frame.documentTitle ?? null,
      blocks,
      blockAt,
      loadAll: async () => {
        while (!finished && !ctx.signal.aborted) await load();
      },
      section: (id) => {
        const found = sectionPlaces.get(id);
        if (!found) return null;
        const heading = segments[segmentFrom(found.start)];
        return {
          ...found,
          translation:
            (heading && units?.get(heading.segment_id)?.translation) || null,
        };
      },
      figure: (id) => figures.get(id) ?? null,
      away: (on) => {
        if (layerAway === on) return;
        layerAway = on;
        if (!on) capture();
      },
      place: () => state.textOffset,
      enlarge: (url, label) => frame.onImage?.(url, label),
      repainted: () => frame.onDocumentPaint?.(),
      reducedMotion: () => !(frame.animateNavigation?.() ?? true),
    };
    const view = attachLayers(port, data, {
      layer: frame.readingLayer ?? "full",
      text: textMode,
      keyTerms: frame.keyTerms ?? true,
      onLayer: (shown) => frame.onLayer?.(shown),
      offsetOf: (id) => starts.get(id) ?? null,
      onPick: (start) => frame.onPick?.(start) ?? false,
    });
    layersView = view;
    frame.setLayer = (next, target) => view.setLayer(next, target);
    frame.layerWheel = (deltaY) => view.wheel(deltaY);
    frame.setKeyTerms = (on) => view.setKeyTerms(on);
    frame.layerStart = () => view.readingStart();
    frame.foldLayers = () => view.fold();
    ctx.signal.addEventListener("abort", () => view.destroy(), { once: true });
    frame.onLayers?.(true);
    frame.onLayer?.(view.layer());
  } catch (error) {
    if (!ctx.signal.aborted) {
      frame.onLayers?.(false);
      frame.onNote?.(
        readerErrorMessage(error, "概览与脉络没有读到，按全文显示。"),
      );
    }
  }
}

/** Wraps the leading text `pattern` matches in a span (no text changes). */
function wrapLead(
  el: Element,
  pattern: RegExp,
  className: string,
  dropSpace = false,
) {
  const first = el.firstChild;
  if (!first || first.nodeType !== Node.TEXT_NODE) return;
  const match = pattern.exec(first.textContent ?? "");
  if (!match?.[1]) return;
  const lead = match[0];
  const text = first as Text;
  const rest = text.splitText(lead.length);
  const span = document.createElement("span");
  span.className = className;
  span.textContent = dropSpace ? lead.trimEnd() : lead;
  if (dropSpace)
    rest.textContent = lead.slice(span.textContent.length) + rest.textContent;
  text.replaceWith(span);
}
/**
 * Spec 2.2: a value and its unit (“1.86 g·cm⁻³”), an equation (“R₁ =
 * 0.036”) and a code (“NX-7”) never break; wrapped, not rewritten.
 */
const UNBREAKABLE =
  /\d[\d.,]*(?:\s?[×x]\s?10[⁻⁰-⁹]+)?\s(?:[µμ]?[A-Za-z°%Å]{1,4}(?:[·/][A-Za-z]{1,4})?[⁻⁰-⁹]*|°C|%)(?![A-Za-z])|[A-Za-z][A-Za-z₀-₉]{0,3}\s?=\s?[−-]?\d[\d.,]*|\b[A-Z]{1,5}-\d{1,4}\b/gu;
function keepUnits(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(".katex, code, pre, .reading-nobr, a")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  for (const node of nodes) {
    const text = node.textContent ?? "";
    UNBREAKABLE.lastIndex = 0;
    const matches = [...text.matchAll(UNBREAKABLE)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let at = 0;
    for (const m of matches) {
      if (m.index > at) fragment.append(text.slice(at, m.index));
      const span = document.createElement("span");
      span.className = "reading-nobr";
      span.textContent = m[0];
      fragment.append(span);
      at = m.index + m[0].length;
    }
    if (at < text.length) fragment.append(text.slice(at));
    node.replaceWith(fragment);
  }
}
