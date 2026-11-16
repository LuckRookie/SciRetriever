import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  MARK_COLORS,
  MARK_COLOR_LABELS,
  type LiteratureDetail,
  type MarkColor,
  type ReadingMark,
  type TextLevel,
} from "@sciretriever/contracts";
import { Button, Dialog, useToast } from "../../../components/index.js";
import { copyText } from "../../../../browser-platform.js";
import {
  createDocumentMarkSurface,
  createPdfMarkSurface,
  type MarkSurface,
  type MarkSurfaceEvents,
  type MarkTool,
  type SelectionDraft,
} from "../../../../reading/marks.js";
import { preferences } from "../../../data/preferences.js";
import { MarkBar, MarkBarButton, NotePopover } from "./MarkOverlays.js";
import { MarksPanel } from "./MarksPanel.js";
import { MarginNotes } from "./MarginNotes.js";
import { useMarks } from "./use-marks.js";
import { useQueries } from "@tanstack/react-query";
import { readDocument } from "../../../../reading/transport.js";
import { useApi } from "../../../data/query.js";
import { TranslationPopover } from "../translation/TranslationViews.js";
import type { ReaderTranslation } from "../translation/use-translation.js";
import "./marks.css";
import type { ReaderCommand } from "../input/commands.js";

const PEN_KEY = "sciretriever:marks:pen:v1";
type Bar = { kind: "selection" } | { kind: "mark"; id: string } | null;
/** “原文”（Chen 等，2025，第 5 页，doi:…）: a quote ready to paste with its source. */
function citation(
  detail: LiteratureDetail,
  quote: string,
  page: number | null,
) {
  const m = detail.literature.metadata;
  const first = m.authors[0];
  const who = first
    ? `${first.family_name || first.display_name}${m.authors.length > 1 ? " 等" : ""}`
    : null;
  const doi = m.identifiers.find((i) => i.namespace === "doi")?.value;
  const source = [
    who,
    m.publication_year,
    page ? `第 ${page} 页` : null,
    doi ? `doi:${doi}` : null,
  ]
    .filter(Boolean)
    .join("，");
  return `“${quote}”${source ? `（${source}）` : ""}`;
}

/**
 * Reading marks in the reader (ADR 0046). Reader mounts a surface on its
 * engine through `attach`; this hook owns the marks, the tools and the
 * floating bars, and hands back the pieces Reader places in its layout.
 */
