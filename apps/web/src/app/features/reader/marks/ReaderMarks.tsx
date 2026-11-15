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
import {
  Button,
  Dialog,
  useToast,
  type MenuOption,
} from "../../../components/index.js";
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
import { useMarks } from "./use-marks.js";
import { useQueries } from "@tanstack/react-query";
import { readDocument } from "../../../../reading/transport.js";
import { useApi } from "../../../data/query.js";
import { TranslationPopover } from "../translation/TranslationViews.js";
import type { ReaderTranslation } from "../translation/use-translation.js";
import "./marks.css";

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
        : "yellow";
    }),
    [hot, setHot] = useState<string | null>(null),
    [current, setCurrent] = useState<string | null>(null),
    [bar, setBar] = useState<Bar>(null),
    [note, setNote] = useState<string | null>(null),
    [placed, setPlaced] = useState<{
      all: ReadonlySet<string>;
      near: ReadonlySet<string>;
    }>({ all: new Set(), near: new Set() }),
    [rail, setRail] = useState<{ id: string; color: MarkColor; at: number }[]>(
      [],
    ),
    [exported, setExported] = useState<string | null>(null);
  const draft = useRef<SelectionDraft | null>(null);
  const latest = useRef({ marks: store.marks, tool, pen, store, translation });
  latest.current = { marks: store.marks, tool, pen, store, translation };
  const setPen = (color: MarkColor) => {
    setPenState(color);
    preferences.write(PEN_KEY, color);
  };
  const railFrame = useRef(0);
  const refreshRail = useCallback(() => {
    cancelAnimationFrame(railFrame.current);
    railFrame.current = requestAnimationFrame(() =>
      setRail(surface.current?.positions() ?? []),
    );
  }, []);
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
          refreshRail();
        },
        destroy() {
          created.destroy();
          if (surface.current === created) surface.current = null;
          setBar(null);
          setNote(null);
          setRail([]);
        },
      };
      return wrapped;
    },
    [events, refreshRail],
  );
  useEffect(() => {
    surface.current?.setMarks(store.marks);
    refreshRail();
  }, [store.marks, refreshRail]);
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

  // Shortcuts work while the reader shows a material and no text field has focus.
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog']",
        )
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const k = event.key.toLowerCase();
      const digit = /^[1-5]$/u.test(k) ? MARK_COLORS[Number(k) - 1]! : null;
      if (event.key === "Escape") {
        if (bar || note || translation?.popupOpen) {
          setBar(null);
          setNote(null);
          translation?.dismiss();
          surface.current?.preview(null);
          if (bar?.kind === "selection") surface.current?.clearSelection();
        }
        return;
      }
      if (bar?.kind === "selection") {
        if (digit) {
          event.preventDefault();
          highlight(digit);
          return;
        }
        if (k === "n") {
          event.preventDefault();
          const mark = highlight(latest.current.pen, true);
          if (mark) setNote(mark.mark_id);
          return;
        }
        if (k === "c" && draft.current) {
          event.preventDefault();
          cite(draft.current.quote, draft.current.pdf?.page ?? null);
          surface.current?.clearSelection();
          setBar(null);
          return;
        }
      }
      if (bar?.kind === "mark") {
        if (digit) {
          event.preventDefault();
          latest.current.store.update(bar.id, { color: digit });
          setPen(digit);
          return;
        }
        if (k === "n") {
          event.preventDefault();
          setNote(bar.id);
          setBar(null);
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          remove(bar.id);
          return;
        }
      }
      if (k === "[" || k === "]") {
        event.preventDefault();
        step(k === "]" ? 1 : -1);
      } else if (k === "v") setTool("select");
      else if (k === "h") setTool("pen");
      else if (k === "r" && view === "pdf") setTool("region");
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [active, bar, note, highlight, cite, remove, step, view, translation]);

  const barMark = bar?.kind === "mark" ? find(bar.id) : undefined;
  const noteMark = note ? find(note) : undefined;
  const anchorFor = useCallback(
    (markId: string) => () => surface.current?.anchorRect(markId) ?? null,
    [],
  );
  // Spec 1.3: the marking tools live in the top bar's “更多” menu; the keys
  // V, H, R and 1–5 still choose them.
  const toolItems: readonly MenuOption[] = active
    ? [
        {
          id: "mark-pen",
          label: "高亮笔",
          shortcut: "H",
          checked: tool === "pen",
          divider: true,
          onAction: () => setTool(tool === "pen" ? "select" : "pen"),
        },
        ...(view === "pdf"
          ? [
              {
                id: "mark-region",
                label: "框选区域",
                shortcut: "R",
                checked: tool === "region",
                onAction: () =>
                  setTool(tool === "region" ? "select" : "region"),
              },
            ]
          : []),
        {
          id: "mark-color",
          label: "笔颜色",
          onAction: () => {},
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
        },
      ]
    : [];
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
  const overlays: ReactNode = active ? (
    <>
      {bar?.kind === "selection" && draft.current ? (
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
      {barMark ? (
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
  const railNode: ReactNode =
    active && view === "pdf" && rail.length ? (
      <div className="mark-rail" aria-hidden="true">
        {rail.map((tick) => (
          <button
            key={tick.id}
            type="button"
            tabIndex={-1}
            data-color={tick.color}
            data-hot={hot === tick.id || undefined}
            style={{ top: `${Math.min(99.4, tick.at * 100)}%` }}
            onPointerEnter={() => {
              setHot(tick.id);
              surface.current?.setHot(tick.id);
            }}
            onPointerLeave={() => {
              setHot(null);
              surface.current?.setHot(null);
            }}
            onClick={() => open(tick.id)}
          />
        ))}
      </div>
    ) : null;
  return {
    attach,
    toolItems,
    panel,
    overlays,
    rail: railNode,
    count: store.marks.length,
    active,
    /** For the translated pages: the marks to tint and how to show one in the original. */
    list: store.marks,
    open,
  };
}
