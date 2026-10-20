import type {
  PublicationForm,
  ArticleKind,
  VersionRole,
} from "@sciretriever/contracts";

export const SOURCE_TYPE_MAPPING_VERSION = "source-type-v1";
export interface SourceTypeMapping {
  readonly publication_form: PublicationForm | null;
  readonly article_kind_hint: ArticleKind | null;
  readonly version_role_hint: VersionRole | null;
}
type Mapping = readonly [
  PublicationForm | null,
  ArticleKind | null,
  VersionRole | null,
];
const UNKNOWN: Mapping = [null, null, null];
const PREPRINT: Mapping = [null, null, "preprint"];
const FORMS: Readonly<Record<string, Mapping>> = {
  "journal-article": ["journal-article", null, null],
  "proceedings-article": ["conference-paper", null, null],
  book: ["book-or-chapter", null, null],
  "book-chapter": ["book-or-chapter", null, null],
  dissertation: ["thesis", null, null],
  thesis: ["thesis", null, null],
  patent: ["patent", null, null],
  report: ["report-or-standard", null, null],
  standard: ["report-or-standard", null, null],
  dataset: ["dataset", null, null],
};
const CROSSREF = { ...FORMS, "posted-content": PREPRINT };
const OPENALEX: Readonly<Record<string, Mapping>> = {
  ...FORMS,
  article: ["journal-article", null, null],
  review: ["journal-article", "review", null],
  letter: ["journal-article", "letter-or-communication", null],
  editorial: ["journal-article", "correction-or-editorial", null],
  erratum: ["journal-article", "correction-or-editorial", null],
  preprint: PREPRINT,
};
const EUROPE_PMC: Readonly<Record<string, Mapping>> = {
  "journal article": ["journal-article", null, null],
  review: ["journal-article", "review", null],
  "systematic review": ["journal-article", "review", null],
  "meta-analysis": ["journal-article", "review", null],
  letter: ["journal-article", "letter-or-communication", null],
  comment: ["journal-article", "perspective-or-commentary", null],
  editorial: ["journal-article", "correction-or-editorial", null],
  "published erratum": ["journal-article", "correction-or-editorial", null],
  preprint: PREPRINT,
  book: FORMS.book!,
};
const DATACITE: Readonly<Record<string, Mapping>> = {
  dataset: FORMS.dataset!,
  book: FORMS.book!,
  bookchapter: FORMS["book-chapter"]!,
  conferencepaper: FORMS["proceedings-article"]!,
  journalarticle: FORMS["journal-article"]!,
  dissertation: FORMS.dissertation!,
  report: FORMS.report!,
  standard: FORMS.standard!,
  preprint: PREPRINT,
  // DataCite Text is broader than a paper: do not guess a publication form.
  text: UNKNOWN,
};
const SOURCES: Readonly<Record<string, Readonly<Record<string, Mapping>>>> = {
  crossref: CROSSREF,
  ris: {
    ...CROSSREF,
    jour: FORMS["journal-article"]!,
    conf: FORMS["proceedings-article"]!,
    cpaper: FORMS["proceedings-article"]!,
    book: FORMS.book!,
    chap: FORMS["book-chapter"]!,
    thes: FORMS.thesis!,
    pat: FORMS.patent!,
    rpt: FORMS.report!,
    rprt: FORMS.report!,
    data: FORMS.dataset!,
    stan: FORMS.standard!,
  },
  bibtex: {
    article: FORMS["journal-article"]!,
    inproceedings: FORMS["proceedings-article"]!,
    conference: FORMS["proceedings-article"]!,
    book: FORMS.book!,
    inbook: FORMS.book!,
    incollection: FORMS.book!,
    phdthesis: FORMS.thesis!,
    mastersthesis: FORMS.thesis!,
    techreport: FORMS.report!,
    patent: FORMS.patent!,
    dataset: FORMS.dataset!,
  },
  biblatex: {
    article: FORMS["journal-article"]!,
    inproceedings: FORMS["proceedings-article"]!,
    book: FORMS.book!,
    inbook: FORMS.book!,
    incollection: FORMS.book!,
    thesis: FORMS.thesis!,
    report: FORMS.report!,
    patent: FORMS.patent!,
    dataset: FORMS.dataset!,
  },
  "csl-json": {
    "article-journal": FORMS["journal-article"]!,
    "paper-conference": FORMS["proceedings-article"]!,
    book: FORMS.book!,
    chapter: FORMS.book!,
    thesis: FORMS.thesis!,
    patent: FORMS.patent!,
    report: FORMS.report!,
    standard: FORMS.standard!,
    dataset: FORMS.dataset!,
  },
  "bibliographic-import": CROSSREF,
  openalex: OPENALEX,
  arxiv: { preprint: PREPRINT },
  "europe-pmc": EUROPE_PMC,
  datacite: DATACITE,
  // OpenCitations returns Crossref-style types for its metadata records.
  opencitations: CROSSREF,
};
/** Deterministic hints only. The caller keeps the untouched source_type in its observation. */
export function mapSourceType(
  provider: string,
  raw: string | null,
): SourceTypeMapping {
  const sourceName = provider.trim().toLowerCase();
  const source = Object.hasOwn(SOURCES, sourceName)
    ? SOURCES[sourceName]
    : undefined;
  const key = raw?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const mapping =
    key && source
      ? Object.hasOwn(source, key)
        ? source[key]!
        : UNKNOWN
      : UNKNOWN;
  return Object.freeze({
    publication_form: mapping[0],
    article_kind_hint: mapping[1],
    version_role_hint: mapping[2],
  });
}
