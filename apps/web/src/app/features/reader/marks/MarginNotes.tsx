import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MARK_COLOR_LABELS, type ReadingMark } from "@sciretriever/contracts";
import { layoutMargin, type MarginPlace } from "./margin.js";

const SHEET =
  ".reader-engine:not([hidden]) .reader-view:not([hidden])[data-view='doc']";
const day = (iso: string) => iso.slice(0, 10);

/** One note: its colour square, meaning and date, then the note itself. */
function Note({
  mark,
  folded,
  onOpen,
  onHover,
}: {
  mark: ReadingMark;
  folded?: boolean;
  onOpen: () => void;
  onHover: (hot: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="reading-margin-note"
      data-origin="machine"
      data-color={mark.color}
      data-folded={folded || undefined}
      aria-label={`批注：${mark.note}`}
      onClick={onOpen}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <span className="reading-margin-note-head">
        <span className="reading-margin-note-swatch" aria-hidden="true" />
        {MARK_COLOR_LABELS[mark.color]} · {day(mark.updated_at)}
      </span>
      <span className="reading-margin-note-text">{mark.note}</span>
    </button>
  );
}
/**
 * The marks' notes beside the full text (reading-experience 2.5): in the
 * right margin, each with a leader from the column's edge at its marked
 * line, kept 10 px apart; in the narrow tiers, below their paragraph.
 */
export function MarginNotes({
  body,
  marks,
  placed,
  anchorRect,
  blockOf,
  onOpen,
  onHover,
  revision,
}: {
  body: HTMLElement | null;
  marks: readonly ReadingMark[];
  placed: ReadonlySet<string>;
  anchorRect: (id: string) => DOMRect | null;
  blockOf: (id: string) => HTMLElement | null;
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
  /** Bumped when the text is painted again: the places are measured anew. */
  revision: number;
}) {
  const noted = marks.filter((m) => m.note.trim() && placed.has(m.mark_id));
  const [layout, setLayout] = useState<{
    sheet: HTMLElement;
    below: boolean;
    column: number;
    /** Where the notes begin, from the sheet's left edge. */
    left: number;
    width: number;
    places: (MarginPlace & { line: number })[];
  } | null>(null);
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const sheet = body?.querySelector<HTMLElement>(SHEET);
    const article = sheet?.querySelector<HTMLElement>(".reading-article");
    if (!body || !sheet || !article || !noted.length) return setLayout(null);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const below = body.dataset.notes === "below",
        s = sheet.getBoundingClientRect(),
        a = article.getBoundingClientRect();
      const column = a.right - s.left;
      // An annotated copy (ADR 0070): the notes stand beyond the column rule,
      // as wide as the machine's, and below any of those in their way.
      const style = getComputedStyle(sheet);
      const gutter = parseFloat(style.getPropertyValue("--sheet-gutter")) || 0,
        noteWidth =
          parseFloat(style.getPropertyValue("--sheet-note-width")) || 0;
      const annotated = !below && noteWidth > 0 && !!sheet.dataset.annotated;
      const width = annotated
        ? noteWidth
        : body.dataset.sheet === "wide"
          ? 166
          : 156;
      const taken = annotated
        ? [
            ...sheet.querySelectorAll<HTMLElement>(
              ".rl-side > .rl-pi, .rl-side > .rl-rules",
            ),
          ].map((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top - s.top, bottom: r.bottom - s.top };
          })
        : [];
      const items = noted.flatMap((m) => {
        const rect = anchorRect(m.mark_id);
        if (!rect) return [];
        const line = rect.top - s.top;
        return [
          {
            id: m.mark_id,
            want: line,
            line: line + rect.height / 2,
            height: heights.get(m.mark_id) ?? 48,
            firstLine: 18,
          },
        ];
      });
      const lines = new Map(items.map((i) => [i.id, i.line]));
      setLayout({
        sheet,
        below,
        column,
        width,
        left: column + (annotated ? gutter : 24),
        places: layoutMargin(items, taken).map((p) => ({
          ...p,
          line: lines.get(p.id)!,
        })),
      });
    };
    measure();
    const resize = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    });
    resize.observe(article);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
    // `noted` is derived from marks and placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, marks, placed, heights, revision]);
  // Each note's own height, once drawn (they differ by their text).
  useLayoutEffect(() => {
    if (!layout || layout.below) return;
    const next = new Map<string, number>();
    for (const el of layout.sheet.querySelectorAll<HTMLElement>(
      ".reading-margin-notes [data-note-id]",
    ))
      next.set(el.dataset.noteId!, el.offsetHeight);
    if (
      next.size !== heights.size ||
      [...next].some(([id, h]) => heights.get(id) !== h)
    )
      setHeights(next);
  }, [layout, heights]);
  if (!layout) return null;
  const byId = new Map(noted.map((m) => [m.mark_id, m]));
  if (layout.below)
    // Below its paragraph: a block in the column, a 2 px ink-blue rule left.
    return (
      <>
        {noted.map((m) => {
          const block = blockOf(m.mark_id);
          return block
            ? createPortal(
                <div className="reading-margin-note-below" key={m.mark_id}>
                  <Note
                    mark={m}
                    onOpen={() => onOpen(m.mark_id)}
                    onHover={(hot) => onHover(hot ? m.mark_id : null)}
                  />
                </div>,
                block,
                m.mark_id,
              )
            : null;
        })}
      </>
    );
  const left = layout.left;
  return createPortal(
    <div className="reading-margin-notes" aria-label="页边批注">
      <svg className="reading-margin-leaders" aria-hidden="true">
        {layout.places
          .filter((p) => byId.has(p.id))
          .map((p) => (
            <path
              key={p.id}
              d={`M ${layout.column + 2} ${p.line} H ${left - 8} V ${p.top + 9} H ${left}`}
            />
          ))}
      </svg>
      {layout.places.map((p) => {
        // The layout is measured after a render; a mark that has just lost
        // its note or its place waits for the next measure, off the margin.
        const mark = byId.get(p.id);
        if (!mark) return null;
        return (
          <div
            key={p.id}
            data-note-id={p.id}
            className="reading-margin-note-place"
            style={{ top: p.top, left, width: layout.width }}
          >
            <Note
              mark={mark}
              folded={p.folded}
              onOpen={() => onOpen(p.id)}
              onHover={(hot) => onHover(hot ? p.id : null)}
            />
          </div>
        );
      })}
    </div>,
    layout.sheet,
  );
}
