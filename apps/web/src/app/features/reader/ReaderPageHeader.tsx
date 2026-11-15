import { useEffect, useState } from "react";
import {
  PUBLICATION_FORM_LABELS,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { paperAuthors, paperTitle } from "../../data/library.js";
import type { PdfControls } from "../../../reading/contract.js";

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

/** What shows and on which text (spec 1.2); the text version comes with plan 21. */
function viewText(kind: "doc" | "pdf", pdf: PdfControls | null) {
  if (kind === "doc") return "原文";
  if (!pdf) return "PDF";
  const zoom = pdf.zoom === "fit" ? "适宽" : `${Math.round(pdf.zoom * 100)}%`;
  return `PDF · 第 ${pdf.page} / ${pdf.total} 页 · ${zoom}`;
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
  back,
  line,
  scroller,
}: {
  kind: "doc" | "pdf";
  paper: LiteratureSearchItem;
  /** The top bar is narrower than 640 px: the title replaces the source. */
  narrow: boolean;
  pdf: PdfControls | null;
  back: { label: string; go(): void } | null;
  line: HeaderLine | null;
  scroller: HTMLElement | null;
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
        <span>{viewText(kind, pdf)}</span>
      </span>
      {shown ? (
        <p
          className="reader-page-header-line"
          role="status"
          data-transient={shown.transient || undefined}
        >
          {shown.text}
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
