import type { LiteratureSearchItem } from "@sciretriever/contracts";
import { Button, Icon } from "../../components/index.js";
import {
  BibliographyContent,
  paperKind,
} from "../bibliography/Bibliography.js";

/**
 * Where the publisher shows the paper: its DOI resolved, else its arXiv or
 * PubMed page; null when the bibliography names none of them.
 */
export function publisherPage(item: LiteratureSearchItem): string | null {
  const ids = item.literature.metadata.identifiers,
    value = (namespace: string) =>
      ids.find((id) => id.namespace === namespace)?.value;
  const doi = value("doi"),
    arxiv = value("arxiv"),
    pmid = value("pmid");
  if (doi) return `https://doi.org/${encodeURI(doi)}`;
  if (arxiv) return `https://arxiv.org/abs/${encodeURIComponent(arxiv)}`;
  if (pmid)
    return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
  return null;
}

/**
 * The bibliography page (plan 25 block 30, reading-experience 9.0): a paper
 * without a PDF opens as its bibliography set on the sheet — kind and year in
 * the page header, then title, authors, journal, volume and issue with the
 * DOI, the abstract between two rules and the keywords — and one line below
 * on how to get its full text. The views and the spine do not show.
 */
export function ReaderBibliography({
  item,
  canAct,
  onAcquire,
  onUpload,
}: {
  item: LiteratureSearchItem;
  /** This deployment can fetch and take in a PDF. */
  canAct: boolean;
  onAcquire: () => void;
  onUpload: () => void;
}) {
  // “没找到 PDF”: the automatic routes were tried; uploading is what is left.
  const exhausted = item.needs_manual_pdf;
  const publisher = publisherPage(item);
  const kind = paperKind(item);
  return (
    <div className="reading-scroll reader-bibliography-scroll">
      <article className="reader-bibliography-sheet" aria-label="书目">
        <header className="reader-page-header">
          <span className="reader-page-header-source" title={kind}>
            {kind}
          </span>
          <span className="reader-page-header-view">书目</span>
        </header>
        <div className="reader-bibliography-column">
          <BibliographyContent
            item={item}
            heading="h1"
            kind={false}
            holdings={false}
          />
          <div
            className="reader-bibliography-fulltext"
            role="group"
            aria-label="全文"
          >
            <p>
              {exhausted
                ? "自动找过，没找到 PDF。可以自己上传。"
                : "这篇还没有全文。"}
            </p>
            {canAct && !exhausted ? (
              <Button variant="primary" size="compact" onPress={onAcquire}>
                获取 PDF
              </Button>
            ) : null}
            {canAct ? (
              <Button
                variant={exhausted ? "primary" : "secondary"}
                size="compact"
                onPress={onUpload}
              >
                上传 PDF
              </Button>
            ) : null}
            {publisher ? (
              <a
                className="reader-bibliography-publisher"
                href={publisher}
                target="_blank"
                rel="noreferrer"
              >
                去出版社页面
                <Icon name="external" />
              </a>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}
