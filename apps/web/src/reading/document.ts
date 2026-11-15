import {
  type DocumentLayout,
  type DocumentReadingRef,
  type DocumentResource,
  type DocumentReadRequestMap,
  type DocumentReadResultMap,
} from "@sciretriever/contracts";
import type { ReadingContext } from "./contract.js";
import type { FixedSource } from "./source.js";
import { button, readerErrorMessage } from "./dom.js";
import type { ReaderFrame, ReadingAnchor } from "./contract.js";
import type { ReadingPosition } from "./state.js";
import {
  forgetDocumentRead,
  readDocument,
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
import { documentMarkdown as markdown, markdownBlocks } from "./markdown.js";

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
  const described: DocumentReadResultMap["describe"] = await readDocument(
    ctx,
    "describe",
    { document_version_id: docId },
  );
  bound(described);
  const layout: DocumentLayout | null = described.layout ?? null;
  frame.onLoadStep?.("layout");
  const article = document.createElement("article");
  article.className = "reading-article library-reading-text";
  // Folded front-page article information (ADR 0054); session state only.
  article.dataset.articleInfo = "collapsed";
  if (frame.documentTitle) {
    const title = document.createElement("h1");
    title.className = "reading-document-title";
    appendTitle(title, titleParts(frame.documentTitle));
    article.append(title);
  }
  // Reading-experience 3.4: the text's level; a draft and a long document
  // (ADR 0055) say so above the text, scrolling with it, never dismissed.
  const level = described.text_level ?? "proofread";
  frame.onTextLevel?.(level);
  if (level === "draft" || described.long_document) {
    const note = document.createElement("p");
    note.className = "reading-long-document";
    note.setAttribute("role", "note");
    note.textContent =
      level === "draft"
        ? "初稿：未经校订，文字可能含解析错误；以 PDF 为准"
        : `长文档：按简化流程建档，未逐页校订，文字可能含解析错误；以 PDF 为准（${described.long_document!.pages} 页）`;
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
  /** The anchor block (spec 4.1) and its top on screen, as last measured. */
  let kept: { el: HTMLElement; top: number; area: number } | null = null;
  const capture = (closing = false) => {
    if (
      restoring ||
      hidden ||
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
  frame.anchor = () => {
    const at = rendered.findIndex(
      (r) => Number(r.element.dataset.byteStart) === state.textOffset,
    );
    const el = rendered[at]?.element;
    return {
      kind: "doc",
      start: state.textOffset,
      ratio: state.blockOffset,
      label: at >= 0 ? `¶${at + 1}` : "",
      page: el?.dataset.page ? Number(el.dataset.page) : null,
      region: regionOf(el),
      text: el?.textContent?.slice(0, 240) ?? "",
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
  frame.isVisible = (anchor) => {
    if (anchor.kind !== "doc" || hidden) return false;
    const el = blockAt(anchor.start);
    if (!el) return false;
    const box = el.getBoundingClientRect(),
      area = frame.body.getBoundingClientRect();
    return box.bottom > area.top && box.top < area.bottom;
  };
  const onScroll = () => {
    if (hidden) return;
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
      const segment = segments.find(
        (s) => s.start_utf8 < block.end && s.end_utf8 > block.start,
      );
      // The segment's one-based PDF page (the reader's public page, as read)
      // and region: where marks and the reading position find it in the PDF.
      if (segment && typeof segment.page === "number") {
        el.dataset.page = String(segment.page);
        if (segment.region) el.dataset.region = segment.region.join(",");
      }
      if (segment && frame.onSegment) {
        const source = document.createElement("button");
        source.className = "reading-block-source";
        source.type = "button";
        source.textContent =
          (
            {
              "text-layer": "文字层核对",
              "image-only": "原图核对",
              manual: "人工核对",
              // A draft's three (technical 04 §8.3).
              "text-layer-match": "与文字层一致",
              "text-layer-differs": "与文字层有差异",
              "no-text-layer": "没有文字层可以核对",
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
        mark.textContent = differs ? "疑点" : "无文字层";
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
  await load();
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
  frame.onFind = (query) => {
    frame.onFindNext?.(null);
    const matches = blocks().filter((b) =>
      b.textContent?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
    for (const b of blocks())
      b.classList.toggle("reading-match", matches.includes(b));
    frame.findStatus.textContent = `${finished ? "全文" : "已加载范围"}：${matches.length} 个匹配段落${finished ? "" : "；可继续加载后查找"}`;
    let index = 0;
    const jump = () => {
      const block = matches[index++ % matches.length];
      if (block) go(Number(block.dataset.byteStart), 0, true);
    };
    if (matches.length) {
      jump();
      if (frame.onFindNext) frame.onFindNext(jump);
      else frame.findStatus.append(button("下一处命中", jump));
    }
  };
}
