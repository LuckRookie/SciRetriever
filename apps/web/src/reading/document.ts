import {
  sha256,
  type DocumentReadingRef,
  type DocumentResource,
  type DocumentReadResultMap,
} from "@sciretriever/contracts";
import type { AppContext } from "../workspace/types.js";
import type { FixedSource } from "../workspace/source-navigation.js";
import { button } from "../workspace/dom.js";
import type { ReaderFrame } from "./frame.js";
import type { ReadingPosition } from "./state.js";
import { readDocument } from "./transport.js";
import { markdown, markdownBlocks } from "./markdown.js";

export async function renderDocument(
  ctx: AppContext,
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
    for (const segment of page.segments)
      total = Math.max(total, segment.end_utf8);
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
  const article = document.createElement("article");
  article.className = "reading-article library-reading-text";
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
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          const el = entry.target as HTMLElement;
          observer.unobserve(el);
          const resource = resources.get(el.dataset.resource!);
          if (!resource) {
            el.textContent += "（未保存该资源，不加载外部图片）";
            continue;
          }
          void imageUrl(resource)
            .then((url) => {
              if (ctx.signal.aborted || !el.isConnected) return;
              const image = document.createElement("img");
              image.alt = resource.reference;
              image.src = url;
              image.loading = "lazy";
              image.onerror = () => {
                el.textContent = "图片无法解码，原正文仍可阅读。";
              };
              el.replaceChildren(image);
            })
            .catch((error) => {
              if (!ctx.signal.aborted && el.isConnected)
                el.textContent = `图片暂不可读：${error instanceof Error ? error.message : "未知错误"}`;
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
    restoring = true;
  let pending: Promise<void> | null = null,
    jumpRevision = 0;
  const blocks = () => [
    ...article.querySelectorAll<HTMLElement>("[data-byte-start]"),
  ];
  const capture = (closing = false) => {
    if (restoring || (!closing && ctx.signal.aborted)) return;
    const top = frame.body.getBoundingClientRect().top;
    const block = blocks().find((b) => b.getBoundingClientRect().bottom > top);
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
  const go = (offset: number, ratio = 0) => {
    const block =
      blocks().find((b) => Number(b.dataset.byteEnd) > offset) ??
      blocks().at(-1);
    if (block)
      frame.body.scrollTop +=
        block.getBoundingClientRect().top -
        frame.body.getBoundingClientRect().top +
        ratio * block.clientHeight -
        12;
  };
  frame.beforeLayout = () => {
    capture();
    const offset = state.textOffset,
      ratio = state.blockOffset;
    return () => go(offset, ratio);
  };
  const onScroll = () => capture();
  frame.body.addEventListener("scroll", onScroll, { passive: true });
  ctx.signal.addEventListener(
    "abort",
    () => {
      capture(true);
      observer.disconnect();
      frame.body.removeEventListener("scroll", onScroll);
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      inFlight.clear();
      text = "";
      article.replaceChildren();
    },
    { once: true },
  );
  const more = button("继续加载正文", async () => {
    const revision = ++jumpRevision;
    capture();
    const offset = state.textOffset,
      ratio = state.blockOffset;
    await load();
    if (!ctx.signal.aborted && revision === jumpRevision) go(offset, ratio);
  });
  more.id = "reader-load-more";
  frame.body.append(more);
  const paint = () => {
    observer.disconnect();
    article.replaceChildren();
    for (const block of markdownBlocks(text)) {
      if (block.token.type === "space") continue;
      const el = document.createElement("section");
      el.dataset.byteStart = String(block.start);
      el.dataset.byteEnd = String(block.end);
      el.innerHTML = markdown.parser([block.token]);
      if (
        source?.kind === "document" &&
        source.start_utf8 < block.end &&
        source.end_utf8 > block.start
      )
        el.classList.add("reading-evidence");
      article.append(el);
    }
    for (const table of article.querySelectorAll("table")) {
      const wrap = document.createElement("div");
      wrap.className = "reading-table";
      table.before(wrap);
      wrap.append(table);
    }
    for (const el of article.querySelectorAll<HTMLElement>("[data-resource]"))
      observer.observe(el);
    more.hidden = finished;
    frame.status.textContent = `${finished ? "全文已加载" : "已加载部分正文"} · ${end.toLocaleString()}${segmentCursor ? " 字节，后续正文可继续加载" : ` / ${total.toLocaleString()} 字节`}${source?.kind === "document" ? " · 高亮为证据所在原文块；无可靠 PDF 坐标" : ""}`;
    ctx.root.dataset.readingReady = "true";
  };
  const loadChunk = async () => {
    more.disabled = true;
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
      text += result.text;
      end = result.actual_range.end_utf8;
      continuation = result.continuation;
      finished = !continuation && !segmentCursor;
      if (finished && end !== total)
        throw new Error("正文尚未完整，缺少续读游标");
      paint();
      state.loadedEnd = end;
    } catch (error) {
      if (!ctx.signal.aborted) {
        frame.status.textContent = `正文未加载完成：${error instanceof Error ? error.message : "请重试"}`;
        more.textContent = "重试加载正文";
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
  // Show the first body chunk before waiting for the auxiliary outline.
  const target =
    source?.kind === "document" ? source.start_utf8 : state.textOffset;
  const targetEnd = Math.max(
    state.loadedEnd,
    source?.kind === "document" ? source.end_utf8 : target + 1,
  );
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
    for (const section of page.sections)
      frame.outline.append(
        button(section.title || "未命名章节", async () => {
          const revision = ++jumpRevision;
          while (!finished && end < section.start_utf8 + 4096) {
            await load();
            if (ctx.signal.aborted || revision !== jumpRevision) return;
          }
          if (!ctx.signal.aborted && revision === jumpRevision)
            go(section.start_utf8);
        }),
      );
    cursor = page.next_cursor;
  } while (cursor);
  if (!frame.outline.childElementCount)
    frame.outline.textContent = "没有可靠章节目录；正文仍可连续阅读。";
  const initialRevision = jumpRevision;
  while (!finished && end < targetEnd && initialRevision === jumpRevision)
    await load();
  if (initialRevision === jumpRevision)
    go(target, source?.kind === "document" ? 0 : state.blockOffset);
  restoring = false;
  frame.onFind = (query) => {
    const matches = blocks().filter((b) =>
      b.textContent?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
    for (const b of blocks())
      b.classList.toggle("reading-match", matches.includes(b));
    frame.findStatus.textContent = `${finished ? "全文" : "已加载范围"}：${matches.length} 个匹配段落${finished ? "" : "；可继续加载后查找"}`;
    let index = 0;
    const jump = () => {
      const block = matches[index++ % matches.length];
      if (block) go(Number(block.dataset.byteStart));
    };
    if (matches.length) {
      jump();
      frame.findStatus.append(button("下一处命中", jump));
    }
  };
}
