import {
  sha256,
  type DocumentLayout,
  type DocumentReadingRef,
  type DocumentResource,
  type DocumentReadResultMap,
} from "@sciretriever/contracts";
import type { ReadingContext } from "./contract.js";
import type { FixedSource } from "./source.js";
import { button, readerErrorMessage } from "./dom.js";
import type { ReaderFrame } from "./contract.js";
import type { ReadingPosition } from "./state.js";
import { readDocument } from "./transport.js";
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
  if (!total) {
    frame.status.textContent = "此文档没有可读取正文；不会自动重新解析。";
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
  frame.body.append(article);
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
      const bytes = new Uint8Array(resource.artifact.byte_size);
      let offset = 0,
        continuation: string | null = null;
      do {
        const page: DocumentReadResultMap["resource"] = await readDocument(
          ctx,
          "resource",
          {
            document_version_id: docId,
            resource_id: resource.resource_id,
            max_bytes: 65536,
            continuation,
          },
        );
        bound(page);
        if (
          JSON.stringify(page.resource) !== JSON.stringify(resource) ||
          !page.bytes_base64 ||
          !page.actual_range ||
          page.actual_range.start_byte !== offset
        )
          throw new Error("图片读取无法核验");
        const chunk = Uint8Array.from(atob(page.bytes_base64), (c) =>
          c.charCodeAt(0),
        );
        if (
          offset + chunk.length > bytes.length ||
          page.actual_range.end_byte !== offset + chunk.length
        )
          throw new Error("图片范围不匹配");
        bytes.set(chunk, offset);
        offset += chunk.length;
        continuation = page.continuation;
      } while (continuation);
      if (
        offset !== bytes.length ||
        (await sha256(bytes)) !== resource.artifact.sha256
      )
        throw new Error("图片完整性校验失败");
      ctx.signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([bytes], { type: resource.artifact.media_type }),
      );
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
  const blocks = () => [
    ...article.querySelectorAll<HTMLElement>("[data-byte-start]"),
  ];
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
  const capture = (closing = false) => {
    if (
      restoring ||
      (!closing && ctx.signal.aborted) ||
      !frame.body.isConnected ||
      frame.body.clientHeight === 0
    )
      return;
    const top = frame.body.getBoundingClientRect().top;
    const block = blocks().find(
      (b) => !folded(b) && b.getBoundingClientRect().bottom > top,
    );
    if (block) {
      state.textOffset = Number(block.dataset.byteStart);
      state.blockOffset = Math.max(
        0,
        (top - block.getBoundingClientRect().top) /
          Math.max(1, block.clientHeight),
      );
    }
    state.loadedEnd = end;
    state.scroll = frame.body.scrollTop;
  };
  const go = (offset: number, ratio = 0, animate = false) => {
    const block =
      blocks().find((b) => Number(b.dataset.byteEnd) > offset) ??
      blocks().at(-1);
    if (block && folded(block)) setInfoOpen(true);
    if (block) {
      const delta =
        block.getBoundingClientRect().top -
        frame.body.getBoundingClientRect().top +
        ratio * block.clientHeight -
        12;
      if (
        animate &&
        frame.animateNavigation?.() &&
        Math.abs(delta) <= frame.body.clientHeight * 1.5
      )
        frame.body.scrollTo({
          top: frame.body.scrollTop + delta,
          behavior: "smooth",
        });
      else frame.body.scrollTop += delta;
    }
  };
  frame.beforeLayout = () => {
    capture();
    const offset = state.textOffset,
      ratio = state.blockOffset;
    return () => go(offset, ratio);
  };
  const onScroll = () => {
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
      for (const url of urls.values()) URL.revokeObjectURL(url);
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
  frame.body.append(tail, more);
  const rendered: { html: string; element: HTMLElement }[] = [];
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
      "a[data-reading-fragment]",
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
  const paint = () => {
    let index = 0;
    for (const block of markdownBlocks(text)) {
      if (block.token.type === "space") continue;
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
      // A page hint for placing PDF marks; never shown as a location.
      if (segment && typeof segment.page === "number")
        el.dataset.page = String(segment.page + 1);
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
            } as Record<string, string>
          )[segment.basis ?? ""] ?? "查看来源";
        if (segment.locate === "page") source.textContent += " · 仅页级定位";
        source.setAttribute(
          "aria-label",
          `查看区块来源：${source.textContent}`,
        );
        source.onclick = () => frame.onSegment?.(segment.segment_id);
        el.prepend(source);
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
      for (const resource of previous.element.querySelectorAll(
        "[data-resource]",
      ))
        observer.unobserve(resource);
      previous.element.remove();
    }
    const firstInfo = article.querySelector(".reading-article-info");
    if (firstInfo && firstInfo.previousElementSibling !== infoToggle)
      firstInfo.before(infoToggle);
    wireDocumentLinks();
    more.hidden = true;
    tail.hidden = finished;
    tail.textContent = finished ? "" : "继续向下阅读，正文将自动加载";
    frame.status.textContent = `${finished ? "全文已加载" : "已加载部分正文 · 继续向下滚动自动加载"}${source?.kind === "document" ? " · 高亮为证据所在段落；无可靠 PDF 页码" : ""}`;
    frame.onIssue?.(null);
    ctx.root.dataset.readingReady = "true";
    frame.onDocumentPaint?.();
  };
  const loadChunk = async () => {
    more.disabled = true;
    tail.textContent = "正在加载后续正文…";
    try {
      if (!continuation && segmentCursor && end === total) {
        rangeStart = end;
        await extendSegments();
      }
      const result = await readDocument(ctx, "slice", {
        document_version_id: docId,
        selector: { kind: "range", start_utf8: rangeStart, end_utf8: total },
        max_bytes: 65536,
        continuation,
      });
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
      paint();
      if (!restoring) go(offset, ratio);
      state.loadedEnd = end;
    } catch (error) {
      if (!ctx.signal.aborted) {
        frame.status.textContent = readerErrorMessage(
          error,
          "正文无法完成读取或校验；已读内容保留，请重试。",
        );
        autoFailed = true;
        more.hidden = !!frame.onIssue;
        frame.onIssue?.("加载暂停，已读正文保留。", async () => {
          autoFailed = false;
          await append();
          void prefetch();
        });
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
  if (initialRevision === jumpRevision)
    // Restore before interaction without leaving an animated scroll in flight.
    go(target, source?.kind === "document" ? 0 : state.blockOffset);
  restoring = false;
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
