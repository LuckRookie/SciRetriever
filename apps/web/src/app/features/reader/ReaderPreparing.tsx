import { useSyncExternalStore, type CSSProperties } from "react";
import type { LiteratureSearchItem } from "@sciretriever/contracts";
import type { LoadProgress, LoadStep } from "../../../reading/contract.js";
import { RichTitle } from "../../components/index.js";
import { paperAuthors, paperTitleParts } from "../../data/library.js";

/** The latest step of the view being prepared; only the skeleton listens, once a frame. */
export interface PreparingProgress {
  readonly id: string;
  readonly kind: string;
  readonly progress: LoadProgress;
}
export function createPreparingStore() {
  let value: PreparingProgress | null = null,
    frame = 0;
  const listeners = new Set<() => void>();
  return {
    set(next: PreparingProgress) {
      value = next;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        for (const listener of listeners) listener();
      });
    },
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type PreparingStore = ReturnType<typeof createPreparingStore>;
const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
/** One step's words: its name, and how far it got where that is counted. */
function stepText(step: LoadStep) {
  if (step.done === undefined || step.total === undefined) return step.label;
  if (step.unit === "bytes")
    return step.state === "current"
      ? `${step.label} ${megabytes(step.done)} / ${megabytes(step.total)}`
      : step.label;
  if (step.unit === "pages") return `${step.label} ${step.total} 页`;
  return step.label;
}

/**
 * Spec 6.3 (with section 10 before the new layout): the skeleton of the view
 * being prepared, in the content area where its text or pages will be. The
 * title, authors and source come from the bibliography at once; below them
 * the steps of the actual loading and a 2 px bar; then skeleton lines. It lies
 * over the content, so nothing moves when the text replaces it.
 */
export function ReaderPreparing({
  id,
  kind,
  paper,
  store,
  initial,
  width,
  fontSize,
}: {
  id: string;
  kind: "pdf" | "doc";
  /** Null while the paper's details are still those of the paper before. */
  paper: LiteratureSearchItem | null;
  store: PreparingStore;
  /** The steps before the engine reports any. */
  initial: LoadProgress;
  /** The text column's width class and font size, as the text will have them. */
  width: "" | "reading-wide" | "reading-full";
  fontSize: number;
}) {
  const latest = useSyncExternalStore(store.subscribe, store.get),
    progress =
      latest?.id === id && latest.kind === kind ? latest.progress : initial;
  const m = paper?.literature.metadata,
    source = m ? [m.venue, m.publication_year].filter(Boolean).join(" · ") : "";
  return (
    <div
      className={`reader-preparing ${width}`}
      style={{ "--reading-font-size": `${fontSize}px` } as CSSProperties}
      data-view={kind}
      role="status"
      aria-busy="true"
      aria-label={kind === "pdf" ? "正在准备 PDF" : "正在准备全文"}
    >
      <article
        className={`reader-preparing-sheet${kind === "pdf" ? " reader-preparing-pages" : ""}`}
      >
        <div className="reader-preparing-head">
          {paper ? (
            <>
              <h1 className="reader-preparing-title">
                <RichTitle parts={paperTitleParts(paper)} />
              </h1>
              <p className="reader-preparing-byline">
                {paperAuthors(paper)}
                {source ? <span> · {source}</span> : null}
              </p>
            </>
          ) : (
            <div className="reader-skeleton-title" aria-hidden="true">
              <span />
              <span />
            </div>
          )}
          <p className="reader-preparing-steps">
            <span>{kind === "pdf" ? "正在准备 PDF" : "正在准备全文"}</span>
            {progress.steps.map((step) => (
              <span
                key={step.id}
                className="reader-preparing-step"
                data-state={step.state}
              >
                {step.state === "done" ? (
                  <span className="reader-preparing-mark" aria-hidden="true">
                    ✓
                  </span>
                ) : step.state === "current" ? (
                  <span className="ui-spinner" aria-hidden="true" />
                ) : null}
                {stepText(step)}
              </span>
            ))}
          </p>
          <div
            className="reader-preparing-bar"
            role="progressbar"
            aria-label="准备进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.fraction * 100)}
          >
            <span style={{ width: `${progress.fraction * 100}%` }} />
          </div>
        </div>
        {kind === "pdf" ? (
          <div className="reader-skeleton-page" aria-hidden="true" />
        ) : (
          <div className="reader-skeleton-text" aria-hidden="true">
            <div className="reader-skeleton-abstract">
              {[0, 1, 2].map((n) => (
                <span key={n} />
              ))}
            </div>
            {[5, 4, 6].map((lines, p) => (
              <p key={p} className="reader-skeleton-paragraph">
                {Array.from({ length: lines }, (_, n) => (
                  <span key={n} />
                ))}
              </p>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