export function useReaderMarks({
  detail,
  mode,
  enabled,
  notify,
  translation,
  onTranslate,
}: {
  detail: LiteratureDetail | undefined;
  mode: string;
  enabled: boolean;
  notify: (message: string) => void;
  /** Reader translation (ADR 0049): selections translate while the select tool is on. */
  translation?: ReaderTranslation;
  /** The 翻译 button on the selection bar, used when the popup is off. */
  onTranslate?: () => void;
}) {
  const id = detail?.literature.literature_id ?? "";
  const view: "pdf" | "doc" | null =
    mode === "pdf" ? "pdf" : mode === "doc" ? "doc" : null;
  const active = enabled && !!view;
  const store = useMarks(id, enabled, notify);
  // Plan 21 block 10: each mark says on which level of text it was made —
  // the level of the document version its anchor names.
  const api = useApi();
  const versions = useMemo(
    () => [
      ...new Set(
        store.marks.flatMap((m) =>
          m.document ? [m.document.document_version_id] : [],
        ),
      ),
    ],
    [store.marks],
  );
  const described = useQueries({
    queries: versions.map((version) => ({
      queryKey: ["document", "describe", version],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readDocument(
          { api, signal, root: document.body, refresh: () => {} },
          "describe",
          { document_version_id: version },
        ),
      staleTime: Infinity,
      retry: false,
    })),
  });
  const levels = new Map<string, TextLevel>();
  versions.forEach((version, index) => {
    const value = described[index]?.data;
    if (value) levels.set(version, value.text_level ?? "proofread");
  });
  const toast = useToast();
  const surface = useRef<MarkSurface | null>(null),
    body = useRef<HTMLElement | null>(null);
  const [tool, setTool] = useState<MarkTool>("select"),
    [pen, setPenState] = useState<MarkColor>(() => {
      const saved = preferences.read(PEN_KEY);
      return (MARK_COLORS as readonly string[]).includes(saved ?? "")
        ? (saved as MarkColor)
        : "blue"; // Spec 2.5: the default pen is blue.
    }),
    [hot, setHot] = useState<string | null>(null),
    [current, setCurrent] = useState<string | null>(null),
    [bar, setBar] = useState<Bar>(null),
    [note, setNote] = useState<string | null>(null),
    [placed, setPlaced] = useState<{
      all: ReadonlySet<string>;
      near: ReadonlySet<string>;
    }>({ all: new Set(), near: new Set() }),
    [exported, setExported] = useState<string | null>(null),
    [menuOpen, setMenuOpen] = useState(false),
    // A PDF note dot hovered: its note shown read-only (spec 3.5).
    [peek, setPeek] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const draft = useRef<SelectionDraft | null>(null);
  const latest = useRef({ marks: store.marks, tool, pen, store, translation });
  latest.current = { marks: store.marks, tool, pen, store, translation };
  const setPen = (color: MarkColor) => {
    setPenState(color);
    preferences.write(PEN_KEY, color);
  };

  const find = (markId: string) =>
    latest.current.marks.find((m) => m.mark_id === markId);

  const highlight = useCallback(
    (color: MarkColor, quiet = false): ReadingMark | null => {
      const d = draft.current;
      if (!d) return null;
      surface.current?.preview(null);
      const mark = latest.current.store.create({
        kind: "highlight",
        color,
        quote: d.quote,
        prefix: d.prefix,
        suffix: d.suffix,
        pdf: d.pdf,
        document: d.document,
      });
      setPen(color);
      surface.current?.clearSelection();
      draft.current = null;
      setBar(null);
      latest.current.translation?.dismiss();
      if (!quiet)
        toast({
          message: `已高亮为「${MARK_COLOR_LABELS[color]}」`,
          replace: "marks",
          action: {
            label: "撤销",
            onPress: () => latest.current.store.remove(mark.mark_id),
          },
        });
      return mark;
    },
    [toast],
  );
  const events = useMemo<MarkSurfaceEvents>(
    () => ({
      hot: setHot,
      peek: (markId, anchor) =>
        setPeek(markId && anchor ? { id: markId, anchor } : null),
      activate(markId, _anchor, viaMarker) {
        setCurrent(markId);
        if (viaMarker && find(markId)?.note.trim()) {
          setBar(null);
          setNote(markId);
        } else setBar({ kind: "mark", id: markId });
      },
      selection(next) {
        draft.current = next;
        const t = latest.current.translation;
        if (!next) {
          setBar((b) => (b?.kind === "selection" ? null : b));
          t?.dismiss();
          return;
        }
        setNote(null);
        if (latest.current.tool === "pen") highlight(latest.current.pen, true);
        else {
          setBar({ kind: "selection" });
          t?.selected(next.quote, next.pdf?.page ?? null);
        }
      },
      region(next) {
        const mark = latest.current.store.create({
          kind: "region",
          color: latest.current.pen,
          quote: "",
          prefix: "",
          suffix: "",
          pdf: next.pdf,
          document: null,
        });
        setCurrent(mark.mark_id);
        setBar({ kind: "mark", id: mark.mark_id });
      },
      place(markId, anchor) {
        latest.current.store.update(markId, anchor);
      },
      placed(all, near) {
        setPlaced({ all, near });
      },
    }),
    [highlight],
  );
  /** Reader calls this when its engine mounts; the returned surface lives as long as that mount. */
  const attach = useCallback(
    (
      host: HTMLElement,
      material:
        | { kind: "pdf"; sha256: string }
        | { kind: "doc"; version: string },
      /** Records the reader's place before the marks list moves it (spec 4.4). */
      onJump?: () => void,
    ) => {
      body.current = host;
      jump.current = onJump ?? null;
      const created =
        material.kind === "pdf"
          ? createPdfMarkSurface(host, material.sha256, {
              ...events,
              place: events.place,
            })
          : createDocumentMarkSurface(host, material.version, events);
      created.setTool(latest.current.tool);
      created.setMarks(latest.current.marks);
      surface.current = created;
      const wrapped: MarkSurface = {
        ...created,
        pdfPage(pageView) {
          created.pdfPage(pageView);
        },
        destroy() {
          created.destroy();
          if (surface.current === created) surface.current = null;
          setBar(null);
          setNote(null);
        },
      };
      return wrapped;
    },
    [events],
  );
  useEffect(() => {
    surface.current?.setMarks(store.marks);
  }, [store.marks]);
  useEffect(() => {
    surface.current?.setHot(hot);
  }, [hot]);
  useEffect(() => {
    surface.current?.setTool(tool);
  }, [tool]);
  const cite = useCallback(
    (quote: string, page: number | null) => {
      if (!detail) return;
      void copyText(citation(detail, quote, page))
        .then(() => notify("已复制引用，含页码与 DOI"))
        .catch(() => notify("浏览器未允许写入剪贴板。"));
    },
    [detail, notify],
  );
  const remove = useCallback(
    (markId: string) => {
      const mark = find(markId);
      latest.current.store.remove(markId);
      setBar(null);
      setNote(null);
      if (mark)
        toast({
          message: mark.kind === "region" ? "已删除框选" : "已删除批注",
          replace: "marks",
          action: {
            label: "撤销",
            onPress: () => latest.current.store.restore(markId),
          },
        });
    },
    [toast],
  );
  const jump = useRef<(() => void) | null>(null);
  const open = useCallback(
    (markId: string) => {
      setCurrent(markId);
      if (!surface.current?.reveal(markId))
        notify("这条批注在当前视图里找不到对应的文字。");
    },
    [notify],
  );
  const step = useCallback(
    (direction: 1 | -1) => {
      const list = latest.current.marks.filter((m) =>
        view === "pdf" ? !!m.pdf : placed.all.has(m.mark_id),
      );
      if (!list.length) return;
      const at = list.findIndex((m) => m.mark_id === current);
      const next =
        list[
          at < 0
            ? direction > 0
              ? 0
              : list.length - 1
            : (at + direction + list.length) % list.length
        ]!;
      open(next.mark_id);
    },
    [current, open, placed.all, view],
  );

  /**
   * Reading-experience 1.8: the marking operations, for the reader's table.
   * The keys reach them only outside text fields; N, C and the digits act on
   * a selection or a chosen mark, and let the key go otherwise.
   */
  const colorOf = (event?: KeyboardEvent) =>
    event && /^[1-5]$/u.test(event.key)
      ? MARK_COLORS[Number(event.key) - 1]!
      : null;
  const noteOnSelection = () => {
    const mark = highlight(latest.current.pen, true);
    if (mark) setNote(mark.mark_id);
  };
  const citeSelection = () => {
    if (!draft.current) return;
    cite(draft.current.quote, draft.current.pdf?.page ?? null);
    surface.current?.clearSelection();
    setBar(null);
  };
  const citeMark = (markId: string) => {
    const mark = find(markId);
    if (mark) cite(mark.quote, mark.pdf?.page ?? null);
  };
  const recolor = (markId: string, color: MarkColor) => {
    latest.current.store.update(markId, { color });
    setPen(color);
  };
  const commands: ReaderCommand[] = active
    ? [
        {
          id: "tool-select",
          checked: tool === "select",
          run: () => setTool("select"),
        },
        {
          id: "tool-pen",
          checked: tool === "pen",
          // The key chooses it; the menu item switches it on and off.
          run: (event) => setTool(event || tool !== "pen" ? "pen" : "select"),
        },
        ...(view === "pdf"
          ? [
              {
                id: "tool-region" as const,
                checked: tool === "region",
                run: (event?: KeyboardEvent) =>
                  setTool(event || tool !== "region" ? "region" : "select"),
              },
            ]
          : []),
        {
          id: "mark-color",
          label: "笔颜色",
          submenu: MARK_COLORS.map((color, index) => ({
            id: `mark-color-${color}`,
            label: MARK_COLOR_LABELS[color],
            checked: pen === color,
            shortcut: String(index + 1),
            onAction: () => {
              setPen(color);
              setTool("pen");
            },
          })),
          run: (event) => {
            const color = colorOf(event);
            if (!color) return false;
            if (bar?.kind === "selection") highlight(color);
            else if (bar?.kind === "mark") recolor(bar.id, color);
            else return false;
          },
        },
        {
          id: "note",
          enabled: !!bar,
          run: () => {
            if (bar?.kind === "selection") noteOnSelection();
            else if (bar?.kind === "mark") {
              setNote(bar.id);
              setBar(null);
            } else return false;
          },
        },
        {
          id: "cite",
          enabled: !!bar,
          run: () => {
            if (bar?.kind === "selection" && draft.current) citeSelection();
            else if (bar?.kind === "mark") citeMark(bar.id);
            else return false;
          },
        },
        { id: "mark-previous", run: () => step(-1) },
        { id: "mark-next", run: () => step(1) },
        {
          id: "mark-delete",
          enabled: bar?.kind === "mark",
          run: () => {
            if (bar?.kind !== "mark") return false;
            remove(bar.id);
          },
        },
      ]
    : [];
  /** Esc (spec 1.8.6): the note, the selection bar and the translation popup first. */
  const escape = () => {
    if (!(bar || note || translation?.popupOpen)) return false;
    setBar(null);
    setNote(null);
    translation?.dismiss();
    surface.current?.preview(null);
    if (bar?.kind === "selection") surface.current?.clearSelection();
    return true;
  };
  /** What the context menu needs from the marks (spec 1.8.2). */
  const menu = {
    selection: () => draft.current,
    markAt: (event: MouseEvent) => surface.current?.markAt(event) ?? null,
    /** A right-click on a mark chooses it. */
    choose: (markId: string) => {
      setCurrent(markId);
      setNote(null);
      setBar({ kind: "mark", id: markId });
    },
    mark: find,
    highlight: (color: MarkColor) => highlight(color),
    noteOnSelection,
    citeSelection,
    citeMark,
    /** Any quote, as “复制为引用” writes it (with page and DOI). */
    cite,
    note: (markId: string) => {
      setNote(markId);
      setBar(null);
    },
    recolor,
    remove,
    /** The bars hide while a context menu is open over them. */
    setMenuOpen: setMenuOpen,
    escape,
  };
  const barMark = bar?.kind === "mark" ? find(bar.id) : undefined;
  const noteMark = note ? find(note) : undefined;
  const anchorFor = useCallback(
    (markId: string) => () => surface.current?.anchorRect(markId) ?? null,
    [],
  );
  const panel: ReactNode = active ? (
    <MarksPanel
      marks={store.marks}
      levels={levels}
      view={view!}
      hot={hot}
      active={current}
      placed={placed.all}
      approximate={placed.near}
      thumbnail={(markId, target) =>
        surface.current?.drawThumbnail(markId, target) ?? false
      }
      onHot={(markId) => {
        setHot(markId);
        surface.current?.setHot(markId);
      }}
      // Opening a mark from the list is a jump: its place is recorded first.
      onOpen={(markId) => {
        jump.current?.();
        open(markId);
      }}
      onNote={(markId) => {
        jump.current?.();
        open(markId);
        setNote(markId);
      }}
      onCite={(markId) => {
        const m = find(markId);
        if (m) cite(m.quote || "框选区域", m.pdf?.page ?? null);
      }}
      onDelete={remove}
      onExport={() => {
        void store
          .exportText("markdown")
          .then(setExported)
          .catch(() => notify("批注导出失败，请重试。"));
      }}
    />
  ) : null;
  const peeked = peek ? find(peek.id) : undefined;
  const overlays: ReactNode = active ? (
    <>
      {peeked && peek && !note ? (
        <div
          className="mark-note-peek"
          role="tooltip"
          data-origin="machine"
          style={{
            top: peek.anchor.bottom + 6,
            left: Math.max(8, peek.anchor.right - 280),
          }}
        >
          {peeked.note}
        </div>
      ) : null}
      {view === "doc" ? (
        <MarginNotes
          body={body.current}
          marks={store.marks}
          placed={placed.all}
          anchorRect={(markId) => surface.current?.anchorRect(markId) ?? null}
          blockOf={(markId) => surface.current?.blockOf?.(markId) ?? null}
          onOpen={(markId) => {
            setCurrent(markId);
            setBar(null);
            setNote(markId);
          }}
          onHover={(markId) => {
            setHot(markId);
            surface.current?.setHot(markId);
          }}
          revision={0}
        />
      ) : null}
      {bar?.kind === "selection" && draft.current && !menuOpen ? (
        <MarkBar
          label="选中文字"
          anchor={() => draft.current?.anchor ?? null}
          scroller={body.current}
          onPreview={(color) => surface.current?.preview(color)}
          onColor={(color) => highlight(color)}
        >
          <MarkBarButton
            icon="note"
            label="写笔记"
            shortcut="N"
            onPress={() => {
              const mark = highlight(pen, true);
              if (mark) setNote(mark.mark_id);
            }}
          >
            笔记
          </MarkBarButton>
          <MarkBarButton
            icon="copy"
            label="复制为引用"
            shortcut="C"
            onPress={() => {
              if (draft.current)
                cite(draft.current.quote, draft.current.pdf?.page ?? null);
              surface.current?.clearSelection();
              setBar(null);
            }}
          >
            引用
          </MarkBarButton>
          {translation && !translation.settings.popup ? (
            <MarkBarButton
              icon="translate"
              label="翻译选中文字"
              onPress={() => {
                // With auto on the selection is already being translated.
                if (draft.current && !translation.settings.auto)
                  void translation.translate(
                    draft.current.quote,
                    draft.current.pdf?.page ?? null,
                  );
                onTranslate?.();
              }}
            >
              翻译
            </MarkBarButton>
          ) : null}
        </MarkBar>
      ) : null}
      {bar?.kind === "selection" &&
      draft.current &&
      !menuOpen &&
      translation?.settings.popup &&
      translation.popupOpen &&
      translation.current ? (
        <TranslationPopover
          translation={translation}
          anchor={() => draft.current?.anchor ?? null}
          scroller={body.current}
          notify={notify}
        />
      ) : null}
      {barMark && !menuOpen ? (
        <MarkBar
          label="批注"
          anchor={anchorFor(barMark.mark_id)}
          scroller={body.current}
          current={barMark.color}
          onColor={(color) => {
            store.update(barMark.mark_id, { color });
            setPen(color);
          }}
        >
          <MarkBarButton
            icon="note"
            label={barMark.note.trim() ? "编辑笔记" : "写笔记"}
            shortcut="N"
            onPress={() => {
              setNote(barMark.mark_id);
              setBar(null);
            }}
          >
            笔记
          </MarkBarButton>
          <MarkBarButton
            icon="copy"
            label="复制为引用"
            onPress={() =>
              cite(barMark.quote || "框选区域", barMark.pdf?.page ?? null)
            }
          />
          <MarkBarButton
            icon="trash"
            label="删除"
            shortcut="⌫"
            tone="danger"
            onPress={() => remove(barMark.mark_id)}
          />
        </MarkBar>
      ) : null}
      {noteMark ? (
        <NotePopover
          key={noteMark.mark_id}
          anchor={() =>
            surface.current?.anchorRect(noteMark.mark_id) ??
            draft.current?.anchor ??
            null
          }
          scroller={body.current}
          color={noteMark.color}
          quote={
            noteMark.kind === "region"
              ? `第 ${noteMark.pdf?.page} 页的框选区域`
              : noteMark.quote
          }
          initial={noteMark.note}
          onClose={() => setNote(null)}
          onSave={(text) => {
            if (text !== noteMark.note) {
              store.update(noteMark.mark_id, { note: text });
              notify(text ? "笔记已保存" : "笔记已清空");
            }
            setNote(null);
          }}
        />
      ) : null}
      <Dialog
        title="导出批注"
        isOpen={exported !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setExported(null);
        }}
        footer={
          <>
            <Button onPress={() => setExported(null)}>关闭</Button>
            <Button
              variant="primary"
              onPress={() => {
                void copyText(exported ?? "")
                  .then(() => notify("已复制 Markdown"))
                  .catch(() =>
                    notify("浏览器未允许写入剪贴板，可选中文本复制。"),
                  );
              }}
            >
              复制 Markdown
            </Button>
          </>
        }
      >
        <p className="ui-description">
          按页排列，引文保留页码与颜色含义，可直接粘进笔记软件。
        </p>
        <pre className="marks-export">{exported}</pre>
      </Dialog>
    </>
  ) : null;
  return {
    attach,
    commands,
    escape,
    menu,
    panel,
    overlays,
    /** A spine tick hovered (reading-experience 1.5): its mark lights up. */
    hover: (markId: string | null) => {
      setHot(markId);
      surface.current?.setHot(markId);
    },
    count: store.marks.length,
    active,
    /** For the translated pages: the marks to tint and how to show one in the original. */
    list: store.marks,
    open,
  };
}
