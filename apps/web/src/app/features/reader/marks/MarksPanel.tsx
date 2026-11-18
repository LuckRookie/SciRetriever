import { useMemo, useState } from "react";
import {
  MARK_COLORS,
  MARK_COLOR_LABELS,
  type MarkColor,
  type ReadingMark,
  type TextLevel,
} from "@sciretriever/contracts";
import {
  Button,
  ChipGroup,
  EmptyState,
  FilterChip,
  IconButton,
  Icon,
  SearchField,
} from "../../../components/index.js";
import { localTime } from "../../../strings.js";

type Kind = "all" | "highlight" | "note" | "region";
const KINDS: readonly [Kind, string][] = [
  ["all", "全部"],
  ["highlight", "高亮"],
  ["note", "笔记"],
  ["region", "框选"],
];
/** The note with its #tags set off; everything else stays plain text. */
function NoteText({ text }: { text: string }) {
  const parts = text.split(/(#[\p{L}\p{N}_-]{1,40})/gu);
  return (
    <p className="mark-card-note">
      {parts.map((part, i) =>
        part.startsWith("#") ? (
          <span key={i} className="mark-tag">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/**
 * The reader's marks, in reading order and grouped by page. Pointing at a card
 * lights its mark in the text and the other way round; a click goes there.
 */
export function MarksPanel({
  marks,
  levels,
  view,
  hot,
  active,
  placed,
  approximate,
  thumbnail,
  onHot,
  onOpen,
  onNote,
  onCite,
  onDelete,
  onExport,
}: {
  marks: readonly ReadingMark[];
  /** The text level of each document version a mark is anchored to. */
  levels: ReadonlyMap<string, TextLevel>;
  view: "pdf" | "doc";
  hot: string | null;
  active: string | null;
  placed: ReadonlySet<string>;
  approximate: ReadonlySet<string>;
  thumbnail: (id: string, target: HTMLCanvasElement) => boolean;
  onHot: (id: string | null) => void;
  onOpen: (id: string) => void;
  onNote: (id: string) => void;
  onCite: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
}) {
  const [kind, setKind] = useState<Kind>("all"),
    [colors, setColors] = useState<ReadonlySet<MarkColor>>(new Set()),
    [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return marks.filter(
      (m) =>
        (kind === "all" ||
          (kind === "note" ? !!m.note.trim() : m.kind === kind)) &&
        (!colors.size || colors.has(m.color)) &&
        (!q ||
          `${m.quote} ${m.note} ${MARK_COLOR_LABELS[m.color]}`
            .toLowerCase()
            .includes(q)),
    );
  }, [marks, kind, colors, query]);
  const groups = useMemo(() => {
    const out: { title: string; items: ReadingMark[] }[] = [];
    for (const m of shown) {
      const title = m.pdf ? `第 ${m.pdf.page} 页` : "全文";
      const last = out.at(-1);
      if (last?.title === title) last.items.push(m);
      else out.push({ title, items: [m] });
    }
    return out;
  }, [shown]);
  return (
    <section className="marks-panel" aria-label="批注">
      <div className="marks-filters">
        <SearchField
          label="搜索批注"
          value={query}
          onChange={setQuery}
          placeholder="搜索批注、笔记、#标签"
        />
        <ChipGroup label="批注类型">
          {KINDS.map(([value, label]) => (
            <FilterChip
              key={value}
              isSelected={kind === value}
              onChange={() => setKind(value)}
            >
              {label}
            </FilterChip>
          ))}
        </ChipGroup>
        <ChipGroup label="颜色">
          {MARK_COLORS.map((color) => (
            <FilterChip
              key={color}
              isSelected={colors.has(color)}
              onChange={(on) => {
                const next = new Set(colors);
                if (on) next.add(color);
                else next.delete(color);
                setColors(next);
              }}
            >
              <i className="mark-dot" data-color={color} aria-hidden="true" />
              {MARK_COLOR_LABELS[color]}
            </FilterChip>
          ))}
        </ChipGroup>
      </div>
      {!marks.length ? (
        <EmptyState
          title="还没有批注"
          description={
            view === "pdf"
              ? "选中文字即可高亮，按 R 或按住 Alt 拖动可框选区域"
              : "选中文字即可高亮"
          }
        />
      ) : !shown.length ? (
        <EmptyState title="没有符合条件的批注" />
      ) : (
        <div className="marks-list" onPointerLeave={() => onHot(null)}>
          {groups.map((group) => (
            <div key={group.title} className="marks-group">
              <h3>
                {group.title}
                <span>{group.items.length} 条</span>
              </h3>
              {group.items.map((m) => {
                const where =
                  view === "pdf"
                    ? !placed.has(m.mark_id) && m.kind === "highlight"
                      ? "仅全文"
                      : // 9.4: a region is never looked for on another file.
                        !placed.has(m.mark_id) && m.kind === "region"
                        ? "属于原来那份文件"
                        : approximate.has(m.mark_id)
                          ? "近似位置"
                          : null
                    : m.kind === "region"
                      ? "仅 PDF"
                      : !placed.has(m.mark_id)
                        ? "仅 PDF"
                        : approximate.has(m.mark_id)
                          ? "近似位置"
                          : null;

                return (
                  <article
                    key={m.mark_id}
                    className="mark-card"
                    data-color={m.color}
                    data-hot={hot === m.mark_id || undefined}
                    data-active={active === m.mark_id || undefined}
                    onPointerEnter={() => onHot(m.mark_id)}
                  >
                    <header>
                      <i
                        className="mark-dot"
                        data-color={m.color}
                        aria-hidden="true"
                      />
                      <span className="mark-card-label">
                        {MARK_COLOR_LABELS[m.color]}
                      </span>
                      <span>
                        {m.kind === "region"
                          ? "框选"
                          : m.note.trim()
                            ? "笔记"
                            : "高亮"}
                      </span>
                      {m.document &&
                      levels.has(m.document.document_version_id) ? (
                        <span className="mark-card-level">
                          {levels.get(m.document.document_version_id) ===
                          "draft"
                            ? "未校对的全文上"
                            : "已校对的全文上"}
                        </span>
                      ) : null}
                      {where ? (
                        <span className="mark-card-where">{where}</span>
                      ) : null}
                      <span className="mark-card-tools">
                        <IconButton
                          aria-label="编辑笔记"
                          size="inline"
                          variant="text"
                          onPress={() => onNote(m.mark_id)}
                        >
                          <Icon name="note" />
                        </IconButton>
                        <IconButton
                          aria-label="复制为引用"
                          size="inline"
                          variant="text"
                          onPress={() => onCite(m.mark_id)}
                        >
                          <Icon name="copy" />
                        </IconButton>
                        <IconButton
                          aria-label="删除批注"
                          size="inline"
                          variant="text"
                          onPress={() => onDelete(m.mark_id)}
                        >
                          <Icon name="trash" />
                        </IconButton>
                      </span>
                    </header>
                    <button
                      type="button"
                      className="mark-card-open"
                      aria-label={`转到批注：${m.quote || "框选区域"}`}
                      onClick={() => onOpen(m.mark_id)}
                    >
                      {m.kind === "region" ? (
                        <span className="mark-card-region">
                          <canvas
                            className="mark-card-image"
                            aria-hidden="true"
                            ref={(canvas) => {
                              if (canvas)
                                canvas.hidden = !thumbnail(m.mark_id, canvas);
                            }}
                          />
                          <span>第 {m.pdf?.page} 页的框选区域</span>
                        </span>
                      ) : (
                        <q className="mark-card-quote">
                          <span>{m.quote}</span>
                        </q>
                      )}
                    </button>
                    {m.note.trim() ? <NoteText text={m.note} /> : null}
                    <p className="mark-card-time">{localTime(m.updated_at)}</p>
                  </article>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <footer className="marks-footer">
        <Button
          icon={<Icon name="download" />}
          isDisabled={!marks.length}
          onPress={onExport}
        >
          导出 Markdown
        </Button>
      </footer>
    </section>
  );
}
