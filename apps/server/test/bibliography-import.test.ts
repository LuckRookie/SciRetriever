import { describe, expect, it } from "vitest";
import { decodeBibliography, importBibliography } from "../src/index.js";

const options = {
  observationId: (() => {
    let value = 0;
    return () => `00000000-0000-4000-8100-${String(++value).padStart(12, "0")}`;
  })(),
  provenanceId: (() => {
    let value = 0;
    return () => `00000000-0000-4000-8200-${String(++value).padStart(12, "0")}`;
  })(),
  observedAt: () => "2026-09-11T00:00:00Z",
};

describe("TypeScript bibliography import codecs", () => {
  it("decodes BibTeX and BibLaTeX into user observations", () => {
    const source = new TextEncoder().encode(`@article{fixture,
      title = {A {nested} title},
      author = {Lovelace, Ada and Turing, Alan},
      year = {2026},
      journal = {Fixture Journal},
      doi = {10.1000/fixture},
      keywords = {quantum, materials}
    }`);
    for (const format of ["bibtex", "biblatex"] as const) {
      const result = decodeBibliography(source, format, options);
      expect(result.items[0]?.status).toBe("decoded");
      expect(result.items[0]?.observation?.metadata.title).toBe(
        "A {nested} title",
      );
      expect(result.items[0]?.observation?.metadata.authors).toHaveLength(2);
      expect(result.items[0]?.observation?.metadata.identifiers).toEqual([
        { namespace: "doi", value: "10.1000/fixture" },
      ]);
      expect(result.items[0]?.observation?.provenance.source_name).toBe(
        "bibliographic-import",
      );
    }
    const utf16 = decodeBibliography(
      Buffer.from(
        "\ufeff@article{utf16,title={UTF-16 title},doi={10.1000/utf16}}",
        "utf16le",
      ),
      "bibtex",
      options,
    );
    expect(utf16.items[0]?.observation?.metadata.title).toBe("UTF-16 title");
  });

  it("decodes RIS and CSL-JSON, while keeping malformed records visible", () => {
    const ris = new TextEncoder().encode(
      [
        "TY  - JOUR",
        "TI  - RIS title",
        "AU  - Lovelace, Ada",
        "PY  - 2025",
        "DO  - 10.1000/ris",
        "ER  -",
        "",
      ].join("\r\n"),
    );
    const risResult = decodeBibliography(ris, "ris", options);
    expect(risResult.items[0]?.observation?.metadata.title).toBe("RIS title");
    expect(risResult.items[0]?.observation?.metadata.publication_year).toBe(
      2025,
    );

    const csl = new TextEncoder().encode(
      JSON.stringify([
        {
          type: "article-journal",
          title: "CSL title",
          DOI: "10.1000/csl",
          author: [{ family: "Lovelace", given: "Ada" }],
          issued: { "date-parts": [[2024, 2, 3]] },
          "container-title": "CSL Journal",
        },
      ]),
    );
    const cslResult = decodeBibliography(csl, "csl-json", options);
    expect(cslResult.items[0]?.observation?.metadata.title).toBe("CSL title");
    expect(cslResult.items[0]?.observation?.metadata.venue).toBe("CSL Journal");

    const malformed = decodeBibliography(
      new TextEncoder().encode("@article{broken"),
      "bibtex",
      options,
    );
    expect(malformed.items[0]).toMatchObject({
      status: "rejected",
      reason: "malformed-record",
    });
  });

  it("keeps good records around format-local failures and preserves neutral fields", () => {
    const bibtex = decodeBibliography(
      new TextEncoder().encode(`@article{one,
  title={First title},
  author={Lovelace, Ada and {Example Consortium}},
  doi={https://doi.org/10.1000/FIRST},
  date={2026-8-12},
  publisher={Press One}
}
@article{broken,
  title={Unbalanced title}
@book{three,
  title={Third title},
  isbn={978-1-4028-9462-6},
  year={2024}
}`),
      "bibtex",
      options,
    );
    expect(bibtex.items.map((item) => item.status)).toEqual([
      "decoded",
      "rejected",
      "decoded",
    ]);
    expect(bibtex.items[0]?.observation?.metadata).toMatchObject({
      title: "First title",
      publication_date: "2026-08-12",
      publication_year: 2026,
      publisher: "Press One",
      identifiers: [{ namespace: "doi", value: "10.1000/first" }],
    });
    expect(
      bibtex.items[0]?.observation?.metadata.authors.map((item) => ({
        kind: item.kind,
        display_name: item.display_name,
      })),
    ).toEqual([
      { kind: "person", display_name: "Lovelace, Ada" },
      { kind: "organization", display_name: "Example Consortium" },
    ]);
    expect(bibtex.items[2]?.observation?.metadata.title).toBe("Third title");

    const ris = decodeBibliography(
      new TextEncoder().encode(`TY  - JOUR
TI  - First RIS title
AU  - Lovelace, Ada
DO  - 10.1000/ris
AN  - provider-private-record
PY  - 2026
PB  - RIS Press
ER  -

TY  - JOUR
TI  - Missing terminator

TY  - BOOK
TI  - Third RIS title
SN  - 978-1-4028-9462-6
ER  -`),
      "ris",
      options,
    );
    expect(ris.items.map((item) => item.status)).toEqual([
      "decoded",
      "rejected",
      "decoded",
    ]);
    expect(ris.items[0]?.observation?.metadata.identifiers).toEqual([
      { namespace: "doi", value: "10.1000/ris" },
    ]);
    expect(ris.items[2]?.observation?.metadata.identifiers).toEqual([
      { namespace: "isbn", value: "978-1-4028-9462-6" },
    ]);

    const csl = decodeBibliography(
      new TextEncoder().encode(`[
        {"title":"First CSL title","type":"article-journal","DOI":"10.1000/csl",
         "author":[{"given":"Ada","family":"Lovelace","ORCID":"0000-0002-1825-0097",
                    "affiliation":[{"name":"Engine Institute"}]}],
         "issued":{"date-parts":[[2026,8,12]]}},
        {"title":"Duplicate","title":"Rejected"},
        42,
        {"title":"Third CSL title","type":"book"}
      ]`),
      "csl-json",
      options,
    );
    expect(csl.items.map((item) => item.status)).toEqual([
      "decoded",
      "rejected",
      "rejected",
      "decoded",
    ]);
    expect(csl.items[0]?.observation?.metadata).toMatchObject({
      publication_date: "2026-08-12",
      publication_year: 2026,
      authors: [
        {
          kind: "person",
          given_name: "Ada",
          family_name: "Lovelace",
          affiliations: [{ name: "Engine Institute", ror: null }],
        },
      ],
    });
  });

  it("routes each decoded observation through identity and retains partial failures", async () => {
    const result = await importBibliography(
      {
        format: "bibtex",
        items: [
          ...decodeBibliography(
            new TextEncoder().encode(
              "@article{one,title={One},doi={10.1000/one}}",
            ),
            "bibtex",
            options,
          ).items,
          {
            record_index: 1,
            status: "rejected",
            observation: null,
            reason: "malformed-record",
          },
        ],
      },
      {
        async observe(observation) {
          expect(observation.metadata.title).toBe("One");
          return {
            disposition: "accepted",
            created: true,
            literature_id: "literature-one",
            meta_literature_id: "meta-one",
            outcome: "created",
          };
        },
      },
    );
    expect(result.items).toEqual([
      {
        record_index: 0,
        disposition: "created",
        literature_id: "literature-one",
        meta_literature_id: "meta-one",
        reason: null,
      },
      {
        record_index: 1,
        disposition: "rejected",
        literature_id: null,
        meta_literature_id: null,
        reason: "malformed-record",
      },
    ]);
  });

  it("reports every Literature identity outcome without filtering repeated records", async () => {
    const outcomes = ["created", "enriched", "matched", "matched"] as const;
    let index = 0;
    const decoded = decodeBibliography(
      new TextEncoder().encode(
        JSON.stringify(
          outcomes.map((outcome) => ({
            title: outcome,
            DOI: `10.1000/${outcome}-${index++}`,
          })),
        ),
      ),
      "csl-json",
      options,
    );
    index = 0;
    const result = await importBibliography(decoded, {
      async observe() {
        const outcome = outcomes[index]!;
        index += 1;
        return {
          disposition: "accepted",
          literature_id: `literature-${index}`,
          meta_literature_id: `meta-${Math.min(index, 3)}`,
          outcome,
          created: outcome === "created",
        };
      },
    });
    expect(result.items.map((item) => item.disposition)).toEqual(outcomes);
    expect(index).toBe(4);
  });
});
