import type { DocumentReadResultMap } from "@sciretriever/contracts";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnchoredPopover,
  Button,
  Dialog,
  ErrorNotice,
  Icon,
  IconButton,
  Menu,
  NumberField,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  SplitPane,
  TechDetails,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { readLiterature, paperTitle } from "../../data/library.js";
import {
  navigate,
  sourceParameterKeys,
  useUrlState,
  type ReaderMode,
} from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { preferences } from "../../data/preferences.js";
import { AnimatedPanel } from "../../motion/index.js";
import { errorMessage } from "../../strings.js";
import { readFixedSource } from "../../../reading/source.js";
import { readingPosition } from "../../../reading/state.js";
import {
  readDocument,
  readPdfBytes,
  resolveReadingSources,
} from "../../../reading/transport.js";
import type {
  DocumentLinkPreview,
  PdfControls,
  ReaderFrame,
  ReaderOutlineEntry,
  ReaderResourceEntry,
  ReadingContext,
} from "../../../reading/contract.js";
import { copyText } from "../../../browser-platform.js";
import { download, OperationDialog } from "../library/OperationDialog.js";
import { SummaryView } from "./SummaryView.js";
import { ReaderInformation } from "./ReaderInformation.js";
import "./reading.css";

export default function Reader() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const id = route.literature ?? "",
    mode = route.reader,
    sourceKey = route.parameters.toString();
  const root = useRef<HTMLElement>(null),
    body = useRef<HTMLDivElement>(null),
    status = useRef<HTMLDivElement>(null),
    findStatus = useRef<HTMLSpanElement>(null),
    frame = useRef<ReaderFrame | null>(null);
  const [revision, retry] = useState(0),
    [layout, setLayout] = useState(0),
    [findOpen, setFindOpen] = useState(false),
    [search, setSearch] = useState(""),
    [pdf, setPdf] = useState<PdfControls | null>(null),
    [pdfUrl, setPdfUrl] = useState(""),
    [outline, setOutline] = useState<ReaderOutlineEntry[]>([]),
    [outlineNote, setOutlineNote] = useState(""),
    [nextMatch, setNextMatch] = useState<(() => void) | null>(null),
    [issue, setIssue] = useState<{
      message: string;
      retry?: () => void | Promise<void>;
    } | null>(null),
    [ready, setReady] = useState(false),
    [operation, setOperation] = useState<string | null>(null),
    [zoomImage, setZoomImage] = useState<{ src: string; alt: string } | null>(
      null,
    );
  const [documentLink, setDocumentLink] = useState<DocumentLinkPreview | null>(
    null,
  );
  const linkAnchor = useRef<Element | null>(null);
  const [resources, setResources] = useState<readonly ReaderResourceEntry[]>(
    [],
  );
  const [readingSettings, setReadingSettings] = useState(false);
  useLayoutEffect(() => {
    setDocumentLink(null);
    setZoomImage(null);
    setResources([]);
  }, [id, mode, sourceKey]);
  const [informationWidth, setInformationWidth] = useState(() =>
    Math.min(
      520,
      Math.max(
        250,
        Number.parseInt(
          preferences.read("sciretriever:panel:information:v1") ?? "",
          10,
        ) || 330,
      ),
    ),
  );
  const source = useMemo(() => {
    try {
      return {
        value: readFixedSource(new URLSearchParams(sourceKey)),
        error: null,
      };
    } catch (error) {
      return { value: null, error: errorMessage(error) };
    }
  }, [sourceKey]);
  const detail = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id, signal),
    enabled: !!id,
  });
  const sources = useQuery({
    queryKey: ["document", "reader-sources", id, mode, sourceKey],
    // Source mismatches are final integrity failures, never automatic retries.
    // A visible retry remains available for transient read failures.
    retry: false,
    enabled:
      !!detail.data &&
      !source.error &&
      mode !== "know" &&
      source.value?.kind !== "metadata",
    queryFn: ({ signal }) =>
      resolveReadingSources(
        {
          api,
          signal,
          root: root.current ?? document.body,
          refresh: () => retry((value) => value + 1),
        },
        detail.data!,
        source.value,
        mode === "pdf" ? "pdf" : "doc",
      ),
  });
  const position = useMemo(
    () =>
      readingPosition(
        shell.reading,
        [
          api.workspace.catalog,
          id,
          mode,
          mode === "know"
            ? new URLSearchParams(sourceKey).get("knowledge")
            : mode === "pdf"
              ? sources.data?.material
              : sources.data?.document,
        ],
        id,
      ),
    [shell.reading, api.workspace.catalog, id, mode, sources.data, sourceKey],
  );
  const layoutPosition = useMemo(() => {
    const key = [api.workspace.catalog, id, "reader-layout"];
    const existed = shell.reading.entries.has(JSON.stringify(key));
    const value = readingPosition(shell.reading, key, id);
    if (!existed) {
      const font = Number(preferences.read("sciretriever:reading:font:v1"));
      const width = preferences.read("sciretriever:reading:width:v1");
      if ([18, 20, 22, 24].includes(font)) value.fontSize = font;
      value.wide = width === "wide";
      value.fullWidth = width === "full";
    }
    return value;
  }, [shell.reading, api.workspace.catalog, id]);
  const refresh = () => retry((value) => value + 1);
  useLayoutEffect(() => {
    if (
      !detail.data ||
      !root.current ||
      !body.current ||
      !status.current ||
      !findStatus.current ||
      mode === "know" ||
      !sources.data ||
      source.error
    )
      return;
    const controller = new AbortController(),
      ctx: ReadingContext = {
        api,
        signal: controller.signal,
        root: root.current,
        refresh: () => retry((value) => value + 1),
      };
    const host = body.current;
    host.replaceChildren();
    host.dataset.literatureId = id;
    status.current.textContent = "正在读取并核验固定材料…";
    findStatus.current.replaceChildren();
    setPdf(null);
    setPdfUrl("");
    setOutline([]);
    setOutlineNote("");
    setIssue(null);
    setReady(false);
    setNextMatch(null);
    setDocumentLink(null);
    delete root.current.dataset.readingReady;
    const current: ReaderFrame = {
      documentTitle: paperTitle(detail.data),
      animateNavigation: () =>
        document.documentElement.dataset.reducedMotion !== "true",
      onResources: (resources) => {
        if (!controller.signal.aborted) setResources(resources);
      },
      onImage: (src, alt) => setZoomImage({ src, alt }),
      onDocumentLink: (preview) => {
        if (controller.signal.aborted) return;
        linkAnchor.current = preview.anchor;
        setDocumentLink(preview);
      },
      body: host,
      controls: document.createElement("div"),
      outline: document.createElement("nav"),
      status: status.current,
      findStatus: findStatus.current,
      onFind: () => {},
      beforeLayout: () => () => {},
      onPdfControls: (value) => {
        if (!controller.signal.aborted)
          setPdf((previous) =>
            previous?.page === value.page &&
            previous.total === value.total &&
            previous.zoom === value.zoom
              ? previous
              : value,
          );
      },
      onOutline: (entry) => {
        if (!controller.signal.aborted)
          setOutline((values) => [...values, entry]);
      },
      onOutlineEmpty: setOutlineNote,
      onFindNext: (value) => {
        if (!controller.signal.aborted) setNextMatch(() => value);
      },
      onIssue: (message, again) => {
        if (!controller.signal.aborted)
          setIssue(
            message ? { message, ...(again ? { retry: again } : {}) } : null,
          );
      },
    };
    frame.current = current;
    let url = "";
    const run = async () => {
      if (mode === "pdf") {
        if (!sources.data.material) {
          current.status.textContent = "尚无 PDF。可从信息栏上传或显式获取。";
          return;
        }
        const started = performance.now(),
          bytes = await readPdfBytes(ctx, sources.data.material);
        performance.measure("sciretriever-pdf-read-verify", {
          start: started,
          end: performance.now(),
        });
        controller.signal.throwIfAborted();
        url = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" }),
        );
        setPdfUrl(url);
        const engine = await import("../../../reading/pdf.js");
        controller.signal.throwIfAborted();
        await engine.renderPdf(ctx, current, position, bytes);
      } else {
        if (!sources.data.document) {
          current.status.textContent = "尚无已发布全文；阅读不会启动解析。";
          return;
        }
        const engine = await import("../../../reading/document.js");
        controller.signal.throwIfAborted();
        await engine.renderDocument(
          ctx,
          current,
          position,
          sources.data.document,
          source.value,
        );
      }
      if (!controller.signal.aborted) setReady(true);
    };
    void run().catch((error) => {
      if (!controller.signal.aborted) {
        current.status.textContent = errorMessage(error);
        setIssue({
          message: errorMessage(error),
          retry: () => retry((value) => value + 1),
        });
      }
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      host.replaceChildren();
      delete host.dataset.literatureId;
      if (frame.current === current) frame.current = null;
    };
  }, [
    api,
    detail.data,
    id,
    mode,
    sources.data,
    sourceKey,
    revision,
    position,
    source.error,
    source.value,
  ]);
  const changeLayout = (action: () => void) => {
    const restore = mode === "doc" ? frame.current?.beforeLayout() : undefined;
    action();
    setLayout((value) => value + 1);
    if (restore) requestAnimationFrame(restore);
  };
  const sourceParameters = () =>
    Object.fromEntries(
      sourceParameterKeys.flatMap((key) =>
        route.parameters.has(key) ? [[key, route.parameters.get(key)!]] : [],
      ),
    );
  const changeMode = (value: string) =>
    shell.openPaper(id, value as ReaderMode, sourceParameters());
  const fromSynthesis =
    route.parameters.get("from") === "syn" &&
    route.parameters.get("knowledge") !== route.parameters.get("artifact");
  const back = () => {
    const artifact = route.parameters.get("artifact");
    if (fromSynthesis) {
      navigate(
        { view: "syn", literature: null, artifact },
        { clearSource: true },
      );
    } else if (artifact) {
      const previous = Object.fromEntries(
        [
          "contentHash",
          "manifest",
          "statement",
          "statementHash",
          "from",
          "result",
          "resultHash",
          "collection",
        ].flatMap((key) =>
          route.parameters.has(key) ? [[key, route.parameters.get(key)!]] : [],
        ),
      );
      shell.openPaper(id, "know", {
        ...previous,
        knowledge: artifact,
        ...(previous.contentHash &&
        previous.manifest &&
        previous.statement &&
        previous.statementHash
          ? { source: "knowledge" }
          : {}),
      });
    } else
      navigate(
        {
          view: route.parameters.get("from") === "ext" ? "ext" : "ask",
          literature: null,
        },
        { clearSource: false },
      );
  };
  const downloadMarkdown = async () => {
    const documentRef = sources.data?.document;
    if (!documentRef) throw new Error("请先打开全文，固定要下载的文档版本。");
    const controller = new AbortController(),
      ctx: ReadingContext = {
        api,
        signal: controller.signal,
        root: root.current!,
        refresh,
      };
    let end = 0,
      cursor: string | null = null;
    do {
      const page: DocumentReadResultMap["segments"] = await readDocument(
        ctx,
        "segments",
        {
          document_version_id: documentRef.document_version_id,
          section_id: null,
          limit: 200,
          cursor,
        },
      );
      if (JSON.stringify(page.document) !== JSON.stringify(documentRef))
        throw new Error("文档版本发生变化");
      for (const segment of page.segments)
        end = Math.max(end, segment.end_utf8);
      cursor = page.next_cursor;
    } while (cursor);
    let continuation: string | null = null,
      offset = 0,
      text = "";
    if (!end) throw new Error("没有可下载的正文");
    do {
      const part: DocumentReadResultMap["slice"] = await readDocument(
        ctx,
        "slice",
        {
          document_version_id: documentRef.document_version_id,
          selector: { kind: "range", start_utf8: 0, end_utf8: end },
          max_bytes: 65536,
          continuation,
        },
      );
      if (
        JSON.stringify(part.document) !== JSON.stringify(documentRef) ||
        part.actual_range?.start_utf8 !== offset
      )
        throw new Error("全文续读无法核验");
      offset = part.actual_range.end_utf8;
      text += part.text;
      continuation = part.continuation;
    } while (continuation);
    if (offset !== end) throw new Error("正文尚未完整");
    download(
      new Blob([text], { type: "text/markdown;charset=utf-8" }),
      `${id}.md`,
    );
  };
  const invalidMetadata =
    source.value?.kind === "metadata" &&
    detail.data &&
    (source.value.literature_id !== id ||
      source.value.metadata_sha256 !== detail.data.metadata_sha256 ||
      source.value.metadata_revision !== detail.data.metadata_revision);
  if (source.error || invalidMetadata)
    return (
      <ErrorNotice
        message={
          source.error ?? "元数据版本已变化，不能用当前内容代替原检索来源。"
        }
      />
    );
  if (detail.error)
    return (
      <section className="page">
        <ErrorNotice
          message="暂时无法读取这篇文献，请重试或返回文献库。"
          onRetry={() => {
            void detail.refetch();
          }}
        />
        <TechDetails copyText={errorMessage(detail.error)}>
          <p>文献标识：{id}</p>
          <p>{errorMessage(detail.error)}</p>
        </TechDetails>
      </section>
    );
  if (!detail.data) return <Skeleton label="正在读取文献" rows={6} />;
  const information = (
    <ReaderInformation
      detail={detail.data}
      resources={resources}
      document={sources.data?.document ?? null}
      onOperation={setOperation}
    />
  );
  const readingControls =
    mode === "pdf" && pdf ? (
      <>
        <IconButton
          aria-label="上一页"
          isDisabled={pdf.page <= 1}
          onPress={() => pdf.go(pdf.page - 1)}
        >
          <Icon name="arrow" />
        </IconButton>
        <NumberField
          label="PDF 页码"
          value={pdf.page}
          onChange={(value) => pdf.go(value)}
          minValue={1}
          maxValue={pdf.total}
        />
        <span className="reader-page-count">/ {pdf.total}</span>
        <IconButton
          aria-label="下一页"
          isDisabled={pdf.page >= pdf.total}
          onPress={() => pdf.go(pdf.page + 1)}
        >
          <Icon name="chevron" />
        </IconButton>
        <Select
          label="PDF 缩放"
          value={String(pdf.zoom)}
          onChange={(value) =>
            pdf.zoomTo(value === "fit" ? "fit" : Number(value))
          }
          options={[
            { value: "fit", label: "适宽" },
            ...[
              ["0.75", "75%"],
              ["1", "100%"],
              ["1.25", "125%"],
              ["1.5", "150%"],
              ["2", "200%"],
            ].map(([value, label]) => ({ value: value!, label: label! })),
          ]}
        />
      </>
    ) : mode !== "pdf" ? (
      <>
        <Select
          label="阅读字号"
          value={String(layoutPosition.fontSize)}
          onChange={(value) =>
            changeLayout(() => {
              layoutPosition.fontSize = Number(value);
            })
          }
          options={[18, 20, 22, 24].map((value) => ({
            value: String(value),
            label: `${value} px`,
          }))}
        />
        <Select
          label="阅读行宽"
          value={
            layoutPosition.fullWidth
              ? "full"
              : layoutPosition.wide
                ? "wide"
                : "comfortable"
          }
          onChange={(value) =>
            changeLayout(() => {
              layoutPosition.wide = value === "wide";
              layoutPosition.fullWidth = value === "full";
            })
          }
          options={[
            { value: "comfortable", label: "舒适" },
            { value: "wide", label: "宽" },
            { value: "full", label: "全宽" },
          ]}
        />
      </>
    ) : null;
  return (
    <section
      ref={root}
      className={`react-reader reader-workspace ${!layoutPosition.information ? "reader-without-information" : ""}`}
      data-layout={layout}
      aria-label="文献阅读器"
    >
      <div className="reader-toolbar">
        <div className="reader-toolbar-start">
          <SegmentedControl
            label="阅读视图"
            value={mode}
            onChange={changeMode}
            items={[
              { id: "pdf", label: "PDF" },
              { id: "doc", label: "全文" },
              { id: "know", label: "总结" },
            ]}
          />
          <IconButton
            aria-label={layoutPosition.outline ? "收起目录" : "显示目录"}
            aria-expanded={layoutPosition.outline}
            onPress={() =>
              changeLayout(() => {
                layoutPosition.outline = !layoutPosition.outline;
              })
            }
          >
            <Icon name="menu" />
          </IconButton>
        </div>
        <div className="reader-toolbar-context">{readingControls}</div>
        <div className="reader-toolbar-end">
          <IconButton
            aria-label="文档内查找"
            isDisabled={mode !== "know" && !ready}
            aria-expanded={findOpen}
            onPress={() => setFindOpen((value) => !value)}
          >
            <Icon name="search" />
          </IconButton>
          <IconButton
            aria-label={layoutPosition.information ? "收起信息" : "显示信息"}
            aria-expanded={layoutPosition.information}
            onPress={() =>
              changeLayout(() => {
                layoutPosition.information = !layoutPosition.information;
              })
            }
          >
            <Icon name="book" />
          </IconButton>
          <Menu
            label="更多"
            icon={<Icon name="more" />}
            items={[
              {
                id: "reading-settings",
                label: "阅读设置",
                onAction: () => setReadingSettings(true),
              },
              {
                id: "find",
                label: "文档内查找",
                disabled: mode !== "know" && !ready,
                onAction: () => setFindOpen((value) => !value),
              },
              {
                id: "information",
                label: layoutPosition.information ? "收起信息" : "显示信息",
                onAction: () =>
                  changeLayout(() => {
                    layoutPosition.information = !layoutPosition.information;
                  }),
              },
              {
                id: "pdf",
                label: "下载已核验的原始 PDF",
                disabled: !pdfUrl,
                onAction: () => {
                  const a = document.createElement("a");
                  a.href = pdfUrl;
                  a.download = `${id}.pdf`;
                  a.click();
                },
              },
              {
                id: "markdown",
                label: "下载固定全文 Markdown",
                disabled: !sources.data?.document,
                onAction: () => {
                  void downloadMarkdown().catch((error) =>
                    shell.notify(errorMessage(error)),
                  );
                },
              },
              ...(api.kind === "workspace"
                ? [
                    {
                      id: "bibliography",
                      label: "导出书目",
                      onAction: () => setOperation("export"),
                    },
                  ]
                : []),
              {
                id: "copy",
                label: "复制引用",
                onAction: () => {
                  const text = `${detail.data!.literature.metadata.authors.map((a) => a.display_name).join(", ")}. ${detail.data!.literature.metadata.title ?? ""}. ${detail.data!.literature.metadata.venue ?? ""} (${detail.data!.literature.metadata.publication_year ?? ""}).`;
                  void copyText(text)
                    .then(() => shell.notify("引用已复制"))
                    .catch(() =>
                      shell.notify(
                        "浏览器未允许复制，可选择书目信息手动复制。",
                      ),
                    );
                },
              },
            ]}
          />
        </div>
      </div>
      {(route.parameters.has("artifact") || route.parameters.has("from")) && (
        <div className="reader-return">
          <Button variant="text" icon={<Icon name="arrow" />} onPress={back}>
            返回
            {fromSynthesis
              ? "综合"
              : route.parameters.has("artifact")
                ? "总结"
                : route.parameters.get("from") === "ext"
                  ? "结果"
                  : "检索"}
          </Button>
          <span>正在查看固定来源，阅读不会修改材料。</span>
        </div>
      )}
      <div className="reader-find" hidden={!findOpen}>
        <SearchField
          label="文档内查找"
          value={search}
          onChange={(value) => {
            setSearch(value);
            position.query = value;
          }}
          onSubmit={(value) => {
            if (mode !== "know")
              void Promise.resolve(frame.current?.onFind(value)).catch(
                (error) => shell.notify(errorMessage(error)),
              );
          }}
        />
        <span ref={findStatus} role="status" />
        {nextMatch && <Button onPress={nextMatch}>下一处命中</Button>}
      </div>
      <SplitPane
        label="文献信息栏宽度"
        edge="left"
        width={layoutPosition.information ? informationWidth : 0}
        onWidthChange={(value) => {
          setInformationWidth(value);
          preferences.write("sciretriever:panel:information:v1", `${value}px`);
        }}
        min={250}
        max={520}
        defaultWidth={330}
        side={
          <aside
            className="reader-information"
            hidden={!layoutPosition.information}
          >
            <AnimatedPanel preset="panelContent">{information}</AnimatedPanel>
          </aside>
        }
      >
        <div className="reader-center">
          {layoutPosition.outline && (
            <nav className="reader-outline" aria-label="文档目录">
              <h2>目录</h2>
              {outline.length ? (
                outline.map((entry, index) => (
                  <Button key={index} variant="text" onPress={entry.activate}>
                    {entry.title}
                  </Button>
                ))
              ) : (
                <p>
                  {mode === "know"
                    ? "总结按栏目组织，可在正文顶部选择。"
                    : outlineNote || "暂无可靠章节目录。"}
                </p>
              )}
            </nav>
          )}
          <div className="reader-surface">
            {sources.isFetching && mode !== "know" && (
              <p className="reading-status" role="status">
                正在核对固定材料与文档版本…
              </p>
            )}
            {sources.error && mode !== "know" ? (
              <ErrorNotice
                message={errorMessage(sources.error)}
                onRetry={() => {
                  void sources.refetch();
                }}
              />
            ) : null}
            {issue && mode !== "know" && (
              <ErrorNotice
                message={issue.message}
                retained="已加载的内容仍然保留。"
                {...(issue.retry ? { onRetry: issue.retry } : {})}
              />
            )}
            <div
              ref={body}
              className={`reading-scroll reader-engine-body ${layoutPosition.fullWidth ? "reading-full" : layoutPosition.wide ? "reading-wide" : ""}`}
              hidden={mode === "know" || source.value?.kind === "metadata"}
              style={
                {
                  "--reading-font-size": `${layoutPosition.fontSize}px`,
                } as CSSProperties
              }
            />
            {source.value?.kind === "metadata" && mode !== "know" && (
              <div className="reading-scroll">
                <article className="reading-article">
                  <p className="reader-eyebrow">固定元数据来源</p>
                  <h1>{detail.data.literature.metadata.title}</h1>
                  <p>
                    {detail.data.literature.metadata.abstract ||
                      "此版本元数据没有摘要。"}
                  </p>
                  <p className="ui-description">
                    此处核对的是原检索引用的元数据版本，不是解析全文。
                  </p>
                  <Button
                    onPress={() =>
                      shell.openPaper(id, "pdf", {
                        from: route.parameters.get("from") ?? "ask",
                      })
                    }
                  >
                    打开现有 PDF
                  </Button>
                </article>
              </div>
            )}
            {mode === "know" && (
              <div
                className={`reading-scroll reader-summary-scroll ${layoutPosition.fullWidth ? "reading-full" : layoutPosition.wide ? "reading-wide" : ""}`}
                style={
                  {
                    "--reading-font-size": `${layoutPosition.fontSize}px`,
                  } as CSSProperties
                }
              >
                <SummaryView id={id} source={source.value} search={search} />
              </div>
            )}
            <div
              ref={status}
              className="reading-status"
              role="status"
              aria-live="polite"
              hidden={mode === "know" || source.value?.kind === "metadata"}
            />
            {mode === "know" && (
              <div className="reading-status">
                已保存总结 · 选择证据编号核对原文
              </div>
            )}
          </div>
        </div>
      </SplitPane>
      {readingSettings && (
        <Dialog title="阅读设置" isOpen onOpenChange={setReadingSettings}>
          {readingControls}
        </Dialog>
      )}
      {operation && (
        <OperationDialog
          kind={operation}
          ids={[id]}
          onClose={() => setOperation(null)}
        />
      )}
      <AnchoredPopover
        label="文内引用预览"
        triggerRef={linkAnchor}
        isOpen={!!documentLink}
        onOpenChange={(open) => {
          if (!open) setDocumentLink(null);
        }}
      >
        {documentLink && (
          <div className="reader-evidence-preview">
            <strong>{documentLink.title}</strong>
            <blockquote>{documentLink.text}</blockquote>
            <Button
              onPress={() => {
                documentLink.activate();
                setDocumentLink(null);
              }}
            >
              前往文内位置
            </Button>
          </div>
        )}
      </AnchoredPopover>
      {zoomImage && (
        <Dialog
          title="查看原图"
          isOpen
          onOpenChange={(open) => {
            if (!open) setZoomImage(null);
          }}
        >
          <img
            className="reader-image-enlarged"
            src={zoomImage.src}
            alt={zoomImage.alt}
          />
        </Dialog>
      )}
    </section>
  );
}
