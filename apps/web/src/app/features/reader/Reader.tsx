import { PaperResults } from "./PaperResults.js";
import { markdown } from "../../../reading/markdown.js";
import type { DocumentReadResultMap } from "@sciretriever/contracts";
import { parsePageRegion } from "@sciretriever/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { copyText } from "../../../browser-platform.js";
import type {
  DocumentLinkPreview,
  PdfControls,
  ReaderFrame,
  ReaderOutlineEntry,
  ReaderResourceEntry,
  ReadingContext,
} from "../../../reading/contract.js";
import { readFixedSource } from "../../../reading/source.js";
import { readingPosition } from "../../../reading/state.js";
import {
  READER_PROBE,
  probeCount,
  probeCountKey,
} from "../../../reading/probe.js";
import {
  readDocument,
  readPdfBytes,
  resolveReadingSources,
} from "../../../reading/transport.js";
import {
  AnchoredPopover,
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  Icon,
  IconButton,
  Menu,
  NumberField,
  SearchField,
  SegmentedControl,
  Tabs,
  Select,
  Skeleton,
  SplitPane,
  TechDetails,
  RichTitle,
} from "../../components/index.js";
import { archiveJsonStream, archiveQuery, rows } from "../../data/archive.js";
import {
  paperCitation,
  paperTitle,
  paperTitleParts,
  readLiterature,
} from "../../data/library.js";
import { preferences } from "../../data/preferences.js";
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import { record } from "../../data/wire.js";
import {
  navigate,
  sourceParameterKeys,
  useUrlState,
  type ReaderMode,
} from "../../data/url.js";
import { AnimatedPanel } from "../../motion/index.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import { ProofreadEditor } from "./ProofreadEditor.js";
import { StructurePanel } from "../archive/StructurePanel.js";
import { useReaderMarks } from "./marks/ReaderMarks.js";
import type { MarkSurface } from "../../../reading/marks.js";
import { download, OperationDialog } from "../library/OperationDialog.js";
import { ReaderInformation } from "./ReaderInformation.js";
import { RunOperatorDialog } from "../processing/RunOperator.js";
import "./reading.css";
import { SummaryView } from "./SummaryView.js";
import { TranslationPanel } from "./translation/TranslationViews.js";
import { useReaderTranslation } from "./translation/use-translation.js";
import {
  createFullTextLayer,
  type FullTextLayer,
} from "./translation/fulltext-layer.js";
import { FullTextControls } from "./translation/FullTextControls.js";
import { ReaderOutline } from "./ReaderOutline.js";
import { useFullTextTranslation } from "./translation/use-fulltext.js";

