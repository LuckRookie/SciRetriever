import type { ReactNode } from "react";
import {
  PUBLICATION_FORM_LABELS,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { RichTitle, literatureTone } from "../../components/index.js";
import { paperAuthors, paperTitleParts } from "../../data/library.js";
import { statusLabels } from "../../strings.js";
import { BibliographyTags } from "./TagEvidence.js";
import "./bibliography.css";

const CJK = /[㐀-鿿豈-﫿]/u;
/** Journal names are italic in Latin script only; CJK has no true italic. */
export function Venue({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="paper-venue-missing">期刊未提供</span>;
  return CJK.test(name) ? <span>{name}</span> : <i>{name}</i>;
}

/**
 * The paper's material state (page specs “界面用词”): its status, or
 * “没找到 PDF” for a paper whose automatic routes are exhausted.
 */
export function materialState(item: LiteratureSearchItem): string {
  return item.needs_manual_pdf ? "UNAVAILABLE" : item.literature.status;
}
/** The material state as a status label: dot, words, tinted ground (rule 5). */
export function MaterialBadge({
  item,
  children,
}: {
  item: LiteratureSearchItem;
  children?: ReactNode;
}) {
  const state = materialState(item);
  return (
    <span
      className="paper-status"
      data-state={state}
      data-tone={literatureTone(state)}
    >
      {statusLabels[state]}
      {children}
    </span>
  );
}

/** What kind of paper and when: “期刊论文 · 2024”. */
export function paperKind(item: LiteratureSearchItem): string {
  const m = item.literature.metadata;
  return [
    m.publication_form ? PUBLICATION_FORM_LABELS[m.publication_form] : null,
    m.publication_year,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" · ");
}
/**
 * A paper's bibliography as one block: what kind and when, the title, its
 * authors, where it appeared, what the library holds of it with the caller's
 * actions, then the abstract, keywords and tags. The library's preview shows
 * it; the reader's bibliography page shows the same (plan 25 block 30).
 */
export function BibliographyContent({
  item,
  actions,
  heading = "h2",
  kind: showKind = true,
  holdings = true,
}: {
  item: LiteratureSearchItem;
  /** “打开阅读”, “获取 PDF”: what the place showing it lets one do. */
  actions?: ReactNode;
  /** The title's heading level where the block sits. */
  heading?: "h1" | "h2";
  /** The kind and year line; the reader's page header carries it instead. */
  kind?: boolean;
  /** Tags and what the library holds; the reader's page says that its own way. */
  holdings?: boolean;
}) {
  const m = item.literature.metadata;
  const doi = m.identifiers.find((id) => id.namespace === "doi")?.value;
  const kind = paperKind(item);
  const issue = [
    m.volume ? `${m.volume} 卷` : null,
    m.issue ? `${m.issue} 期` : null,
    m.pages ? `${m.pages} 页` : null,
  ].filter(Boolean);
  const terms = m.keywords.length ? m.keywords : m.subject_terms;
  const Title = heading;
  return (
    <div className="bibliography">
      {kind && showKind ? <p className="bibliography-kind">{kind}</p> : null}
      <Title className="bibliography-title">
        <RichTitle parts={paperTitleParts(item)} />
      </Title>
      <p className="bibliography-authors">{paperAuthors(item)}</p>
      <p className="bibliography-source">
        <Venue name={m.venue} />
        {m.publication_year ? ` · ${m.publication_year}` : " · 年份未提供"}
        {issue.length ? ` · ${issue.join(" ")}` : null}
        {doi ? (
          <>
            {" · "}
            <a
              href={`https://doi.org/${encodeURI(doi)}`}
              target="_blank"
              rel="noreferrer"
            >
              doi:{doi}
            </a>
          </>
        ) : null}
      </p>
      {/* What the library holds and what to do with it come before the
          abstract: they are what a reader decides by. */}
      {holdings ? (
        <p className="bibliography-material">
          <span>材料</span>
          <MaterialBadge item={item} />
          {item.text_level ? (
            <span className="bibliography-note">
              {item.text_level === "draft" ? "全文 · 未校对" : "全文 · 已校对"}
            </span>
          ) : null}
          {item.needs_metadata ? (
            <span className="bibliography-note">书目不全</span>
          ) : null}
        </p>
      ) : null}
      {actions ? <div className="bibliography-actions">{actions}</div> : null}
      <section className="bibliography-part" aria-label="摘要">
        <h3>摘要</h3>
        <p>{m.abstract ?? "尚未提供摘要。"}</p>
      </section>
      {terms.length ? (
        <p className="bibliography-terms">
          <span>{m.keywords.length ? "关键词" : "主题词"}</span>
          {terms.join(" · ")}
        </p>
      ) : null}
      {holdings && item.tags?.length ? (
        <BibliographyTags key={item.literature.literature_id} item={item} />
      ) : null}
    </div>
  );
}
