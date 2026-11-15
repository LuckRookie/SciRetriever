import {
  EMPTY_METADATA,
  parseLiteratureMetadata,
  parsePublicSourceUrl,
  parseWebPageData,
  type IntakeAdapter,
  type IntakeExcluded,
} from "@sciretriever/contracts";
import {
  clueArxiv,
  clueDois,
  clueText,
  uniqueIdentifiers,
} from "./import-clues.js";

const ARTICLE_TYPES = new Set([
  "ScholarlyArticle",
  "MedicalScholarlyArticle",
  "Article",
  "Report",
  "Thesis",
  "Chapter",
  "NewsArticle",
  "AnalysisNewsArticle",
  "AskPublicNewsArticle",
  "BackgroundNewsArticle",
  "OpinionNewsArticle",
  "ReportageNewsArticle",
  "ReviewNewsArticle",
  "AdvertiserContentArticle",
  "SatiricalArticle",
  "SocialMediaPosting",
  "BlogPosting",
  "LiveBlogPosting",
  "DiscussionForumPosting",
  "TechArticle",
  "APIReference",
]);
type Json = Record<string, unknown>;
const object = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.filter((v): v is string => typeof v === "string")
      : [];
function named(value: unknown): string[] {
  const result: string[] = [],
    pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (Array.isArray(next)) pending.push(...[...next].reverse());
    else if (object(next))
      result.push(
        ...strings(
          next.name ??
            ([...strings(next.givenName), ...strings(next.familyName)].join(
              " ",
            ) ||
              next.legalName),
        ),
      );
    else result.push(...strings(next));
  }
  return result;
}
function containers(article: Json): Json[] {
  const result: Json[] = [],
    pending: unknown[] = [article.isPartOf];
  while (pending.length) {
    const next = pending.pop();
    if (Array.isArray(next)) pending.push(...[...next].reverse());
    else if (object(next)) {
      result.push(next);
      pending.push(next.isPartOf);
    }
  }
  return result;
}
function dateOf(value: string | null) {
  const m = value
    ? /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?/u.exec(value)
    : null;
  if (!m?.[1] || Number(m[1]) < 1) return { date: null, year: null };
  const [, year, month, day] = m;
  return {
    year: Number(year),
    date:
      month && Number(month) >= 1 && Number(month) <= 12
        ? day && Number(day) >= 1 && Number(day) <= 31
          ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
          : `${year}-${month.padStart(2, "0")}`
        : year,
  };
}
/** Pure conversion of original tags. It never fetches the page or its PDF. */
export function decodeWebPage(value: unknown) {
  const page = parseWebPageData(value),
    tags = new Map<string, string[]>(),
    articles: Json[] = [],
    excluded: IntakeExcluded[] = [];
  for (const meta of page.meta) {
    const key = meta.key.toLowerCase(),
      text = clueText(meta.content);
    if (key && text) tags.set(key, [...(tags.get(key) ?? []), text]);
  }
  let invalid = 0;
  for (const text of page.json_ld) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      invalid++;
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const next = queue.pop();
      if (Array.isArray(next)) {
        queue.push(...[...next].reverse());
        continue;
      }
      if (!object(next)) continue;
      if (
        strings(next["@type"]).some((type) =>
          ARTICLE_TYPES.has(
            type.replace(/^https?:\/\/(?:www\.)?schema\.org[/#]/u, ""),
          ),
        )
      )
        articles.push(next);
      if (Array.isArray(next["@graph"]))
        queue.push(...[...next["@graph"]].reverse());
    }
  }
  if (invalid) excluded.push({ kind: "invalid-json-ld", count: invalid });
  const parts = articles.flatMap(containers);
  const all = (...keys: string[]) => keys.flatMap((key) => tags.get(key) ?? []),
    json = (key: string) =>
      (["volumeNumber", "issueNumber"].includes(key)
        ? [...articles, ...parts]
        : articles
      )
        .flatMap((article) =>
          typeof article[key] === "number" &&
          ["volumeNumber", "issueNumber", "pageStart", "pageEnd"].includes(
            key,
          ) &&
          Number.isFinite(article[key])
            ? [String(article[key])]
            : strings(article[key]),
        )
        .map(clueText)
        .filter(Boolean),
    first = (...keys: string[]) => all(...keys)[0] ?? null,
    jsonFirst = (...keys: string[]) => keys.flatMap(json)[0] ?? null;
  const jsonIds = articles
    .flatMap((article) => [article.identifier, article.sameAs])
    .flatMap((value) => {
      const values = Array.isArray(value) ? value : [value];
      return values.flatMap((item) =>
        object(item) ? strings(item.value ?? item["@id"]) : strings(item),
      );
    });
  const doi =
    [
      ...all(
        "citation_doi",
        "prism.doi",
        "dc.identifier",
        "dc.identifier.doi",
        "bepress_citation_doi",
      ),
      ...jsonIds,
      page.url,
    ].flatMap(clueDois)[0] ?? null;
  const arxivValue =
    clueArxiv(page.url)[0] ??
    clueArxiv(`arXiv:${first("citation_arxiv_id") ?? ""}`)[0] ??
    (doi?.value.startsWith("10.48550/arxiv.")
      ? clueArxiv(`arXiv:${doi.value.slice("10.48550/arxiv.".length)}`)[0]
      : null) ??
    null;
  const absolute = (value: string | null) => {
    if (!value) return null;
    try {
      return parsePublicSourceUrl(new URL(value, page.url).href);
    } catch {
      return null;
    }
  };
  const url = new URL(page.url),
    pdf_url = page.is_pdf
      ? page.url
      : (absolute(first("citation_pdf_url")) ??
        (arxivValue && /(^|\.)arxiv\.org$/u.test(url.hostname)
          ? `https://arxiv.org/pdf/${arxivValue.value}`
          : null));
  const authors = [
      ...new Set(
        [
          ...all("citation_author", "dc.creator"),
          ...articles.flatMap((a) => named(a.author)),
        ]
          .map(clueText)
          .filter(Boolean),
      ),
    ].slice(0, 500),
    keywords = [
      ...new Set(
        [...all("citation_keywords"), ...json("keywords")]
          .flatMap((v) => v.split(/[;,]/u))
          .map(clueText)
          .filter(Boolean),
      ),
    ].slice(0, 100),
    date = dateOf(
      first(
        "citation_publication_date",
        "citation_date",
        "citation_online_date",
        "prism.publicationdate",
        "dc.date",
      ) ?? jsonFirst("datePublished"),
    ),
    language =
      first("citation_language", "dc.language") ?? jsonFirst("inLanguage"),
    firstPage =
      first("citation_firstpage", "prism.startingpage") ??
      jsonFirst("pageStart"),
    lastPage =
      first("citation_lastpage", "prism.endingpage") ?? jsonFirst("pageEnd");
  const venue =
    [
      ...parts.filter((p) =>
        strings(p["@type"]).some((t) => t.endsWith("Periodical")),
      ),
      ...parts,
    ]
      .flatMap(named)
      .map(clueText)[0] ?? null;
  const metadata = parseLiteratureMetadata({
    ...EMPTY_METADATA,
    title:
      first("citation_title", "dc.title") ??
      jsonFirst("headline", "name") ??
      first("og:title") ??
      (page.title ? clueText(page.title) || null : null),
    authors: authors.map((display_name) => ({
      kind: "unknown",
      display_name,
      given_name: null,
      family_name: null,
      orcid: null,
      affiliations: [],
    })),
    publication_date: date.date,
    publication_year: date.year,
    venue:
      first(
        "citation_journal_title",
        "prism.publicationname",
        "citation_conference_title",
      ) ?? venue,
    publisher:
      first("citation_publisher", "dc.publisher") ??
      articles.flatMap((a) => named(a.publisher)).map(clueText)[0] ??
      null,
    volume:
      first("citation_volume", "prism.volume") ?? jsonFirst("volumeNumber"),
    issue: first("citation_issue", "prism.number") ?? jsonFirst("issueNumber"),
    pages: firstPage
      ? lastPage && lastPage !== firstPage
        ? `${firstPage}-${lastPage}`
        : firstPage
      : jsonFirst("pagination"),
    abstract:
      first("citation_abstract", "dc.description") ??
      jsonFirst("abstract", "description"),
    language:
      language && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language)
        ? language.toLowerCase()
        : null,
    keywords,
    identifiers: uniqueIdentifiers([
      ...(doi ? [doi] : []),
      ...(arxivValue ? [arxivValue] : []),
    ]),
  });
  return { page, metadata, pdf_url, excluded };
}
export const webPageAdapter: IntakeAdapter = {
  format: "web-page",
  decode(value, sequence) {
    const { metadata, page, excluded } = decodeWebPage(value);
    return {
      groups: [],
      excluded,
      items: [
        {
          record_index: 0,
          reason: page.is_pdf
            ? "file-required"
            : !metadata.title && !metadata.identifiers.length
              ? "missing-title-or-doi"
              : null,
          record:
            page.is_pdf || (!metadata.title && !metadata.identifiers.length)
              ? null
              : {
                  external_id: `page:${sequence}`,
                  metadata,
                  source_type: null,
                  groups: [],
                  user_tags: [],
                  files: [],
                  annotations: [],
                },
        },
      ],
    };
  },
};