export default function Reader() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const readerActions = useRef(shell);
  readerActions.current = shell;
  const [showSources, setShowSources] = useState(false);
  const [editorWidth, setEditorWidth] = useState(560);
  const parts = useQuery({
    queryKey: ["document", "parts", route.literature],
    enabled: !!route.literature,
    queryFn: async ({ signal }) =>
      rows(
        await archiveQuery(
          api,
          "document-parts",
          { literature_id: route.literature, offset: 0, limit: 200 },
          signal,
        ),
        "parts",
      ),
  });
  const id = route.literature ?? "",
    mode = route.reader,
    sourceKey = route.parameters.toString();
  // The material a reader engine is built for: the paper and its fixed source,
  // everything in the address except the view (`reader`) it is shown in.
  const materialKey = useMemo(() => {
    const parameters = new URLSearchParams(sourceKey);
    parameters.delete("reader");
    // Switching views may rewrite the address in another order.
    parameters.sort();
    return parameters.toString();
  }, [sourceKey]);
  const root = useRef<HTMLElement>(null),
    body = useRef<HTMLDivElement>(null),
    status = useRef<HTMLDivElement>(null),
    findStatus = useRef<HTMLSpanElement>(null),
    frame = useRef<ReaderFrame | null>(null),
    positionFrame = useRef(0);
  const [revision, retry] = useState(0),
    [layout, setLayout] = useState(0),
    [findOpen, setFindOpen] = useState(false),
    [search, setSearch] = useState(""),
    [pdf, setPdf] = useState<PdfControls | null>(null),
    [pdfUrl, setPdfUrl] = useState(""),
    [outline, setOutline] = useState<ReaderOutlineEntry[]>([]),
    [outlineNote, setOutlineNote] = useState(""),
    [readingOffset, setReadingOffset] = useState<number | null>(null),
    [nextMatch, setNextMatch] = useState<(() => void) | null>(null),
    [issue, setIssue] = useState<{
      message: string;
      retry?: () => void | Promise<void>;
    } | null>(null),
    [ready, setReady] = useState(false),
    [operation, setOperation] = useState<string | null>(null),
    [runner, setRunner] = useState(false),
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
  const [sideTab, setSideTab] = useState<"info" | "marks" | "translation">(
    "info",
  );
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
        value: readFixedSource(new URLSearchParams(materialKey)),
        error: null,
      };
    } catch (error) {
      return { value: null, error: errorMessage(error) };
    }
  }, [materialKey]);
  const detail = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id, signal),
    enabled: !!id,
  });
  const sources = useQuery({
    // Both views of one material share the resolution: the fixed PDF and, when
    // there is one, the full-text version it was published from.
    queryKey: ["document", "reader-sources", id, materialKey],
    // Source mismatches are final integrity failures, never automatic retries.
    // A visible retry remains available for transient read failures.
    retry: false,
    enabled:
      !!detail.data &&
      !source.error &&
      mode !== "know" &&
      mode !== "results" &&
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
        "doc",
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
          // The summary's place; PDF and full text keep theirs in the engine.
          mode === "know"
            ? new URLSearchParams(sourceKey).get("result")
            : materialKey,
        ],
        id,
      ),
    [shell.reading, api.workspace.catalog, id, mode, sourceKey, materialKey],
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
  const notify = (message: string) => readerActions.current.notify(message);
  const translation = useReaderTranslation(
    id,
    api.kind === "workspace" && (mode === "pdf" || mode === "doc"),
  );
  const marks = useReaderMarks({
    detail: detail.data,
    mode,
    enabled: api.kind === "workspace",
    notify,
    translation,
    onTranslate: () => setSideTab("translation"),
  });
  const fullText = useFullTextTranslation(id, translation, notify);
  const fullTextLayer = useRef<FullTextLayer | null>(null),
    fullTextMode = useRef(fullText.mode),
    marksOpen = useRef(marks.open);
  marksOpen.current = marks.open;
  // Bumped whenever another view becomes active, so its twin layer catches up.
  const [viewToken, setViewToken] = useState(0);
  const appliedMode = useRef(new WeakMap<FullTextLayer, string>());
  useEffect(() => {
    fullTextLayer.current?.setPages(fullText.pages);
  }, [fullText.pages, ready, viewToken]);
  useEffect(() => {
    fullTextLayer.current?.setMarks(marks.list);
  }, [marks.list, ready, viewToken]);
  useEffect(() => {
    fullTextMode.current = fullText.mode;
    const current = frame.current,
      layer = fullTextLayer.current;
    if (!current || !layer || appliedMode.current.get(layer) === fullText.mode)
      return;
    appliedMode.current.set(layer, fullText.mode);
    // Two columns share the width at 适宽; the engine redraws once, keeping the place.
    const restore = current.beforeLayout();
    current.pdfColumns = fullText.mode === "pair" ? 2 : 1;
    layer.setMode(fullText.mode);
    requestAnimationFrame(restore);
  }, [fullText.mode, ready, viewToken]);
  // One engine per material (spec 5.1): the PDF document with its worker, the
  // full text and their marks stay while the reader switches views; switching
  // hides one view's layer and shows the other's. Details of the paper reach
  // the information panel through its query, never through the engine.
  const marksAttach = useRef(marks.attach);
  marksAttach.current = marks.attach;
  const marksActive = useRef(marks.active);
  marksActive.current = marks.active;
  const detailRef = useRef(detail.data);
  detailRef.current = detail.data;
  const hasDetail = !!detail.data,
    reading = shell.reading,
    catalog = api.workspace.catalog;
  const [engine, setEngine] = useState<ReaderEngine | null>(null);
  useLayoutEffect(() => {
    const material = sources.data;
    if (
      !hasDetail ||
      !root.current ||
      !body.current ||
      !status.current ||
      !findStatus.current ||
      !material ||
      source.error
    )
      return;
    const controller = new AbortController(),
      host = body.current,
      readerRoot = root.current,
      statusHost = status.current,
      findHost = findStatus.current,
      fixed = new URLSearchParams(materialKey);
    if (READER_PROBE) probeCountKey("engines", "material");
    host.replaceChildren();
    host.dataset.literatureId = id;
    const set: UiSetters = {
      pdf: setPdf,
      pdfUrl: setPdfUrl,
      outline: setOutline,
      outlineNote: setOutlineNote,
      readingOffset: setReadingOffset,
      nextMatch: (value) => setNextMatch(() => value),
      issue: setIssue,
      ready: setReady,
      resources: setResources,
    };
    const urls = new Set<string>(),
      views = new Map<ViewKind, ReaderView>();
    const update = (view: ReaderView, patch: Partial<ViewUi>) => {
      Object.assign(view.ui, patch);
      if (created.active === view) applyUi(set, patch);
    };
    const syncReady = (view: ReaderView | null) => {
      if (view?.marker.dataset.readingReady === "true")
        readerRoot.dataset.readingReady = "true";
      else delete readerRoot.dataset.readingReady;
    };
    const build = (kind: ViewKind): ReaderView => {
      const layer = document.createElement("div");
      layer.className = "reader-view";
      layer.dataset.view = kind;
      layer.hidden = true;
      host.append(layer);
      const statusText = document.createElement("span");
      statusText.textContent = "正在读取并核验固定材料…";
      const view: ReaderView = {
        kind,
        layer,
        status: statusText,
        findStatus: document.createElement("span"),
        // Engines mark readiness here; it reaches the reader while the view shows.
        marker: document.createElement("div"),
        ui: emptyUi(),
        twins: null,
        surface: null,
        frame: null as unknown as ReaderFrame,
      };
      const observer = new MutationObserver(() => {
        if (created.active === view) syncReady(view);
      });
      observer.observe(view.marker, { attributes: true });
      controller.signal.addEventListener("abort", () => observer.disconnect(), {
        once: true,
      });
      const ctx: ReadingContext = {
        api,
        signal: controller.signal,
        root: view.marker,
        refresh: () => retry((value) => value + 1),
      };
      const position = readingPosition(
        reading,
        [
          catalog,
          id,
          kind,
          kind === "pdf" ? material.material : material.document,
        ],
        id,
      );
      const current: ReaderFrame = {
        onSegment: (segment) => {
          const pdfMaterial = material.material;
          if (!pdfMaterial) return;
          void leafPage(api, pdfMaterial.asset_id, segment, controller.signal)
            .then((page) => {
              readerActions.current.openPaper(id, "edit", {
                asset: pdfMaterial.asset_id,
                assetHash: pdfMaterial.asset_sha256,
                page: String(page),
              });
            })
            .catch((error) => {
              if (!controller.signal.aborted)
                readerActions.current.notify(errorMessage(error));
            });
        },
        ...(fixed.has("page")
          ? {
              pdfLocation: {
                page: Math.max(
                  1,
                  Math.min(10000, Number(fixed.get("page")) || 1),
                ),
                region: fixed.get("region")
                  ? parsePageRegion(JSON.parse(fixed.get("region")!))
                  : null,
              },
            }
          : {}),
        documentTitle:
          detailRef.current?.literature.metadata.title || "未命名文献",
        animateNavigation: () =>
          document.documentElement.dataset.reducedMotion !== "true",
        onResources: (resources) => {
          if (!controller.signal.aborted) update(view, { resources });
        },
        onImage: (src, alt) => {
          if (created.active === view) setZoomImage({ src, alt });
        },
        onDocumentLink: (preview) => {
          if (controller.signal.aborted || created.active !== view) return;
          linkAnchor.current = preview.anchor;
          setDocumentLink(preview);
        },
        body: host,
        layer,
        controls: document.createElement("div"),
        outline: document.createElement("nav"),
        status: statusText,
        findStatus: view.findStatus,
        onFind: () => {},
        beforeLayout: () => () => {},
        hide: () => {},
        show: () => {},
        onPdfControls: (value) => {
          const previous = view.ui.pdf;
          if (
            controller.signal.aborted ||
            (previous?.page === value.page &&
              previous.total === value.total &&
              previous.zoom === value.zoom)
          )
            return;
          update(view, { pdf: value });
        },
        onOutline: (entry) => {
          if (!controller.signal.aborted)
            update(view, { outline: [...view.ui.outline, entry] });
        },
        onOutlineEmpty: (note) => update(view, { outlineNote: note }),
        onPosition: (offset) => {
          view.ui.readingOffset = offset;
          // Scroll reports arrive per frame; the outline needs at most one update each.
          if (
            controller.signal.aborted ||
            created.active !== view ||
            positionFrame.current
          )
            return;
          positionFrame.current = requestAnimationFrame(() => {
            positionFrame.current = 0;
            if (!controller.signal.aborted && created.active === view)
              setReadingOffset(view.ui.readingOffset);
          });
        },
        onFindNext: (value) => {
          if (!controller.signal.aborted) update(view, { nextMatch: value });
        },
        onIssue: (message, again) => {
          if (!controller.signal.aborted)
            update(view, {
              issue: message
                ? { message, ...(again ? { retry: again } : {}) }
                : null,
            });
        },
      };
      view.frame = current;
      if (kind === "pdf") {
        // The translated twin pages live as long as this PDF document (ADR 0051).
        const twins = createFullTextLayer(
          () => layer.querySelector<HTMLElement>(".reading-pdf-pages"),
          (markId) => marksOpen.current(markId),
        );
        view.twins = twins;
        current.pdfColumns = fullTextMode.current === "pair" ? 2 : 1;
        twins.setMode(fullTextMode.current);
        appliedMode.current.set(twins, fullTextMode.current);
        current.onPdfPage = (page) => {
          view.surface?.pdfPage(page);
          twins.page(page);
        };
      } else current.onDocumentPaint = () => view.surface?.documentPainted();
      const run = async () => {
        if (kind === "pdf") {
          if (!material.material) {
            statusText.textContent = "尚无 PDF。可从信息栏上传或显式获取。";
            return;
          }
          const started = performance.now(),
            bytes = await readPdfBytes(ctx, material.material);
          performance.measure("sciretriever-pdf-read-verify", {
            start: started,
            end: performance.now(),
          });
          controller.signal.throwIfAborted();
          const url = URL.createObjectURL(
            new Blob([bytes], { type: "application/pdf" }),
          );
          urls.add(url);
          if (READER_PROBE) probeCount("objectUrlsCreated");
          update(view, { pdfUrl: url });
          const pdfEngine = await import("../../../reading/pdf.js");
          controller.signal.throwIfAborted();
          await pdfEngine.renderPdf(ctx, current, position, bytes);
        } else {
          if (!material.document) {
            statusText.textContent = "尚无已发布全文；阅读不会启动解析。";
            return;
          }
          const documentEngine = await import("../../../reading/document.js");
          controller.signal.throwIfAborted();
          await documentEngine.renderDocument(
            ctx,
            current,
            position,
            material.document,
            source.value,
          );
        }
        if (!controller.signal.aborted) update(view, { ready: true });
      };
      void run().catch((error) => {
        if (!controller.signal.aborted) {
          statusText.textContent = errorMessage(error);
          update(view, {
            issue: {
              message: errorMessage(error),
              retry: () => retry((value) => value + 1),
            },
          });
        }
      });
      views.set(kind, view);
      return view;
    };
    const created: ReaderEngine = {
      active: null,
      activate(kind) {
        const next = kind ? (views.get(kind) ?? build(kind)) : null,
          previous = created.active;
        if (previous === next) return false;
        if (previous) {
          previous.frame.hide();
          previous.layer.hidden = true;
          previous.surface?.destroy();
          previous.surface = null;
        }
        created.active = next;
        frame.current = next?.frame ?? null;
        fullTextLayer.current = next?.twins ?? null;
        statusHost.replaceChildren(...(next ? [next.status] : []));
        findHost.replaceChildren(...(next ? [next.findStatus] : []));
        applyUi(set, next?.ui ?? emptyUi());
        syncReady(next);
        if (!next) return true;
        next.layer.hidden = false;
        if (marksActive.current) {
          if (next.kind === "pdf" && material.material)
            next.surface = marksAttach.current(host, {
              kind: "pdf",
              sha256: material.material.asset_sha256,
            });
          else if (next.kind === "doc" && material.document) {
            next.surface = marksAttach.current(host, {
              kind: "doc",
              version: material.document.document_version_id,
            });
            if (next.marker.dataset.readingReady === "true")
              next.surface.documentPainted();
          }
        }
        next.frame.show();
        return true;
      },
    };
    setEngine(created);
    return () => {
      controller.abort();
      for (const view of views.values()) {
        view.surface?.destroy();
        view.twins?.destroy();
        if (fullTextLayer.current === view.twins) fullTextLayer.current = null;
        if (frame.current === view.frame) frame.current = null;
      }
      for (const url of urls) {
        URL.revokeObjectURL(url);
        if (READER_PROBE) probeCount("objectUrlsRevoked");
      }
      host.replaceChildren();
      delete host.dataset.literatureId;
      statusHost.replaceChildren();
      findHost.replaceChildren();
      delete readerRoot.dataset.readingReady;
      applyUi(set, emptyUi());
      setEngine(null);
    };
  }, [
    api,
    id,
    materialKey,
    sources.data,
    revision,
    hasDetail,
    reading,
    catalog,
    source.error,
    source.value,
  ]);
  // A view switch shows the other layer of the same engine.
  useLayoutEffect(() => {
    if (engine?.activate(viewOf(mode))) setViewToken((value) => value + 1);
  }, [engine, mode]);
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
  const changeMode = (value: string) => {
    const material = sources.data?.material;
    shell.openPaper(
      id,
      value as ReaderMode,
      value === "results"
        ? {}
        : value === "edit"
          ? material
            ? { asset: material.asset_id, assetHash: material.asset_sha256 }
            : {}
          : sourceParameters(),
    );
  };
  const fromSummary = route.parameters.get("returnReader") === "know";
  const back = () => {
    const result = route.parameters.get("result");
    if (fromSummary) {
      shell.openPaper(id, "know", {
        ...(result ? { result } : {}),
        ...(route.parameters.get("resultHash")
          ? { resultHash: route.parameters.get("resultHash")! }
          : {}),
        ...(route.parameters.get("from")
          ? { from: route.parameters.get("from")! }
          : {}),
      });
    } else if (result) {
      navigate(
        {
          view: "ext",
          literature: null,
          result,
          resultHash: route.parameters.get("resultHash"),
        },
        { clearSource: true },
      );
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
    <>
      <ReaderInformation
        detail={detail.data}
        resources={resources}
        document={sources.data?.document ?? null}
      />
      {sources.data?.document ? (
        <StructurePanel
          id={id}
          document={sources.data.document.document_version_id}
        />
      ) : null}
    </>
  );
  const readingControls =
    (mode === "pdf" || mode === "edit") && pdf ? (
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
    ) : mode === "doc" || mode === "know" ? (
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
      className={`react-reader reader-workspace ${mode === "edit" ? "reader-editing" : !layoutPosition.information ? "reader-without-information" : ""}`}
      data-layout={layout}
      aria-label="文献阅读器"
    >
      {mode !== "results" && (parts.data?.length ?? 0) > 1 ? (
        <Select
          label="阅读部分"
          value={sources.data?.material?.asset_id ?? ""}
          onChange={(asset) => {
            const part = parts.data!.find((p) => p.asset_id === asset)!;
            navigate(
              {
                view: "lib",
                literature: id,
                reader: mode,
                asset,
                assetHash: String(part.asset_sha256),
              },
              { clearSource: true },
            );
          }}
          options={parts.data!.map((p, index) => ({
            value: String(p.asset_id),
            label:
              p.role === "primary-pdf" || p.part === "main"
                ? "正文"
                : `补充材料 ${index}`,
          }))}
        />
      ) : null}
      <div className="reader-toolbar">
        <div className="reader-toolbar-start">
          <SegmentedControl
            label="阅读视图"
            value={mode === "edit" ? "doc" : mode === "know" ? "results" : mode}
            onChange={changeMode}
            items={[
              { id: "pdf", label: "PDF" },
              { id: "doc", label: "全文" },
              { id: "results", label: "结果" },
            ]}
          />
          {mode !== "results" && mode !== "edit" ? (
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
          ) : null}
          {marks.tools}
        </div>
        <div className="reader-toolbar-context">
          {mode === "pdf" && api.kind === "workspace" ? (
            <FullTextControls fullText={fullText} translation={translation} />
          ) : null}
          {mode === "doc" || mode === "edit" ? (
            <SegmentedControl
              label="全文模式"
              value={mode}
              onChange={changeMode}
              items={[
                { id: "doc", label: "阅读" },
                { id: "edit", label: "编辑" },
              ]}
            />
          ) : null}
          {mode === "know" ? (
            <Button
              variant="text"
              className="reader-back"
              icon={<Icon name="arrow" />}
              onPress={() => changeMode("results")}
            >
              全部结果
            </Button>
          ) : null}
          {readingControls}
          {mode === "doc" ? (
            <Button
              aria-pressed={showSources}
              variant="text"
              onPress={() => setShowSources((v) => !v)}
            >
              显示核对依据
            </Button>
          ) : null}
        </div>
        <div className="reader-toolbar-end">
          {api.kind === "workspace" ? (
            <Button onPress={() => setRunner(true)}>运行算子</Button>
          ) : null}
          <IconButton
            aria-label="文档内查找"
            isDisabled={mode === "results" || (mode !== "know" && !ready)}
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
            iconOnly
            items={[
              {
                id: "reading-settings",
                label: "阅读设置",
                onAction: () => setReadingSettings(true),
              },
              {
                id: "find",
                label: "文档内查找",
                disabled: mode === "results" || (mode !== "know" && !ready),
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
              ...(api.workspace.capabilities.maintenance
                ? [
                    {
                      id: "acquire",
                      label: "获取 PDF",
                      onAction: () => setOperation("acquire"),
                    },
                    {
                      id: "upload",
                      label: "上传 PDF",
                      onAction: () => setOperation("upload"),
                    },
                    {
                      id: "identity",
                      label: "核验文章身份",
                      disabled: !detail.data.primary_pdf,
                      onAction: () => setOperation("identity"),
                    },
                  ]
                : []),
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
                  void copyText(paperCitation(detail.data!))
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
      {(fromSummary || route.parameters.has("from")) && (
        <div className="reader-return">
          <Button variant="text" icon={<Icon name="arrow" />} onPress={back}>
            返回
            {fromSummary
              ? "总结"
              : route.parameters.get("from") === "ext"
                ? "结果"
                : "检索"}
          </Button>
          <span>正在查看固定来源，阅读不会修改材料。</span>
        </div>
      )}
      <div className="reader-find" hidden={!findOpen || mode === "results"}>
        <SearchField
          label="文档内查找"
          value={search}
          onChange={(value) => {
            setSearch(value);
            position.query = value;
          }}
          onSubmit={(value) => {
            if (mode !== "know" && mode !== "results")
              void Promise.resolve(frame.current?.onFind(value)).catch(
                (error) => shell.notify(errorMessage(error)),
              );
          }}
        />
        <span ref={findStatus} role="status" />
        {nextMatch && <Button onPress={nextMatch}>下一处命中</Button>}
      </div>
      <SplitPane
        label={mode === "edit" ? "校订稿编辑区宽度" : "文献信息栏宽度"}
        edge="left"
        width={
          mode === "edit"
            ? editorWidth
            : layoutPosition.information
              ? informationWidth
              : 0
        }
        onWidthChange={(value) => {
          if (mode === "edit") {
            setEditorWidth(value);
            return;
          }
          setInformationWidth(value);
          preferences.write("sciretriever:panel:information:v1", `${value}px`);
        }}
        min={mode === "edit" ? 320 : 250}
        max={mode === "edit" ? 900 : 520}
        defaultWidth={mode === "edit" ? 560 : 330}
        side={
          mode === "edit" ? (
            sources.data?.material ? (
              <ProofreadEditor
                key={`${id}:${sources.data.material.asset_id}`}
                id={id}
                asset={sources.data.material.asset_id}
                page={pdf?.page ?? 1}
                onPage={(page) => pdf?.go(page)}
              />
            ) : (
              <p>此文献尚无 PDF 材料。</p>
            )
          ) : (
            <aside
              className="reader-information"
              hidden={!layoutPosition.information}
            >
              {marks.active ? (
                <Tabs
                  label="信息栏"
                  value={sideTab}
                  onChange={(value) => setSideTab(value as typeof sideTab)}
                  items={[
                    { id: "info", label: "信息" },
                    {
                      id: "marks",
                      label: marks.count ? `批注 ${marks.count}` : "批注",
                    },
                    { id: "translation", label: "翻译" },
                  ]}
                />
              ) : null}
              {marks.active && sideTab === "marks" ? (
                marks.panel
              ) : marks.active && sideTab === "translation" ? (
                <TranslationPanel translation={translation} notify={notify} />
              ) : (
                <AnimatedPanel preset="panelContent">
                  {information}
                </AnimatedPanel>
              )}
            </aside>
          )
        }
      >
        <div className="reader-center">
          {mode !== "edit" && mode !== "results" && layoutPosition.outline && (
            <ReaderOutline
              entries={outline}
              position={readingOffset}
              onDismiss={() =>
                changeLayout(() => {
                  layoutPosition.outline = false;
                })
              }
              empty={
                <p className="reader-outline-note">
                  {mode === "know"
                    ? "总结按条目呈现，点击短证据编号核对原文。"
                    : outlineNote || "暂无可靠章节目录。"}
                </p>
              }
            />
          )}
          <div className="reader-surface">
            {sources.isFetching && mode !== "know" && mode !== "results" && (
              <p className="reading-status" role="status">
                正在核对固定材料与文档版本…
              </p>
            )}
            {sources.error && mode !== "know" && mode !== "results" ? (
              <ErrorNotice
                message={errorMessage(sources.error)}
                onRetry={() => {
                  void sources.refetch();
                }}
              />
            ) : null}
            {issue && mode !== "know" && mode !== "results" && (
              <ErrorNotice
                message={issue.message}
                retained="已加载的内容仍然保留。"
                {...(issue.retry ? { onRetry: issue.retry } : {})}
              />
            )}
            <div
              ref={body}
              data-mode={mode}
              className={`reading-scroll reader-engine-body ${showSources ? "reading-show-sources" : ""} ${layoutPosition.fullWidth ? "reading-full" : layoutPosition.wide ? "reading-wide" : ""}`}
              hidden={
                mode === "know" ||
                mode === "results" ||
                source.value?.kind === "metadata"
              }
              style={
                {
                  "--reading-font-size": `${layoutPosition.fontSize}px`,
                } as CSSProperties
              }
            />
            {marks.rail}
            {source.value?.kind === "metadata" &&
              mode !== "know" &&
              mode !== "results" && (
                <div className="reading-scroll">
                  <article className="reading-article">
                    <p className="reader-eyebrow">固定元数据来源</p>
                    <h1>
                      <RichTitle parts={paperTitleParts(detail.data)} />
                    </h1>
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
            {mode === "doc" &&
            sources.isSuccess &&
            !sources.data.document &&
            source.value?.kind !== "metadata" ? (
              <div className="reading-scroll">
                <EmptyState
                  title="这篇文献还没有建立档案"
                  description="建档后才有可阅读、可编辑的全文。"
                  {...(api.workspace.capabilities.maintenance
                    ? {
                        action: (
                          <Button
                            variant="primary"
                            isDisabled={!detail.data.primary_pdf}
                            {...(detail.data.primary_pdf
                              ? {}
                              : { disabledReason: "请先获取或上传 PDF。" })}
                            onPress={() => setOperation("archive")}
                          >
                            建立文献档案
                          </Button>
                        ),
                      }
                    : {})}
                />
              </div>
            ) : null}
            {mode === "results" ? (
              <div className="reading-scroll" data-mode="results">
                <PaperResults
                  id={id}
                  onOpenSummary={() => changeMode("know")}
                />
              </div>
            ) : null}
            {mode === "know" && (
              <div
                className={`reading-scroll reader-summary-scroll ${layoutPosition.fullWidth ? "reading-full" : layoutPosition.wide ? "reading-wide" : ""}`}
                style={
                  {
                    "--reading-font-size": `${layoutPosition.fontSize}px`,
                  } as CSSProperties
                }
              >
                <SummaryView
                  id={id}
                  source={source.value}
                  search={search}
                  position={position}
                />
              </div>
            )}
            <div
              ref={status}
              className="reading-status"
              role="status"
              aria-live="polite"
              hidden={
                mode === "know" ||
                mode === "results" ||
                source.value?.kind === "metadata"
              }
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
      {runner ? (
        <RunOperatorDialog
          fixed={{
            scope: { kind: "literatures", ids: [id] },
            label: `本篇：${paperTitle(detail.data)}`,
          }}
          onClose={() => setRunner(false)}
        />
      ) : null}
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
            <div
              className="reader-prose"
              dangerouslySetInnerHTML={{
                __html: markdown.parse(documentLink.text),
              }}
            />
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
      {marks.overlays}
    </section>
  );
}

/** The 1-based PDF page a reading segment came from, for arranged and old drafts alike. */
async function leafPage(
  api: ApiClient,
  asset: string,
  segment: string,
  signal: AbortSignal,
) {
  const request = {
    asset_id: asset,
    block_id: segment,
    limit: 1,
    unresolved_only: false,
  };
  const head = record(
    await archiveQuery(
      api,
      "proofread-inspect",
      { ...request, offset: 0 },
      signal,
    ),
    "inspect",
  );
  if (head.format === "arranged-v2") {
    const { value } = await archiveJsonStream(
      api,
      "proofread-inspect",
      request,
      "offset",
      signal,
    );
    const leaf = rows(value, "leaves")[0]?.leaf;
    return leaf && typeof leaf === "object" && "page_index" in leaf
      ? Number(leaf.page_index) + 1
      : 1;
  }
  const item = rows(head)[0];
  const block = item?.block ?? item?.draft;
  return block && typeof block === "object" && "page" in block
    ? Number(block.page) + 1
    : 1;
}

type ViewKind = "pdf" | "doc";
const viewOf = (mode: ReaderMode): ViewKind | null =>
  mode === "pdf" || mode === "edit" ? "pdf" : mode === "doc" ? "doc" : null;
/** What a view shows in the reader's own controls; kept while the view is hidden. */
interface ViewUi {
  pdf: PdfControls | null;
  pdfUrl: string;
  outline: ReaderOutlineEntry[];
  outlineNote: string;
  readingOffset: number | null;
  nextMatch: (() => void) | null;
  issue: { message: string; retry?: () => void | Promise<void> } | null;
  ready: boolean;
  resources: readonly ReaderResourceEntry[];
}
const emptyUi = (): ViewUi => ({
  pdf: null,
  pdfUrl: "",
  outline: [],
  outlineNote: "",
  readingOffset: null,
  nextMatch: null,
  issue: null,
  ready: false,
  resources: [],
});
type UiSetters = { [K in keyof ViewUi]: (value: ViewUi[K]) => void };
function applyUi(set: UiSetters, patch: Partial<ViewUi>) {
  for (const key of Object.keys(patch) as (keyof ViewUi)[])
    (set[key] as (value: unknown) => void)(patch[key]);
}
/** One display layer of an engine: the PDF pages or the full text. */
interface ReaderView {
  kind: ViewKind;
  layer: HTMLDivElement;
  status: HTMLElement;
  findStatus: HTMLElement;
  marker: HTMLElement;
  ui: ViewUi;
  frame: ReaderFrame;
  twins: FullTextLayer | null;
  surface: MarkSurface | null;
}
interface ReaderEngine {
  active: ReaderView | null;
  /** Shows the view (building it the first time); false when it already shows. */
  activate(kind: ViewKind | null): boolean;
}
