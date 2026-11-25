import { useEffect, useState } from "react";
import {
  PUBLICATION_FORM_LABELS,
  type LiteratureSearchItem,
  type TextLevel,
} from "@sciretriever/contracts";
import { paperAuthors, paperTitle } from "../../data/library.js";
import type {
  DocumentTextMode,
  PdfControls,
} from "../../../reading/contract.js";
import { fullTextStrings } from "../../strings.js";

/**
 * Spec 1.2: where the paper comes from. A journal paper: “《刊名》年, 卷(期):
 * 页码”; anything else: the one bibliographic item that best says its source.
 */
export function paperSource(paper: LiteratureSearchItem): string {
  const m = paper.literature.metadata;
  if (m.venue) {
    const issue = m.issue ? `(${m.issue})` : "",
      volume = m.volume ? `${m.volume}${issue}` : issue;
    let text = `《${m.venue}》`;
    if (m.publication_year) text += `${m.publication_year}`;
    if (volume) text += `${m.publication_year ? ", " : ""}${volume}`;
    if (m.pages) text += `: ${m.pages}`;
    return text;
  }
  const authors = m.authors.length ? paperAuthors(paper) : null;
  return [
    m.publication_form ? PUBLICATION_FORM_LABELS[m.publication_form] : null,
    m.publisher || authors,
    m.publication_year,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What shows and on which text (spec 1.2): the text's grade (初稿, 校订稿)
 * comes with plan 21's 10.3; no version number is written. In the PDF the
 * page number is a text button: pressed, it becomes a field, and the page
 * typed there is opened.
 */
function ViewText({
  kind,
  pdf,
  level,
  reading,
  scaleText,
  pageEdit,
}: {
  kind: "doc" | "pdf";
  pdf: PdfControls | null;
  level: TextLevel | null;
  reading: DocumentTextMode;
  scaleText: string | null;
  pageEdit: number;
}) {
  const [editing, setEditing] = useState(false);
  // `G` and “跳到页码…” put the focus in the page field (spec 1.8.4).
  useEffect(() => {
    if (pageEdit) setEditing(true);
  }, [pageEdit]);
  // The reading scale while it is not 100%, or just changed (spec 1.2).
  const [lastScale, setLastScale] = useState(scaleText);
  if (scaleText && scaleText !== lastScale) setLastScale(scaleText);
  if (kind === "doc")
    return (
      <span>
        {fullTextStrings.view}
        {level ? ` · ${level === "draft" ? "未校对" : "已校对"}` : ""}
        {/* Reading-experience 9: a translation says it is one. */}
        {reading === "original" ? "" : ` · ${fullTextStrings.header[reading]}`}
        {scaleText || lastScale ? (
          <span
            className="reader-page-header-scale"
            data-shown={scaleText ? true : undefined}
            aria-hidden={!scaleText}
            // Faded out, it leaves no gap at the header's right end.
            onTransitionEnd={() => {
              if (!scaleText) setLastScale(null);
            }}
          >
            {` · ${scaleText ?? lastScale}`}
          </span>
        ) : null}
      </span>
    );
  if (!pdf) return <span>PDF</span>;
  const zoom =
    pdf.zoom === "fit" ? "适合宽度" : `${Math.round(pdf.zoom * 100)}%`;
  const go = (field: HTMLInputElement) => {
    const page = Math.trunc(Number(field.value));
    if (page >= 1 && page <= pdf.total) pdf.go(page);
    setEditing(false);
  };
  return (
    <span>
      PDF ·{" "}
      {editing ? (
        <input
          className="reader-page-header-page-field"
          type="number"
          aria-label="PDF 页码"
          min={1}
          max={pdf.total}
          defaultValue={pdf.page}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") go(event.currentTarget);
            else if (event.key === "Escape") setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          className="reader-page-header-page"
          aria-label={`第 ${pdf.page} / ${pdf.total} 页，跳到页`}
          onClick={() => setEditing(true)}
        >
          第 {pdf.page} / {pdf.total} 页
        </button>
      )}{" "}
      · {zoom}
    </span>
  );
}

export interface HeaderLine {
  /** Fades after the next scroll or 8 s; otherwise it stays (spec 1.2). */
  transient: boolean;
  text: string;
  action?: { label: string; run(): void };
}

/**
 * The sheet's page header (spec 1.2): the source on the left, what shows on
 * the right, the way back after a jump before it, and below the rule one line
 * that says what needs saying there — never more than one.
 */
export function ReaderPageHeader({
  kind,
  paper,
  narrow,
  pdf,
  level,
  back,
  line,
  scroller,
  scaleText = null,
  pageEdit = 0,
  reading = "original",
}: {
  kind: "doc" | "pdf";
  /** The full text's level, once read (reading-experience 1.2, 3.4). */
  level: TextLevel | null;
  paper: LiteratureSearchItem;
  /** The top bar is narrower than 640 px: the title replaces the source. */
  narrow: boolean;
  pdf: PdfControls | null;
  back: { label: string; go(): void } | null;
  line: HeaderLine | null;
  scroller: HTMLElement | null;
  /** The full text's reading scale (“110%”) when it shows (spec 1.2). */
  scaleText?: string | null;
  /** Bumped to put the focus in the PDF's page field. */
  pageEdit?: number;
  /** The full text's reading shown (reading-experience 9). */
  reading?: DocumentTextMode;
}) {
  const [faded, setFaded] = useState<HeaderLine | null>(null);
  useEffect(() => {
    if (!line?.transient) return;
    setFaded(null);
    const fade = () => setFaded(line);
    const timer = setTimeout(fade, 8000);
    // The next scroll by the reader, not the one that brought the text here.
    let armed = false;
    const arm = requestAnimationFrame(() =>
      requestAnimationFrame(() => (armed = true)),
    );
    const onScroll = () => {
      if (armed) fade();
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(arm);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [line, scroller]);
  const shown = line && faded !== line ? line : null;
  const left = narrow ? paperTitle(paper) : paperSource(paper);
  return (
    <>
      <span className="reader-page-header-source" title={left}>
        {left}
      </span>
      <span className="reader-page-header-view">
        {back ? (
          <button
            type="button"
            className="reader-page-header-back"
            title="Alt+←"
            onClick={back.go}
          >
            ↩ 回到{back.label.startsWith("¶") ? " " : ""}
            {back.label}
          </button>
        ) : null}
        <ViewText
          kind={kind}
          pdf={pdf}
          level={level}
          reading={reading}
          scaleText={scaleText}
          pageEdit={pageEdit}
        />
      </span>
      {shown ? (
        <p
          className="reader-page-header-line"
          role="status"
          data-transient={shown.transient || undefined}
        >
          {/* One line: what does not fit is cut, and shows in full on hover. */}
          <span className="reader-page-header-line-text" title={shown.text}>
            {shown.text}
          </span>
          {shown.action ? (
            <button
              type="button"
              className="reader-page-header-action"
              onClick={shown.action.run}
            >
              {shown.action.label}
            </button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
