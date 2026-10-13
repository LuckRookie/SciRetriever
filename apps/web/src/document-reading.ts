import {
  parseDocumentReadRequest,
  parseDocumentReadResult,
  type DocumentReadOperation,
  type DocumentReadRequestMap,
  type DocumentReadResultMap,
  type DocumentSelector,
  type LiteratureDetail,
  sha256,
} from "@sciretriever/contracts";
import { dataFetch } from "./knowledge.js";

/** Open only the explicitly selected, completely verified original PDF. */
export function mountMaterialReading(
  root: HTMLElement,
  detail: LiteratureDetail,
): HTMLButtonElement | null {
  const asset = detail.primary_pdf?.asset;
  if (!asset) return null;
  const panel = document.createElement("section");
  panel.className = "library-pdf-reading";
  let release: (() => void) | null = null;
  const open = button("阅读原始 PDF", () => {
    release?.();
    if (!root.contains(panel)) root.append(panel);
    open.disabled = true;
    panel.replaceChildren(element("p", "正在读取并校验固定 PDF…"));
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const dispose = () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      observer.disconnect();
      window.removeEventListener("pagehide", dispose);
    };
    const observer = new MutationObserver(() => {
      if (!root.contains(panel) || !root.isConnected) dispose();
    });
    release = dispose;
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("pagehide", dispose, { once: true });
    void (async () => {
      if (asset.size_bytes < 1 || asset.size_bytes > 256 * 1024 * 1024)
        throw new Error("PDF 超过受控读取上限");
      const response = await dataFetch("/api/v1/query/material-bytes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: {
            literature_id: detail.literature.literature_id,
            asset_id: asset.asset_id,
            asset_sha256: asset.sha256,
          },
        }),
        signal: controller.signal,
      });
      if (
        !response.ok ||
        response.headers.get("Content-Type")?.split(";")[0] !==
          "application/pdf" ||
        response.headers.get("x-sciretriever-asset-id") !== asset.asset_id ||
        response.headers.get("x-sciretriever-asset-sha256") !== asset.sha256 ||
        response.headers.get("x-sciretriever-byte-size") !==
          String(asset.size_bytes)
      )
        throw new Error("PDF 响应与所选材料不一致或暂不可用");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("PDF 响应无字节");
      const bytes = new Uint8Array(asset.size_bytes);
      let at = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (at + chunk.value.byteLength > bytes.byteLength) {
          await reader.cancel();
          throw new Error("PDF 响应超过声明大小");
        }
        bytes.set(chunk.value, at);
        at += chunk.value.byteLength;
      }
      if (at !== asset.size_bytes || (await sha256(bytes)) !== asset.sha256)
        throw new Error("PDF 完整性校验失败");
      if (controller.signal.aborted || !root.contains(panel)) return;
      objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: "application/pdf" }),
      );
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${detail.literature.literature_id}.pdf`;
      link.textContent = "下载已核验的原始 PDF";
      const frame = document.createElement("iframe");
      frame.title = "原始 PDF 预览";
      frame.className = "library-pdf-frame";
      // Chromium disables its native PDF viewer inside sandboxed frames.
      // This frame receives only verified application/pdf bytes, never HTML or a remote URL.
      frame.referrerPolicy = "no-referrer";
      frame.width = "100%";
      frame.height = "680";
      frame.src = objectUrl;
      panel.replaceChildren(
        element("h3", "原始 PDF"),
        element(
          "p",
          `已核验固定材料 · ${asset.size_bytes} 字节 · SHA-256 ${asset.sha256}`,
        ),
        link,
        element("p", "预览由浏览器提供；若无法显示，可下载同一份已核验 PDF。"),
        frame,
      );
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted && root.contains(panel))
          panel.replaceChildren(
            element(
              "p",
              `原始 PDF 读取失败：${error instanceof Error ? error.message : "未知错误"}`,
            ),
          );
        dispose();
      })
      .finally(() => {
        open.disabled = false;
      });
  });
  return open;
}

const route: Record<DocumentReadOperation, string> = {
  default: "/api/document/default",
  describe: "/api/document/describe",
  outline: "/api/document/outline",
  segments: "/api/document/segments",
  resources: "/api/document/resources",
  slice: "/api/document/slice",
  resource: "/api/document/resource",
  material: "/api/document/material-evidence",
  evidence: "/api/document/evidence-resolve",
};
function element(tag: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", action);
  return node;
}
async function read<K extends DocumentReadOperation>(
  send: (path: string, body: unknown) => Promise<Record<string, unknown>>,
  kind: K,
  payload: DocumentReadRequestMap[K],
): Promise<DocumentReadResultMap[K]> {
  const request = parseDocumentReadRequest(kind, payload);
  const reply = await send(route[kind], request);
  return parseDocumentReadResult(kind, reply.result, request);
}
export function mountDocumentReading(
  root: HTMLElement,
  detail: LiteratureDetail,
  send: (path: string, body: unknown) => Promise<Record<string, unknown>>,
  message: (text: string) => void,
  fixedDocumentVersionId?: string,
): HTMLButtonElement | null {
  const primary = detail.primary_pdf?.asset;
  if (!primary && !fixedDocumentVersionId) return null;
  const pdf = {
    asset_id: primary?.asset_id ?? "",
    sha256: primary?.sha256 ?? "",
  };
  const literature = detail.literature.literature_id;
  const panel = element("section", "");
  panel.className = "library-reading";
  root.append(panel);
  let launchGeneration = 0;
  const launch = button("阅读材料与文档", () => {
    const generation = ++launchGeneration;
    launch.disabled = true;
    void open(generation)
      .catch(() => {
        if (
          panel.isConnected &&
          root.contains(panel) &&
          generation === launchGeneration
        )
          panel.replaceChildren(
            element("p", "材料或表示无法验证，请刷新后重试。"),
          );
      })
      .finally(() => {
        if (generation === launchGeneration) launch.disabled = false;
      });
  });
  const open = async (generation: number) => {
    const currentPanel = () =>
      panel.isConnected &&
      root.contains(panel) &&
      generation === launchGeneration;
    panel.replaceChildren(element("h3", "材料证据"));
    let fixedRepresentation: string | null = null;
    if (fixedDocumentVersionId) {
      const fixed = await read(send, "describe", {
        document_version_id: fixedDocumentVersionId,
      });
      if (fixed.document.source_material_ref.literature_id !== literature)
        throw new Error("document literature mismatch");
      pdf.asset_id = fixed.document.source_material_ref.asset_id;
      pdf.sha256 = fixed.document.source_material_ref.asset_sha256;
      fixedRepresentation = fixed.document.representation_sha256;
    }
    const material = await read(send, "material", {
      literature_id: literature,
      asset_id: pdf.asset_id,
    });
    if (
      material.evidence.target_kind !== "material" ||
      material.evidence.material.asset_sha256 !== pdf.sha256
    )
      throw new Error("material binding mismatch");
    if (!currentPanel()) return;
    panel.append(
      element(
        "p",
        `已复核原始 PDF · 文件级证据 · SHA-256 ${material.evidence.content_sha256}`,
      ),
    );
    let version = fixedDocumentVersionId;
    if (!version) {
      let current: DocumentReadResultMap["default"];
      try {
        current = await read(send, "default", {
          literature_id: literature,
          asset_id: pdf.asset_id,
          asset_sha256: pdf.sha256,
        });
      } catch (error) {
        if (!currentPanel()) return;
        panel.append(
          element(
            "p",
            error instanceof Error && error.message === "document-v3-required"
              ? "此 catalog 尚未启用文档表示；原始 PDF 仍可阅读。"
              : "文档表示暂时无法读取。",
          ),
        );
        return;
      }
      if (!currentPanel()) return;
      if (!current.default) {
        panel.append(element("p", "尚无已发布的文档表示；阅读不会启动解析。"));
        return;
      }
      version = current.default.document_version_id;
    }
    const selectedVersion = version;
    panel.append(element("p", `固定表示 ${version}`));
    const outline = element("div", "");
    outline.className = "library-reading-sections";
    const segments = element("div", "");
    segments.className = "library-reading-segments";
    const resources = element("div", "");
    resources.className = "library-reading-resources";
    const text = element("pre", "");
    text.className = "library-reading-text";
    text.style.whiteSpace = "pre-wrap";
    text.style.overflowWrap = "anywhere";
    const note = element("p", "请选择章节或片段阅读。");
    note.className = "library-reading-note";
    const proofs = element("div", "");
    proofs.className = "library-reading-proofs";
    panel.append(
      element("h3", "章节"),
      outline,
      element("h3", "全部片段（含标题前正文）"),
      segments,
      element("h3", "正文"),
      note,
      text,
      proofs,
      element("h3", "资源"),
      resources,
    );
    let representation: string | null = fixedRepresentation;
    const bound = (result: {
      readonly document: {
        readonly document_version_id: string;
        readonly representation_sha256: string;
        readonly source_material_ref: {
          readonly literature_id: string;
          readonly asset_id: string;
          readonly asset_sha256: string;
        };
      };
    }) => {
      const source = result.document.source_material_ref;
      if (
        result.document.document_version_id !== selectedVersion ||
        source.literature_id !== literature ||
        source.asset_id !== pdf.asset_id ||
        source.asset_sha256 !== pdf.sha256
      )
        throw new Error("document binding mismatch");
      if (
        representation !== null &&
        representation !== result.document.representation_sha256
      )
        throw new Error("representation changed");
      representation = result.document.representation_sha256;
    };
    let selection = 0;
    let moreText: HTMLButtonElement | null = null;
    const select = (selector: DocumentSelector, expectedStart: number) => {
      const generation = ++selection;
      moreText?.remove();
      moreText = null;
      text.textContent = "";
      proofs.replaceChildren();
      note.textContent = "正在读取固定版本…";
      void slice(selector, null, expectedStart, generation);
    };
    const slice = async (
      selector: DocumentSelector,
      continuation: string | null,
      expectedStart: number,
      generation: number,
    ) => {
      try {
        const result = await read(send, "slice", {
          document_version_id: selectedVersion,
          selector,
          max_bytes: 8192,
          continuation,
        });
        bound(result);
        if (!currentPanel() || generation !== selection) return;
        if (result.actual_range === null) {
          note.textContent = `未取得可定位正文：${result.gaps.join("、")}`;
          return;
        }
        if (result.actual_range.start_utf8 !== expectedStart)
          throw new Error("slice continuity mismatch");
        text.textContent += result.text;
        const evidence = result.evidence.filter(
          (item) => item.target_kind === "document",
        );
        note.textContent = `已读 UTF-8 字节 ${result.actual_range.start_utf8}–${result.actual_range.end_utf8}；${result.truncated ? "尚有后续" : "当前选择已读完"}；可复核片段证据 ${evidence.length} 条。能力/覆盖缺口：${result.gaps.join("、") || "无"}`;
        for (const item of evidence) {
          const proof = button(`复核 ${item.locator.segment_id}`, () => {
            proof.disabled = true;
            void read(send, "evidence", {
              evidence: item,
              max_bytes: 8192,
              continuation: null,
            })
              .then((resolved) => {
                if (currentPanel() && generation === selection) {
                  if (!resolved.document)
                    throw new Error("evidence version missing");
                  bound({ document: resolved.document });
                  note.textContent = `证据 ${item.locator.segment_id} 已复核；原文范围 ${resolved.actual_range?.start_utf8}–${resolved.actual_range?.end_utf8}。`;
                }
              })
              .catch(() => message("证据暂时无法复核。"))
              .finally(() => {
                proof.disabled = false;
              });
          });
          proofs.append(proof);
        }
        if (result.truncated && result.continuation) {
          const next = result.continuation;
          moreText = button("继续阅读", () => {
            const control = moreText;
            if (!control || control.disabled) return;
            control.disabled = true;
            control.remove();
            moreText = null;
            void slice(
              selector,
              next,
              result.actual_range!.end_utf8,
              generation,
            );
          });
          panel.append(moreText);
        }
      } catch {
        if (currentPanel() && generation === selection)
          note.textContent = "读取响应无法验证，请重新选择。";
      }
    };
    let outlineCursor: string | null = null;
    let outlineBusy = false;
    const moreOutline = button("更多章节", () => {
      void loadOutline(outlineCursor).catch(() =>
        message("目录暂时无法验证。"),
      );
    });
    const loadOutline = async (cursor: string | null) => {
      if (outlineBusy) return;
      outlineBusy = true;
      moreOutline.disabled = true;
      try {
        const page = await read(send, "outline", {
          document_version_id: selectedVersion,
          limit: 50,
          cursor,
        });
        bound(page);
        if (!currentPanel()) return;
        for (const section of page.sections)
          outline.append(
            button(section.title || section.section_id, () =>
              select(
                { kind: "section", section_id: section.section_id },
                section.start_utf8,
              ),
            ),
          );
        if (page.gaps.includes("outline-title-truncated"))
          outline.append(element("p", "过长标题仅显示前 512 个 UTF-8 字节。"));
        outlineCursor = page.next_cursor;
        if (outlineCursor) outline.append(moreOutline);
        else moreOutline.remove();
      } finally {
        outlineBusy = false;
        moreOutline.disabled = false;
      }
    };
    let segmentCursor: string | null = null;
    let segmentBusy = false;
    const moreSegments = button("更多片段", () => {
      void loadSegments(segmentCursor).catch(() =>
        message("片段列表暂时无法验证。"),
      );
    });
    const loadSegments = async (cursor: string | null) => {
      if (segmentBusy) return;
      segmentBusy = true;
      moreSegments.disabled = true;
      try {
        const page = await read(send, "segments", {
          document_version_id: selectedVersion,
          section_id: null,
          limit: 50,
          cursor,
        });
        bound(page);
        if (!currentPanel()) return;
        for (const segment of page.segments)
          segments.append(
            button(`${segment.segment_id} · ${segment.kind}`, () =>
              select(
                { kind: "segment", segment_id: segment.segment_id },
                segment.start_utf8,
              ),
            ),
          );
        segmentCursor = page.next_cursor;
        if (segmentCursor) segments.append(moreSegments);
        else moreSegments.remove();
      } finally {
        segmentBusy = false;
        moreSegments.disabled = false;
      }
    };
    let resourceCursor: string | null = null;
    let resourceBusy = false;
    const moreResources = button("更多资源", () => {
      void loadResources(resourceCursor).catch(() =>
        message("资源列表暂时无法验证。"),
      );
    });
    const loadResources = async (cursor: string | null) => {
      if (resourceBusy) return;
      resourceBusy = true;
      moreResources.disabled = true;
      try {
        const page = await read(send, "resources", {
          document_version_id: selectedVersion,
          limit: 50,
          cursor,
        });
        bound(page);
        if (!currentPanel()) return;
        for (const resource of page.resources) {
          const preview = button(`查看 ${resource.reference}`, () => {
            preview.disabled = true;
            void read(send, "resource", {
              document_version_id: selectedVersion,
              resource_id: resource.resource_id,
              max_bytes: 65536,
              continuation: null,
            })
              .then((result) => {
                bound(result);
                if (!currentPanel()) return;
                if (
                  result.resource.reference !== resource.reference ||
                  result.resource.resource_id !== resource.resource_id ||
                  result.resource.relation !== resource.relation ||
                  result.resource.artifact.sha256 !==
                    resource.artifact.sha256 ||
                  result.resource.artifact.byte_size !==
                    resource.artifact.byte_size ||
                  result.resource.artifact.media_type !==
                    resource.artifact.media_type ||
                  result.truncated ||
                  result.bytes_base64 === null ||
                  result.actual_range?.start_byte !== 0 ||
                  result.actual_range.end_byte !==
                    resource.artifact.byte_size ||
                  !/^image\/(png|jpeg|gif|webp)$/.test(
                    result.resource.artifact.media_type,
                  )
                ) {
                  resources.append(
                    element("p", "此资源无法完整、安全地在页面预览。"),
                  );
                  return;
                }
                const bytes = Uint8Array.from(
                  atob(result.bytes_base64),
                  (char) => char.charCodeAt(0),
                );
                const url = URL.createObjectURL(
                  new Blob([bytes], {
                    type: result.resource.artifact.media_type,
                  }),
                );
                const image = document.createElement("img");
                image.alt = resource.reference;
                image.src = url;
                image.style.maxWidth = "100%";
                image.addEventListener("load", () => URL.revokeObjectURL(url), {
                  once: true,
                });
                image.addEventListener(
                  "error",
                  () => URL.revokeObjectURL(url),
                  { once: true },
                );
                resources.append(image);
              })
              .catch(() => {
                if (currentPanel())
                  resources.append(element("p", "资源暂时无法验证。"));
                message("资源暂时无法验证。");
              })
              .finally(() => {
                preview.disabled = false;
              });
          });
          resources.append(preview);
        }
        resourceCursor = page.next_cursor;
        if (resourceCursor) resources.append(moreResources);
        else moreResources.remove();
      } finally {
        resourceBusy = false;
        moreResources.disabled = false;
      }
    };
    await Promise.all([
      loadOutline(null),
      loadSegments(null),
      loadResources(null),
    ]);
    if (!currentPanel()) return;
    if (!outline.childElementCount)
      outline.append(element("p", "没有可靠标题；可从全部片段阅读正文。"));
  };
  return launch;
}
