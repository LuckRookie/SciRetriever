/** What the extension reads from the current page when the user opens it. */
export interface PageReading {
  url: string;
  is_pdf: boolean;
  doi: string | null;
  arxiv: string | null;
  title: string | null;
  authors: string[];
  date: string | null;
  journal: string | null;
  publisher: string | null;
  volume: string | null;
  issue: string | null;
  first_page: string | null;
  last_page: string | null;
  abstract: string | null;
  language: string | null;
  keywords: string[];
  pdf_url: string | null;
}

/**
 * Reads identifiers and bibliographic tags (`citation_*`, Dublin Core,
 * `prism.*`) and the DOI or arXiv number in the address. It is injected into
 * the page with `chrome.scripting.executeScript`, so everything it uses is
 * declared inside it.
 */
export function readPage(): PageReading {
  const tags = new Map<string, string[]>();
  for (const meta of document.querySelectorAll("meta[name], meta[property]")) {
    const name = (
      meta.getAttribute("name") ??
      meta.getAttribute("property") ??
      ""
    ).toLowerCase();
    const content = (meta.getAttribute("content") ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!name || !content) continue;
    tags.set(name, [...(tags.get(name) ?? []), content]);
  }
  const all = (...names: string[]) =>
    names.flatMap((name) => tags.get(name) ?? []);
  const first = (...names: string[]) => all(...names)[0] ?? null;
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const doiOf = (text: string | null) => {
    if (!text) return null;
    const match = /\b(10\.\d{4,9}\/[^\s"'<>]+)/u.exec(decode(text));
    if (!match?.[1]) return null;
    return match[1]
      .replace(/[.,;:)\]}]+$/u, "")
      .replace(/\/(?:full|abstract|pdf|epdf|html)$/iu, "")
      .replace(/\.pdf$/iu, "")
      .toLowerCase();
  };
  const arxivPattern =
    /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)/iu;
  const arxivOf = (text: string | null) => {
    if (!text) return null;
    const match = arxivPattern.exec(decode(text));
    return match?.[1] ? match[1].replace(/\.pdf$/iu, "") : null;
  };
  const url = location.href;
  const is_pdf =
    document.contentType === "application/pdf" ||
    /\.pdf(?:$|[?#])/iu.test(location.pathname);
  let doi = null as string | null;
  for (const value of all(
    "citation_doi",
    "prism.doi",
    "dc.identifier",
    "dc.identifier.doi",
    "bepress_citation_doi",
  )) {
    doi = doiOf(value);
    if (doi) break;
  }
  doi ??= doiOf(url);
  let arxiv =
    arxivOf(url) ??
    arxivOf(
      first("citation_arxiv_id") && `arXiv:${first("citation_arxiv_id")}`,
    );
  // A DataCite arXiv DOI names the preprint itself.
  const arxivDoi = doi ? /^10\.48550\/arxiv\.(.+)$/u.exec(doi) : null;
  if (arxivDoi?.[1]) arxiv ??= arxivDoi[1];
  const absolute = (value: string | null) => {
    if (!value) return null;
    try {
      const resolved = new URL(value, location.href);
      return resolved.protocol === "https:" || resolved.protocol === "http:"
        ? resolved.href
        : null;
    } catch {
      return null;
    }
  };
  const pdf_url = is_pdf
    ? url
    : (absolute(first("citation_pdf_url")) ??
      (arxiv && /(^|\.)arxiv\.org$/u.test(location.hostname)
        ? `https://arxiv.org/pdf/${arxiv}`
        : null));
  return {
    url,
    is_pdf,
    doi,
    arxiv,
    title: first("citation_title", "dc.title", "og:title"),
    authors: all("citation_author", "dc.creator"),
    date: first(
      "citation_publication_date",
      "citation_date",
      "citation_online_date",
      "prism.publicationdate",
      "dc.date",
    ),
    journal: first(
      "citation_journal_title",
      "prism.publicationname",
      "citation_conference_title",
    ),
    publisher: first("citation_publisher", "dc.publisher"),
    volume: first("citation_volume", "prism.volume"),
    issue: first("citation_issue", "prism.number"),
    first_page: first("citation_firstpage", "prism.startingpage"),
    last_page: first("citation_lastpage", "prism.endingpage"),
    abstract: first("citation_abstract", "dc.description"),
    language: first("citation_language", "dc.language"),
    keywords: all("citation_keywords")
      .flatMap((value) => value.split(/[;,]/u))
      .map((value) => value.trim())
      .filter(Boolean),
    pdf_url,
  };
}
