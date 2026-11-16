import { PaperResults } from "./PaperResults.js";
import { markdown } from "../../../reading/markdown.js";
import type { DocumentReadResultMap } from "@sciretriever/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type {
  DocumentLinkPreview,
  PdfControls,
  ReaderFrame,
  ReaderOutlineEntry,
  ReaderResourceEntry,
  ReadingContext,
} from "../../../reading/contract.js";
import { readFixedSource } from "../../../reading/source.js";
import {
  readingPosition,
  recallReading,
  rememberReading,
} from "../../../reading/state.js";
import {
  readDocument,
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
  SearchField,
  SegmentedControl,
  Tabs,
  Skeleton,
  SplitPane,
  TechDetails,
  RichTitle,
  type MenuOption,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import {
  paperTitle,
  paperTitleParts,
  readLiterature,
} from "../../data/library.js";
import { preferences } from "../../data/preferences.js";
import { useApi } from "../../data/query.js";
import {
  navigate,
  sourceParameterKeys,
  useUrlState,
  type ReaderMode,
} from "../../data/url.js";
import { AnimatedPanel, useMotionPreference } from "../../motion/index.js";
import { READER_PAINTED, useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import { ProofreadEditor } from "./ProofreadEditor.js";
import { StructurePanel } from "../archive/StructurePanel.js";
import { useReaderMarks } from "./marks/ReaderMarks.js";
import { download, OperationDialog } from "../library/OperationDialog.js";
import { ReaderInformation } from "./ReaderInformation.js";
import { RunOperatorDialog } from "../processing/RunOperator.js";
import "./reading.css";
import { SummaryView } from "./SummaryView.js";
import { TranslationPanel } from "./translation/TranslationViews.js";
import { useReaderTranslation } from "./translation/use-translation.js";
import { type FullTextLayer } from "./translation/fulltext-layer.js";
import { FullTextControls } from "./translation/FullTextControls.js";
import { ReaderOutline } from "./ReaderOutline.js";
import { DraftDoubt } from "./DraftDoubt.js";
import {
  createReaderEngines,
  duration,
  easing,
  loadProgress,
  viewOf,
  type ReaderIssue,
  type ReaderUpdate,
  type ViewUi,
} from "./engines.js";
import { createPreparingStore, ReaderPreparing } from "./ReaderPreparing.js";
import { ReaderPageHeader, type HeaderLine } from "./ReaderPageHeader.js";
import { pageColumn, sheetGeometry, topBarLayout } from "./geometry.js";
import { useFullTextTranslation } from "./translation/use-fulltext.js";
import { readingFont } from "./input/reading-font.js";
import { useReadingScale } from "./input/use-reading-scale.js";
import { useReaderInput } from "./input/use-reader-input.js";
import {
  commandItem,
  commandTable,
  type CommandId,
  type CommandTable,
  type ReaderCommand,
} from "./input/commands.js";
import { TEXT_SCALE, textPercent } from "./input/scale.js";
import { readingArea, readingLine } from "../../../reading/anchor.js";

export default function Reader() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const readerActions = useRef(shell);
  readerActions.current = shell;
  const [showSources, setShowSources] = useState(false),
    // “标出关键句”: kept per paper; what it marks comes with block 11.
    [keySentences, setKeySentences] = useState(false);
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
    // Spec 6.4: an open without a view leaves the choice to the reader.
    chosen = route.readerChosen,
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
    [readingOffset, setReadingOffset] = useState<number | null>(null),
    [nextMatch, setNextMatch] = useState<((step?: 1 | -1) => void) | null>(
      null,
    ),
    [issue, setIssue] = useState<ReaderIssue | null>(null),
    [empty, setEmpty] = useState<ViewUi["empty"]>(null),
    [textLevel, setTextLevel] = useState<ViewUi["textLevel"]>(null),
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
  // Reading-experience 2.5: the draft segment whose differences show.
  const [doubt, setDoubt] = useState<{
    anchor: HTMLElement;
    segmentId: string;
    documentVersionId: string;
  } | null>(null);
  const doubtAnchor = useRef<Element | null>(null);
  const [resources, setResources] = useState<readonly ReaderResourceEntry[]>(
    [],
  );
  const [sideTab, setSideTab] = useState<"info" | "marks" | "translation">(
    "info",
  );
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
    // Switching papers keeps the previous page until the new one can show (spec 5.1).
    placeholderData: keepPreviousData,
  });
  // The PDF view is asked for: its bytes download alongside the text's reads.
  const wantsPdf = useRef(false);
  const sources = useQuery({
    // Both views of one material share the resolution: the fixed PDF and, when
    // there is one, the full-text version it was published from.
    queryKey: ["document", "reader-sources", id, materialKey],
    // Source mismatches are final integrity failures, never automatic retries.
    // A visible retry remains available for transient read failures.
    retry: false,
    enabled:
      !!detail.data &&
      !detail.isPlaceholderData &&
      !source.error &&
      (!chosen || (route.reader !== "know" && route.reader !== "results")) &&
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
        wantsPdf.current,
      ),
  });
  const catalog = api.workspace.catalog;
  /**
   * Spec 6.4 (first and third rules): the view this browser remembers for the
   * paper, else what it has: text opens the full text, a PDF alone the PDF,
   * neither the empty full text with the information panel. Decided from the
   * paper's details and the sources the reader resolves anyway; null while
   * those are still on their way.
   */
  const picked = useMemo((): ReaderMode | null => {
    if (chosen || !detail.data || detail.isPlaceholderData) return null;
    const remembered = recallReading(catalog, id).view,
      hasPdf = !!detail.data.primary_pdf;
    if (remembered === "doc") return "doc";
    if (remembered === "pdf" && hasPdf) return "pdf";
    if (!hasPdf || source.value?.kind === "metadata" || source.error)
      return hasPdf ? "pdf" : "doc";
    if (sources.isError) return "pdf";
    if (!sources.data) return null;
    return sources.data.document
      ? "doc"
      : sources.data.material
        ? "pdf"
        : "doc";
  }, [
    chosen,
    detail.data,
    detail.isPlaceholderData,
    catalog,
    id,
    source.value,
    source.error,
    sources.isError,
    sources.data,
  ]);
  // Until the choice is made the toolbar shows the likely view.
  const mode: ReaderMode = chosen
    ? route.reader
    : (picked ?? (detail.data?.primary_pdf ? "pdf" : "doc"));
  wantsPdf.current = (chosen || !!picked) && viewOf(mode) === "pdf";
  useLayoutEffect(() => {
    setDocumentLink(null);
    setDoubt(null);
    setZoomImage(null);
    setResources([]);
  }, [id, mode, sourceKey]);
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
      const width = preferences.read("sciretriever:reading:width:v1");
      value.wide = width === "wide";
      value.fullWidth = width === "full";
      // This paper's own panel, as last left in this browser (spec 4.5).
      const memory = recallReading(api.workspace.catalog, id);
      if (typeof memory.information === "boolean")
        value.information = memory.information;
    }
    return value;
  }, [shell.reading, api.workspace.catalog, id]);
  // Spec 4.5: one reading size in this browser, shared by every paper.
  const fontSize = useSyncExternalStore(
    readingFont.subscribe,
    readingFont.get,
    readingFont.get,
  );
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
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
  // The page's live engines (spec 5.1): one per material, the current tab's
  // and the previous tab's. Switching views only hides one layer and shows
  // the other; details of the paper reach the information panel through its
  // query, never through an engine.
  const marksAttach = useRef(marks.attach);
  marksAttach.current = marks.attach;
  const marksActive = useRef(marks.active);
  marksActive.current = marks.active;
  const detailRef = useRef(detail.data);
  detailRef.current = detail.data;
  // The latest step of whichever view is being prepared, shown or still off screen.
  const [preparingStore] = useState(createPreparingStore);
  const [shown, setShown] = useState<ViewUi["shown"]>(null),
    [prepared, setPrepared] = useState(false),
    [headerHost, setHeaderHost] = useState<HTMLElement | null>(null),
    // The top bar is narrower than 640 px: the page header shows the title (spec 1.2).
    [narrowTop, setNarrowTop] = useState(false);
  // The first drawn screen lets the shell warm the other pages (cold open).
  useEffect(() => {
    if (prepared) window.dispatchEvent(new Event(READER_PAINTED));
  }, [prepared]);
  const [update, setUpdate] = useState<ReaderUpdate | null>(null),
    [note, setNote] = useState<string | null>(null),
    [historyBack, setHistoryBack] = useState<{ label: string } | null>(null);
  const changeModeRef = useRef<(value: string) => void>(() => {});
  const coverRef = useRef<() => void>(() => {});
  const [engines] = useState(() =>
    createReaderEngines({
      root: () => root.current,
      findHost: () => findStatus.current,
      set: {
        pdf: setPdf,
        pdfUrl: setPdfUrl,
        outline: setOutline,
        outlineNote: setOutlineNote,
        readingOffset: setReadingOffset,
        nextMatch: (value) => setNextMatch(() => value),
        issue: setIssue,
        empty: setEmpty,
        textLevel: setTextLevel,
        ready: setReady,
        resources: setResources,
        shown: setShown,
        prepared: setPrepared,
        header: setHeaderHost,
      },
      frame,
      twins: fullTextLayer,
      appliedMode: appliedMode.current,
      fullTextMode: () => fullTextMode.current,
      marksActive: () => marksActive.current,
      attachMarks: (host, material, onJump) =>
        marksAttach.current(host, material, onJump),
      openMark: (markId) => marksOpen.current(markId),
      image: (src, alt) => setZoomImage({ src, alt }),
      documentLink: (preview) => {
        linkAnchor.current = preview.anchor;
        setDocumentLink(preview);
      },
      doubt: (target) => {
        doubtAnchor.current = target.anchor;
        setDoubt(target);
      },
      cover: () => coverRef.current(),
      progress: (paper, kind, progress) =>
        preparingStore.set({ id: paper, kind, progress }),
      openPaper: (paper, value, parameters) =>
        readerActions.current.openPaper(paper, value, parameters),
      notify: (message) => readerActions.current.notify(message),
      retry: () => retry((value) => value + 1),
      viewChanged: () => setViewToken((value) => value + 1),
      offer: setUpdate,
      note: setNote,
      history: setHistoryBack,
      changeView: (kind) => changeModeRef.current(kind),
      fontSize: () => fontSizeRef.current,
    }),
  );
  const detailReady = !!detail.data && !detail.isPlaceholderData,
    reading = shell.reading;
  // The view is picked: it goes into the address, in place of the open.
  useLayoutEffect(() => {
    if (!picked) return;
    // Only a bibliography: the information panel says what is missing (spec 3.9).
    if (!detail.data?.primary_pdf && !layoutPosition.information) {
      layoutPosition.information = true;
      setLayout((value) => value + 1);
    }
    navigate({ reader: picked }, { replace: true });
  }, [picked, detail.data, layoutPosition]);
  // No PDF: the paper does not open in the PDF view (spec 6.4), unless a fixed source names one.
  useLayoutEffect(() => {
    if (
      chosen &&
      route.reader === "pdf" &&
      detailReady &&
      !detail.data?.primary_pdf &&
      !route.parameters.has("asset") &&
      !route.parameters.has("document")
    )
      navigate({ reader: "doc" }, { replace: true });
  }, [chosen, route.reader, route.parameters, detailReady, detail.data]);
  useLayoutEffect(() => {
    // Until the view is picked nothing is built, and what shows stays.
    if (chosen) engines.view(viewOf(mode));
  }, [engines, mode, chosen]);
  // Spec 1.1: the sheet's geometry follows the desk's width and the reading
  // size; there is no separate width setting (spec 1.3).
  const columnEm = 34;
  /** Lays the sheet out for a reading size at once, in this frame (spec 1.8.1). */
  const geometry = useRef<(size: number) => void>(() => {});
  useLayoutEffect(() => {
    const scroller = body.current,
      page = root.current;
    if (!scroller || !page) return;
    const apply = (size = fontSizeRef.current) => {
      // Without the shell's top bar, the page's own width decides (spec 1.2).
      setNarrowTop(page.clientWidth > 0 && page.clientWidth < 640);
      const desk = scroller.clientWidth;
      if (!desk) return;
      // On the surface: the scroll area and the skeleton over it share it.
      const g = sheetGeometry(desk, size, columnEm),
        surface = scroller.parentElement ?? scroller,
        style = surface.style;
      style.setProperty("--sheet-width", `${g.sheet}px`);
      style.setProperty("--sheet-left", `${g.left}px`);
      style.setProperty("--sheet-margin-left", `${g.marginLeft}px`);
      style.setProperty("--sheet-margin-right", `${g.marginRight}px`);
      style.setProperty("--sheet-column", `${g.column}px`);
      style.setProperty("--sheet-header-indent", `${g.headerIndent}px`);
      scroller.dataset.sheet = g.tier;
      surface.dataset.sheet = g.tier;
      scroller.dataset.notes = g.notes;
    };
    geometry.current = apply;
    apply();
    const observer = new ResizeObserver(() => apply());
    observer.observe(scroller);
    observer.observe(page);
    return () => observer.disconnect();
  }, [fontSize, columnEm, layout, detailReady]);
  /**
   * Spec 6.1: the side panel slides in from the right (--dur-3, --ease-out)
   * and out (--dur-2, --ease-in), and the sheet moves to its new place on
   * the desk by a translation at the same time. Reduced motion: at once.
   */
  const { reduced } = useMotionPreference();
  const panelShown = layoutPosition.information && !shell.readerFocus;
  const [panelLeaving, setPanelLeaving] = useState(false);
  // When the person asked: the slide ends its token's time after that
  // (spec 6.1), counting the frame it starts in.
  const panelInput = useRef(0);
  const remaining = (total: number) => {
    const spent = performance.now() - panelInput.current + 16;
    return spent >= 0 && spent < total ? Math.max(60, total - spent) : total;
  };
  const panelBefore = useRef<boolean | null>(null),
    panelInputs = useRef({
      reduced,
      mode,
      informationWidth,
      pdf,
      layoutPosition,
    });
  panelInputs.current = {
    reduced,
    mode,
    informationWidth,
    pdf,
    layoutPosition,
  };
  useLayoutEffect(() => {
    const { reduced, mode, informationWidth, pdf } = panelInputs.current;
    const before = panelBefore.current;
    panelBefore.current = panelShown;
    const scroller = body.current;
    if (before === null || before === panelShown || !scroller) return;
    if (reduced || mode === "edit") return;
    const opening = panelShown,
      ms = remaining(
        duration(opening ? "--dur-3" : "--dur-2", opening ? 240 : 180),
      ),
      ease = opening
        ? easing("--ease-out", "ease-out")
        : easing("--ease-in", "ease-in");
    // Where the sheet (or the PDF's page column) was and is now on the desk.
    const desk = scroller.clientWidth,
      was = opening ? desk + informationWidth : desk - informationWidth;
    const pages = scroller.querySelector<HTMLElement>(
        ".reader-engine:not([hidden]) .reader-view:not([hidden]) .reading-pdf-pages",
      ),
      zoomed = Number.parseFloat(
        pages?.style.getPropertyValue("--pdf-page-width") ?? "",
      );
    const left = (width: number) =>
      pages && pdf && pdf.zoom !== "fit" && zoomed > 0
        ? pageColumn(width, fontSizeRef.current, zoomed).left
        : sheetGeometry(width, fontSizeRef.current).left;
    const shift = left(was) - left(desk);
    const engine = scroller.querySelector<HTMLElement>(
      ".reader-engine:not([hidden])",
    );
    if (engine && Math.abs(shift) >= 1)
      engine.animate(
        [{ transform: `translateX(${shift}px)` }, { transform: "none" }],
        { duration: ms, easing: ease },
      );
    if (opening)
      root.current
        ?.querySelector<HTMLElement>(".reader-information")
        ?.animate([{ transform: "translateX(100%)" }, { transform: "none" }], {
          duration: ms,
          easing: ease,
        });
    else setPanelLeaving(true);
  }, [panelShown]);
  useLayoutEffect(() => {
    if (!panelLeaving) return;
    const aside = root.current?.querySelector<HTMLElement>(
      ".reader-information",
    );
    if (!aside) return setPanelLeaving(false);
    const animation = aside.animate(
      [{ transform: "none" }, { transform: "translateX(100%)" }],
      {
        duration: remaining(duration("--dur-2", 180)),
        easing: easing("--ease-in", "ease-in"),
        fill: "forwards",
      },
    );
    animation.onfinish = () => {
      // Gone in this frame; the page catches up with its next render.
      aside.hidden = true;
      setPanelLeaving(false);
    };
    return () => animation.cancel();
  }, [panelLeaving]);
  // One line under the page header, at most (spec 1.2): a note, else the
  // offer of a new text, else the way back to a fixed source.
  const backRef = useRef<() => void>(() => {}),
    fromWhere =
      route.parameters.get("returnReader") === "know"
        ? "返回总结"
        : route.parameters.has("from")
          ? route.parameters.get("from") === "ext"
            ? "返回结果"
            : "返回检索"
          : null;
  // A fixed text passage: its paragraphs are marked, and it has no PDF page.
  const evidenceNote =
    source.value?.kind === "document" && mode === "doc"
      ? "高亮为证据所在段落；无可靠 PDF 页码"
      : "";
  const headerLine = useMemo(
    (): HeaderLine | null =>
      note
        ? { transient: true, text: note }
        : update
          ? {
              transient: false,
              text: "有新版本文本。",
              action: { label: "切换", run: update.apply },
            }
          : fromWhere
            ? {
                transient: false,
                text: `正在查看固定来源，阅读不会修改材料。${evidenceNote ? `${evidenceNote}。` : ""}`,
                action: { label: fromWhere, run: () => backRef.current() },
              }
            : null,
    [note, update, fromWhere, evidenceNote],
  );
  useLayoutEffect(() => {
    const material = sources.data;
    if (!chosen || !detailReady || !body.current || !material || source.error)
      return;
    engines.open(
      {
        key: materialKey,
        id,
        api,
        material,
        source: source.value,
        reading,
        catalog,
        title: detailRef.current?.literature.metadata.title || "未命名文献",
        revision,
      },
      body.current,
    );
  }, [
    engines,
    chosen,
    detailReady,
    materialKey,
    id,
    api,
    sources.data,
    source.value,
    source.error,
    reading,
    catalog,
    revision,
  ]);
  // A closed tab releases its engine; leaving the reader releases them all.
  useEffect(() => {
    const close = (literatureId: string) => engines.close(literatureId);
    reading.closed.add(close);
    return () => {
      reading.closed.delete(close);
    };
  }, [engines, reading]);
  useEffect(() => () => engines.destroy(), [engines]);
  // Reading-experience 1.8: the reading scale, the keys and the context menu.
  const [desk, setDesk] = useState<HTMLElement | null>(null);
  /** A reading size at once, in this frame: the text and the sheet (spec 1.8.1). */
  const applyFont = (size: number) => {
    fontSizeRef.current = size;
    for (const element of [
      body.current,
      root.current?.querySelector<HTMLElement>(".reader-summary-scroll"),
    ])
      element?.style.setProperty("--reading-font-size", `${size}px`);
    geometry.current(size);
  };
  const scale = useReadingScale({
    view:
      mode === "doc" ? "doc" : mode === "pdf" || mode === "edit" ? "pdf" : null,
    desk,
    frame: frame.current,
    pdf,
    applyFont,
    readingLine: () =>
      body.current
        ? readingLine(readingArea(body.current, headerHost ?? undefined))
        : null,
  });
  const input = useReaderInput();
  const table = useRef<CommandTable>(new Map());
  const [pageEdit, setPageEdit] = useState(0);
  // The term last looked for: Enter again goes on to the next match (spec 1.8.5).
  const findAsked = useRef("");
  // A tab or view switch closes the context menu without acting (spec 1.8.2).
  const closeMenu = input.closeMenu;
  useEffect(() => closeMenu(), [id, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The side panel tab and the evidence switch are kept per paper (spec 4.5).
  useLayoutEffect(() => {
    const memory = recallReading(catalog, id);
    if (
      memory.sideTab === "info" ||
      memory.sideTab === "marks" ||
      memory.sideTab === "translation"
    )
      setSideTab(memory.sideTab);
    setShowSources(memory.sources === true);
    setKeySentences(memory.keySentences === true);
  }, [catalog, id]);
  const changeLayout = (action: () => void) => {
    const restore = mode === "doc" ? frame.current?.beforeLayout() : undefined;
    action();
    setLayout((value) => value + 1);
    if (restore) requestAnimationFrame(restore);
    rememberReading(api.workspace.catalog, id, {
      information: layoutPosition.information,
    });
  };
  const sourceParameters = () =>
    Object.fromEntries(
      sourceParameterKeys.flatMap((key) =>
        route.parameters.has(key) ? [[key, route.parameters.get(key)!]] : [],
      ),
    );
  changeModeRef.current = (value: string) => changeMode(value);
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
  backRef.current = () => back();
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
  // Spec 3.9: what the paper lacks, said on the page where its text would be.
  const lacking =
    (mode === "doc" || mode === "pdf") &&
    sources.isSuccess &&
    source.value?.kind !== "metadata"
      ? !sources.data.material
        ? ("bibliography" as const)
        : mode === "doc" && !sources.data.document
          ? ("text" as const)
          : // The engine found nothing to read in what it was given.
            shown?.id === id && shown.kind === viewOf(mode) && empty
            ? empty === "text"
              ? ("text" as const)
              : ("bibliography" as const)
            : null
      : null;
  // Spec 6.2 and 6.3: the view asked for is not on screen, or not drawn yet.
  const wanted =
    source.value?.kind === "metadata" || !detail.data ? null : viewOf(mode);
  const preparing =
    !!wanted &&
    !issue &&
    !sources.error &&
    !lacking &&
    !(shown?.id === id && shown.kind === wanted && prepared);
  // Shown only past 300 ms: what is ready sooner replaces the old picture directly.
  const preparingKey = preparing ? `${id}|${wanted}|${revision}` : null;
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (!preparingKey) return;
    const timer = setTimeout(() => setLate(preparingKey), 300);
    return () => clearTimeout(timer);
  }, [preparingKey]);
  // The engines swap in a view that is not ready yet only past 300 ms; the
  // skeleton is committed first, in the same task, so no empty frame paints.
  coverRef.current = () => {
    if (preparingKey && late !== preparingKey)
      flushSync(() => setLate(preparingKey));
  };
  const skeleton =
    preparing && late === preparingKey && wanted ? (
      <ReaderPreparing
        kind={wanted}
        paper={detail.data && !detail.isPlaceholderData ? detail.data : null}
        id={id}
        store={preparingStore}
        initial={loadProgress(wanted, wanted === "pdf" ? "download" : "read")}
        narrow={
          shell.readerBarWidth > 0
            ? topBarLayout(shell.readerBarWidth).views === "menu"
            : narrowTop
        }
        fontSize={fontSize}
      />
    ) : null;
  const invalidMetadata =
    source.value?.kind === "metadata" &&
    detail.data &&
    !detail.isPlaceholderData &&
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
  // The text read is a draft: no editing and no structure annotation (technical 04 §8.10).
  const draftText =
    textLevel === "draft" ||
    (textLevel === null && detail.data.text_level === "draft");
  // The empty full text offers “建立文献档案”: one primary button per screen.
  const archiveInText =
    lacking === "text" && !!api.workspace.capabilities.maintenance;
  const information = (
    <>
      <ReaderInformation
        detail={detail.data}
        resources={resources}
        document={sources.data?.document ?? null}
        archivePrimaryElsewhere={archiveInText}
      />
      {sources.data?.document && !draftText ? (
        <StructurePanel
          id={id}
          document={sources.data.document.document_version_id}
        />
      ) : null}
    </>
  );
  // Spec 1.3: the top bar. The shell holds the navigation button and the
  // paper tabs; the view, find, type, side panel and “更多” come from here.
  const barWidth = shell.readerBarWidth,
    barLayout = topBarLayout(barWidth);
  const compactBar = barLayout.tools === "more",
    narrowBar = barLayout.views === "menu";
  const hasPdf = !!detail.data.primary_pdf || !!sources.data?.material;
  const views = [
    { id: "doc", label: "原文" },
    ...(hasPdf ? [{ id: "pdf", label: "PDF" }] : []),
  ];
  // Editing the proofread text is not one of the views: leaving it is choosing one.
  const viewValue = mode === "pdf" ? "pdf" : mode === "doc" ? "doc" : "";
  const findDisabled = mode === "results" || (mode !== "know" && !ready);
  const toggleFind = () => setFindOpen((value) => !value);
  const toggleOutline = () =>
    changeLayout(() => {
      layoutPosition.outline = !layoutPosition.outline;
    });
  // Spec 1.7: focus mode closes the side panel without changing what is kept
  // for the paper; leaving it brings the panel back as it was.
  const focus = shell.readerFocus,
    informationShown = layoutPosition.information && !focus;
  const toggleInformation = () => {
    panelInput.current = performance.now();
    if (focus) {
      shell.setReaderFocus(false);
      if (layoutPosition.information) return;
    }
    changeLayout(() => {
      layoutPosition.information = !layoutPosition.information;
    });
  };
  const toggleFocus = () => {
    panelInput.current = performance.now();
    shell.setReaderFocus(!focus);
  };
  const pdfZoom = mode === "pdf" || mode === "edit";
  const scalable = mode === "doc" || (pdfZoom && !!pdf);
  const tabs = shell.tabs;
  const views3 = views.some((v) => v.id === "doc"),
    views4 = views.some((v) => v.id === "pdf");
  const viewKind: "doc" | "pdf" | null =
    mode === "doc" ? "doc" : pdfZoom ? "pdf" : null;
  const scrollable = mode === "doc" || pdfZoom;
  // A fixed source is read, never marked (spec 1.8.2 “资料可以批注时”).
  const canMark = marks.active && !fromSummary && !route.parameters.has("from");
  /** Opens the find bar, with a short selection in one block as the term (spec 1.8.5). */
  const openFind = () => {
    if (findDisabled) return;
    const selection = getSelection(),
      text = selection && !selection.isCollapsed ? selection.toString() : "";
    const node = selection?.rangeCount
      ? selection.getRangeAt(0).commonAncestorContainer
      : null;
    const inReader = !!(
      node instanceof Element ? node : node?.parentElement
    )?.closest(".reader-surface");
    setFindOpen(true);
    if (
      inReader &&
      text.trim() &&
      [...text].length <= 80 &&
      !/\n/u.test(text.trim())
    )
      findText(text.trim());
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLInputElement>(".reader-find input")
        ?.focus(),
    );
  };
  /** Looks for `text` at once, as typed in the find bar and submitted. */
  const findText = (text: string) => {
    setFindOpen(true);
    setSearch(text);
    position.query = text;
    findAsked.current = text;
    if (mode !== "know" && mode !== "results")
      void Promise.resolve(frame.current?.onFind(text)).catch((error) =>
        shell.notify(errorMessage(error)),
      );
  };
  /**
   * Reading-experience 1.8: the reader's operations, each once. The menus,
   * the context menus, the keys and the shortcut list all read this table;
   * what this paper or deployment lacks is not in it.
   */
  const commandList: (ReaderCommand | null | false)[] = [
    views3 && {
      id: "view-doc",
      run: () => void (viewValue !== "doc" && changeMode("doc")),
    },
    views4 && {
      id: "view-pdf",
      run: () => void (viewValue !== "pdf" && changeMode("pdf")),
    },
    scalable && {
      id: "zoom-in",
      enabled: scale.can(1),
      keepOpen: true,
      run: () => void scale.step(1),
    },
    scalable && {
      id: "zoom-out",
      enabled: scale.can(-1),
      keepOpen: true,
      run: () => void scale.step(-1),
    },
    scalable && {
      id: "zoom-reset",
      label: pdfZoom ? "适合宽度" : "恢复默认",
      ...(pdfZoom ? { checked: pdf?.zoom === "fit" } : {}),
      run: () => void scale.reset(),
    },
    pdfZoom && !!pdf && { id: "zoom-actual", run: () => void scale.actual() },
    mode !== "results" &&
      mode !== "edit" && {
        id: "outline",
        label: layoutPosition.outline ? "收起目录" : "显示目录",
        run: toggleOutline,
      },
    {
      id: "focus",
      label: focus ? "退出专注模式" : "进入专注模式",
      run: toggleFocus,
    },
    ...(scrollable
      ? ([
          { id: "page-down", run: (e) => input.scroll.page(1, !!e?.repeat) },
          { id: "page-up", run: (e) => input.scroll.page(-1, !!e?.repeat) },
          { id: "line-down", run: (e) => input.scroll.line(1, !!e?.repeat) },
          { id: "line-up", run: (e) => input.scroll.line(-1, !!e?.repeat) },
          ...(pdfZoom
            ? ([
                {
                  id: "line-right",
                  run: (e) => input.scroll.side(1, !!e?.repeat),
                },
                {
                  id: "line-left",
                  run: (e) => input.scroll.side(-1, !!e?.repeat),
                },
              ] as ReaderCommand[])
            : []),
          { id: "start", run: () => input.scroll.edge(false) },
          { id: "end", run: () => input.scroll.edge(true) },
          {
            id: "next-part",
            label: pdfZoom ? "下一页" : "下一节",
            run: () => input.scroll.part(1),
          },
          {
            id: "previous-part",
            label: pdfZoom ? "上一页" : "上一节",
            run: () => input.scroll.part(-1),
          },
        ] as ReaderCommand[])
      : []),
    pdfZoom &&
      !!pdf && { id: "go-page", run: () => setPageEdit((value) => value + 1) },
    // Alt+← asks the engine each time: its history changes without a render.
    { id: "back", run: () => engines.back() },
    { id: "forward", run: () => engines.forward() },
    { id: "find", enabled: !findDisabled, run: openFind },
    // F3 and Ctrl+G are the reader's only while the find bar has a term (spec 1.8.5).
    findOpen &&
      !!search &&
      !!nextMatch && { id: "find-next", run: () => nextMatch(1) },
    findOpen &&
      !!search &&
      !!nextMatch && { id: "find-previous", run: () => nextMatch(-1) },
    ...marks.commands.filter(
      (command) =>
        canMark ||
        !["tool-pen", "tool-region", "mark-color", "note"].includes(command.id),
    ),
    tabs.list.length > 0 && { id: "tab-close", run: () => tabs.close("one") },
    {
      id: "tab-reopen",
      enabled: tabs.canReopen,
      run: () => tabs.reopen(),
    },
    tabs.list.length > 0 && { id: "tab-next", run: () => tabs.cycle(1) },
    tabs.list.length > 0 && { id: "tab-previous", run: () => tabs.cycle(-1) },
    tabs.list.length > 0 && {
      id: "tab-close-others",
      enabled: tabs.list.length > 1,
      run: () => tabs.close("others"),
    },
    tabs.list.length > 0 && {
      id: "tab-close-all",
      run: () => tabs.close("all"),
    },
    { id: "context-menu", run: () => input.openByKeyboard(tabs) },
    { id: "shortcuts", run: () => input.openShortcuts() },
  ];
  const commands = commandTable(commandList);
  table.current = commands;
  const item = (id: CommandId, more: Partial<MenuOption> = {}) => {
    const command = commands.get(id);
    return command ? [commandItem(command, more)] : [];
  };
  // “排版” (spec 1.3): the scale group under its title, then the two switches.
  const typeItems: MenuOption[] = [
    ...(scalable
      ? [
          {
            id: "scale-title",
            label: `比例 ${pdfZoom ? scale.percent() : textPercent(fontSize)}`,
            heading: true,
            onAction: () => {},
          },
          ...item("zoom-in"),
          ...item("zoom-out"),
          ...item("zoom-reset"),
          ...item("zoom-actual"),
        ]
      : []),
    {
      id: "key-sentences",
      label: "标出关键句",
      checked: keySentences,
      divider: true,
      onAction: () => {
        setKeySentences(!keySentences);
        rememberReading(catalog, id, { keySentences: !keySentences });
      },
    },
    ...(mode === "doc"
      ? [
          {
            id: "sources",
            label: "显示核对依据",
            checked: showSources,
            onAction: () => {
              setShowSources(!showSources);
              rememberReading(catalog, id, { sources: !showSources });
            },
          },
        ]
      : []),
  ];
  const partItems =
    mode !== "results" && (parts.data?.length ?? 0) > 1
      ? parts.data!.map((p, index) => ({
          id: `part-${p.asset_id}`,
          label:
            p.role === "primary-pdf" || p.part === "main"
              ? "正文"
              : `补充材料 ${index}`,
          checked: sources.data?.material?.asset_id === p.asset_id,
          onAction: () =>
            navigate(
              {
                view: "lib",
                literature: id,
                reader: mode,
                asset: String(p.asset_id),
                assetHash: String(p.asset_sha256),
              },
              { clearSource: true },
            ),
        }))
      : [];
  const moreItems: MenuOption[] = [
    // Below 760 px the icon buttons fold in here (spec 1.3).
    ...(compactBar
      ? [
          ...item("find"),
          {
            id: "type",
            label: "排版",
            onAction: () => {},
            submenu: typeItems,
          },
          {
            id: "information",
            label: informationShown ? "收起信息" : "显示信息",
            onAction: toggleInformation,
          },
        ]
      : []),
    ...(api.kind === "workspace"
      ? [
          {
            id: "run",
            label: "运行算子…",
            divider: compactBar,
            onAction: () => setRunner(true),
          },
        ]
      : []),
    // Reading-experience 3.4: a draft takes no edits; there is no proofread
    // text to edit until it is archived.
    ...(sources.data?.material && !draftText
      ? [
          {
            id: "edit",
            label: "编辑校订稿",
            checked: mode === "edit",
            onAction: () => changeMode(mode === "edit" ? "doc" : "edit"),
          },
        ]
      : []),
    ...item("outline"),
    ...item("focus"),
    // The marking tools (spec 1.3); the keys V, H, R and 1–5 still choose them.
    ...item("tool-pen", { divider: true }),
    ...item("tool-region"),
    ...item("mark-color"),
    ...(partItems.length
      ? [
          {
            id: "parts",
            label: "阅读部分",
            divider: true,
            onAction: () => {},
            submenu: partItems,
          },
        ]
      : []),
    ...(api.workspace.capabilities.maintenance
      ? [
          {
            id: "acquire",
            label: "获取 PDF",
            divider: true,
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
    ...(api.kind === "workspace"
      ? [
          {
            id: "bibliography",
            label: "导出书目",
            divider: !api.workspace.capabilities.maintenance,
            onAction: () => setOperation("export"),
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
      label: "下载全文 Markdown",
      disabled: !sources.data?.document,
      onAction: () => {
        void downloadMarkdown().catch((error) =>
          shell.notify(errorMessage(error)),
        );
      },
    },
    // Temporary until block 09: the results enter from the information panel.
    {
      id: "results",
      label: "加工结果",
      divider: true,
      onAction: () => changeMode("results"),
    },
    ...item("shortcuts", { divider: true }),
  ];
  input.bind({
    table,
    body: body.current,
    desk,
    header: headerHost,
    view: viewKind,
    frame,
    pdf,
    marks: canMark || marks.active ? marks.menu : null,
    abilities: {
      canMark,
      canTranslate: api.kind === "workspace",
      otherView:
        viewKind === "doc" ? views4 : views3 && !!sources.data?.document,
    },
    canGoBack: () => engines.canBack(),
    back: () => engines.back(),
    forward: () => engines.forward(),
    // Spec 1.8.6, after the marks' layers: the picture, the outline, focus mode.
    escape: () => {
      if (documentLink) return (void setDocumentLink(null), true);
      if (doubt) return (void setDoubt(null), true);
      if (zoomImage) return (void setZoomImage(null), true);
      if (layoutPosition.outline && mode !== "results" && mode !== "edit") {
        toggleOutline();
        return true;
      }
      if (focus) {
        panelInput.current = performance.now();
        shell.setReaderFocus(false);
        return true;
      }
      return false;
    },
    notify,
    cite: (quote, page) => marks.menu.cite(quote, page),
    translate: (text, page) => {
      if (!translation.settings.auto) void translation.translate(text, page);
      setSideTab("translation");
      if (!informationShown) toggleInformation();
    },
    find: findText,
    zoomImage: (src, alt) => setZoomImage({ src, alt }),
    otherView: () => changeMode(viewKind === "doc" ? "pdf" : "doc"),
    animate: () => !reduced,
  });
  const topBarTools = (
    <>
      {narrowBar ? (
        <Menu
          label={`视图：${views.find((v) => v.id === viewValue)?.label ?? "加工结果"}`}
          variant="text"
          indicator
          className="reader-view-menu"
          items={views
            .filter((v) => v.id !== viewValue)
            .map((v) => ({
              id: v.id,
              label: v.label,
              onAction: () => changeMode(v.id),
            }))}
        />
      ) : (
        <SegmentedControl
          label="阅读视图"
          value={viewValue}
          onChange={changeMode}
          items={views}
        />
      )}
      {compactBar ? null : (
        <>
          <IconButton
            aria-label="查找…"
            isDisabled={findDisabled}
            aria-expanded={findOpen}
            onPress={toggleFind}
          >
            <Icon name="search" />
          </IconButton>
          <Menu
            label="排版"
            iconOnly
            icon={<span className="reader-type-icon">Aa</span>}
            items={typeItems}
          />
          <IconButton
            aria-label={informationShown ? "收起信息" : "显示信息"}
            aria-pressed={informationShown}
            onPress={toggleInformation}
          >
            <Icon name="book" />
          </IconButton>
        </>
      )}
      <Menu label="更多" iconOnly items={moreItems} />
    </>
  );
  // Spec 1.2: opened from a fixed source, the line under the page header says
  // so and offers the way back; without a page header it stays a row.
  const returnLabel = fromSummary
    ? "返回总结"
    : route.parameters.get("from") === "ext"
      ? "返回结果"
      : "返回检索";
  const fixedSource = fromSummary || route.parameters.has("from");
  return (
    <section
      ref={root}
      className={`react-reader reader-workspace ${mode === "edit" ? "reader-editing" : !informationShown && !panelLeaving ? "reader-without-information" : ""}`}
      data-layout={layout}
      data-panel-leaving={panelLeaving || undefined}
      aria-label="文献阅读器"
    >
      {shell.readerBar ? createPortal(topBarTools, shell.readerBar) : null}
      {fixedSource && !headerHost ? (
        <div className="reader-return">
          <Button variant="text" icon={<Icon name="arrow" />} onPress={back}>
            {returnLabel}
          </Button>
          <span>正在查看固定来源，阅读不会修改材料。</span>
        </div>
      ) : null}
      <div
        className="reader-find"
        hidden={!findOpen || mode === "results"}
        // Spec 1.8.5: Enter goes on, Shift+Enter back; Esc closes the bar and
        // leaves the place at the current match.
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setFindOpen(false);
            // Keys go back to the reading area: they need no click (spec 1.8.4).
            (event.target as HTMLElement).blur();
            return;
          }
          if (event.key !== "Enter" || !nextMatch) return;
          const field = event.target as HTMLInputElement;
          if (event.shiftKey) {
            event.preventDefault();
            nextMatch(-1);
          } else if (field.value === findAsked.current) {
            event.preventDefault();
            nextMatch(1);
          }
        }}
      >
        <SearchField
          label="查找…"
          value={search}
          onChange={(value) => {
            setSearch(value);
            position.query = value;
          }}
          onSubmit={findText}
        />
        <span ref={findStatus} role="status" />
        {nextMatch && (
          <>
            <Button onPress={() => nextMatch(-1)}>上一处命中</Button>
            <Button onPress={() => nextMatch(1)}>下一处命中</Button>
          </>
        )}
      </div>
      <span className="ui-visually-hidden" role="status">
        {scale.spoken}
      </span>
      {input.contextMenu}
      {input.shortcutsDialog}
      <SplitPane
        label={mode === "edit" ? "校订稿编辑区宽度" : "文献信息栏宽度"}
        edge="left"
        width={
          mode === "edit"
            ? editorWidth
            : informationShown
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
              hidden={!informationShown && !panelLeaving}
              data-leaving={panelLeaving || undefined}
              style={panelLeaving ? { width: informationWidth } : undefined}
            >
              {marks.active ? (
                <Tabs
                  label="信息栏"
                  value={sideTab}
                  onChange={(value) => {
                    setSideTab(value as typeof sideTab);
                    rememberReading(catalog, id, { sideTab: value });
                  }}
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
                <>
                  {/* Spec 1.3: the PDF's side-by-side translation is set here. */}
                  {mode === "pdf" && api.kind === "workspace" ? (
                    <FullTextControls
                      fullText={fullText}
                      translation={translation}
                    />
                  ) : null}
                  <TranslationPanel translation={translation} notify={notify} />
                </>
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
          <div
            className="reader-surface"
            ref={setDesk}
            onContextMenu={input.onContextMenu}
          >
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
                retained={issue.retained ?? "已加载的内容仍然保留。"}
                {...(issue.retry ? { onRetry: issue.retry } : {})}
              />
            )}
            {issue?.detail && mode !== "know" && mode !== "results" ? (
              <TechDetails copyText={issue.detail}>
                <p>{issue.detail}</p>
              </TechDetails>
            ) : null}
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
                  "--reading-font-size": `${fontSize}px`,
                } as CSSProperties
              }
            />
            {marks.rail}
            {headerHost &&
            shown?.id === id &&
            detail.data &&
            !detail.isPlaceholderData
              ? createPortal(
                  <ReaderPageHeader
                    kind={shown.kind}
                    paper={detail.data}
                    narrow={barWidth > 0 ? narrowBar : narrowTop}
                    pdf={pdf}
                    level={textLevel}
                    back={
                      historyBack
                        ? { label: historyBack.label, go: () => engines.back() }
                        : null
                    }
                    line={headerLine}
                    scroller={body.current}
                    scaleText={
                      shown.kind === "doc" &&
                      (fontSize !== TEXT_SCALE.base || scale.recent)
                        ? textPercent(fontSize)
                        : null
                    }
                    pageEdit={pageEdit}
                  />,
                  headerHost,
                )
              : null}
            {skeleton}
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
            {lacking === "text" ? (
              <div className="reading-scroll reader-lacking">
                <EmptyState
                  title="这份资料还没有可读的文本。"
                  {...(api.workspace.capabilities.maintenance
                    ? {
                        action: (
                          <Button onPress={() => setOperation("archive")}>
                            建立文献档案
                          </Button>
                        ),
                      }
                    : {})}
                />
              </div>
            ) : null}
            {lacking === "bibliography" ? (
              <div className="reading-scroll reader-lacking">
                <EmptyState
                  title="这份资料只有书目信息。"
                  {...(api.workspace.capabilities.maintenance
                    ? {
                        action: (
                          <div className="reader-lacking-actions">
                            <Button onPress={() => setOperation("acquire")}>
                              获取 PDF
                            </Button>
                            <Button onPress={() => setOperation("upload")}>
                              上传 PDF
                            </Button>
                          </div>
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
                    "--reading-font-size": `${fontSize}px`,
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
          </div>
        </div>
      </SplitPane>
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
        label="疑点"
        triggerRef={doubtAnchor}
        isOpen={!!doubt}
        onOpenChange={(open) => {
          if (!open) setDoubt(null);
        }}
      >
        {doubt ? <DraftDoubt {...doubt} /> : null}
      </AnchoredPopover>
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
