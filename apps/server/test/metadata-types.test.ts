import { describe, expect, it } from "vitest";
import {
  ARTICLE_KINDS,
  PUBLICATION_FORMS,
  ARTICLE_KIND_LABELS,
  PUBLICATION_FORM_LABELS,
  parseArticleKind,
  parsePublicationForm,
} from "@sciretriever/contracts";
import {
  mapSourceType,
  SOURCE_TYPE_MAPPING_VERSION,
} from "../src/literature/metadata-rules.js";

describe("publication form and article kind mapping", () => {
  it.each([
    ["crossref", "journal-article", "journal-article", null, null],
    ["ris", "proceedings-article", "conference-paper", null, null],
    ["crossref", "book", "book-or-chapter", null, null],
    ["crossref", "book-chapter", "book-or-chapter", null, null],
    ["crossref", "dissertation", "thesis", null, null],
    ["ris", "patent", "patent", null, null],
    ["crossref", "report", "report-or-standard", null, null],
    ["crossref", "standard", "report-or-standard", null, null],
    ["crossref", "dataset", "dataset", null, null],
    ["crossref", "posted-content", null, null, "preprint"],
    ["openalex", "article", "journal-article", null, null],
    ["openalex", "review", "journal-article", "review", null],
    ["openalex", "letter", "journal-article", "letter-or-communication", null],
    [
      "openalex",
      "editorial",
      "journal-article",
      "correction-or-editorial",
      null,
    ],
    ["openalex", "erratum", "journal-article", "correction-or-editorial", null],
    ["openalex", "book-chapter", "book-or-chapter", null, null],
    ["openalex", "dissertation", "thesis", null, null],
    ["openalex", "dataset", "dataset", null, null],
    ["openalex", "preprint", null, null, "preprint"],
    ["arxiv", "preprint", null, null, "preprint"],
    ["europe-pmc", "Journal Article", "journal-article", null, null],
    ["europe-pmc", "Review", "journal-article", "review", null],
    ["europe-pmc", "Systematic Review", "journal-article", "review", null],
    ["europe-pmc", "Meta-Analysis", "journal-article", "review", null],
    [
      "europe-pmc",
      "Letter",
      "journal-article",
      "letter-or-communication",
      null,
    ],
    [
      "europe-pmc",
      "Comment",
      "journal-article",
      "perspective-or-commentary",
      null,
    ],
    [
      "europe-pmc",
      "Editorial",
      "journal-article",
      "correction-or-editorial",
      null,
    ],
    [
      "europe-pmc",
      "Published Erratum",
      "journal-article",
      "correction-or-editorial",
      null,
    ],
    ["datacite", "Dataset", "dataset", null, null],
    ["datacite", "Text", null, null, null],
    ["datacite", "Book", "book-or-chapter", null, null],
    ["datacite", "BookChapter", "book-or-chapter", null, null],
    ["datacite", "ConferencePaper", "conference-paper", null, null],
    ["datacite", "Dissertation", "thesis", null, null],
    ["datacite", "JournalArticle", "journal-article", null, null],
    ["datacite", "Report", "report-or-standard", null, null],
    ["datacite", "Standard", "report-or-standard", null, null],
    ["datacite", "Preprint", null, null, "preprint"],
    ["opencitations", "journal-article", "journal-article", null, null],
    ["unknown-provider", "article", null, null, null],
    ["crossref", "article", null, null, null],
    ["openalex", "research-article", null, null, null],
    ["europe-pmc", "Journal Article; Review", null, null, null],
    ["datacite", null, null, null, null],
    ["crossref", "constructor", null, null, null],
    ["__proto__", "constructor", null, null, null],
  ] as const)(
    "maps %s/%s without guessing",
    (provider, raw, form, kind, role) => {
      expect(mapSourceType(provider, raw)).toEqual({
        publication_form: form,
        article_kind_hint: kind,
        version_role_hint: role,
      });
    },
  );
  it("normalizes only for lookup and leaves the original string to the observation owner", () => {
    const raw = "  Journal   Article ";
    expect(mapSourceType("EUROPE-PMC", raw).publication_form).toBe(
      "journal-article",
    );
    expect(raw).toBe("  Journal   Article ");
    expect(SOURCE_TYPE_MAPPING_VERSION).toBe("source-type-v1");
  });
  it("has one complete display vocabulary and rejects values outside each distinct enum", () => {
    for (const value of PUBLICATION_FORMS) {
      expect(parsePublicationForm(value)).toBe(value);
      expect(PUBLICATION_FORM_LABELS[value]).toBeTruthy();
      expect(() => parseArticleKind(value)).toThrow();
    }
    for (const value of ARTICLE_KINDS) {
      expect(parseArticleKind(value)).toBe(value);
      expect(ARTICLE_KIND_LABELS[value]).toBeTruthy();
      expect(() => parsePublicationForm(value)).toThrow();
    }
    expect(parsePublicationForm(null)).toBeNull();
    expect(parseArticleKind(null)).toBeNull();
    for (const value of [undefined, "preprint", "Text", "", 1, {}, "REVIEW"]) {
      expect(() => parsePublicationForm(value)).toThrow();
      expect(() => parseArticleKind(value)).toThrow();
    }
  });
});
