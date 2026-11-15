import { expect, it } from "vitest";
import { parseImportData } from "@sciretriever/contracts";
import {
  bibliographyAdapter,
  importAdapters,
} from "../src/literature/import-adapters.js";
import { decodeBibliography } from "../src/literature/bibliography-import.js";

it.each(["bibtex", "biblatex", "ris", "csl-json"] as const)(
  "requires original %s text and rejects the retired predecoded object shape",
  (format) => {
    expect(() =>
      bibliographyAdapter(format).decode({ legacy_decoded: [] }, 0),
    ).toThrow();
  },
);

it.each([
  {
    format: "bibtex" as const,
    key: "citation-key",
    source:
      "@article{citation-key,title={Synthetic title},doi={10.5555/adapter}}",
  },
  {
    format: "biblatex" as const,
    key: "citation-key",
    source:
      "@article{citation-key,title={Synthetic title},doi={10.5555/adapter}}",
  },
  {
    format: "ris" as const,
    key: "ris-local-id",
    source:
      "TY  - JOUR\nID  - ris-local-id\nTI  - Synthetic title\nDO  - 10.5555/adapter\nER  -\n",
  },
  {
    format: "csl-json" as const,
    key: "0",
    source:
      '[{"id":0,"type":"article-journal","title":"Synthetic title","DOI":"10.5555/adapter"}]',
  },
])(
  "converts $format deterministically with the existing codec and a separate source-local key",
  ({ format, key, source }) => {
    const adapter = bibliographyAdapter(format),
      first = adapter.decode(source, 7),
      second = adapter.decode(source, 7);
    expect(first).toEqual(second);
    expect(first.items[0]!.record!.external_id).toBe(key);
    const original = decodeBibliography(Buffer.from(source), format).items[0]!
      .observation!;
    expect(first.items[0]!.record!.metadata).toEqual(original.metadata);
    expect(first.items[0]!.record!.metadata.identifiers).toEqual([
      { namespace: "doi", value: "10.5555/adapter" },
    ]);
  },
);

it("preserves per-record rejection and stable fallback keys without installing a second format registry", () => {
  const source =
    '[{"title":"No source ID"},"invalid",{"id":"third","title":"Third"}]';
  const result = importAdapters().get("csl-json")!.decode(source, 3);
  expect(result.items.map((i) => i.record?.external_id ?? null)).toEqual([
    "3:0",
    null,
    "third",
  ]);
  expect(result.items[1]!.reason).toBe(
    decodeBibliography(Buffer.from(source), "csl-json").items[1]!.reason,
  );
  expect(result.groups).toEqual([]);
  expect(result.excluded).toEqual([]);
});

it.each(["bibtex", "biblatex"] as const)(
  "reads Zotero %s attachments, selects the first PDF and counts the rest",
  (format) => {
    const source = String.raw`@article{one,
      title = {Attachments},
      file = {Snapshot:files/123/page.html:text/html;Full Text PDF:files/123/Smith 2020.pdf:application/pdf;Another PDF:files/123/other.PDF:PDF}
    }`;
    const adapter = bibliographyAdapter(format),
      result = adapter.decode(source, 0),
      record = result.items[0]!.record!;
    expect(record.files).toEqual([
      {
        external_id: "files/123/Smith 2020.pdf",
        file_name: "Smith 2020.pdf",
        media_type: "application/pdf",
        preferred: true,
        size_bytes: null,
        sha256: null,
      },
    ]);
    expect(result.excluded).toEqual([
      { kind: "non-pdf-file", count: 1 },
      { kind: "additional-file", count: 1 },
    ]);
    expect(parseImportData({ records: [record] }).records[0]).toEqual(record);
    expect(adapter.decode(source, 0)).toEqual(result);
  },
);

it.each([
  { field: ":Smith2020.pdf:PDF", name: "Smith2020.pdf", id: "Smith2020.pdf" },
  { field: ":/Users/x/Documents/a.pdf:pdf", name: "a.pdf" },
  {
    field: String.raw`Full Text PDF:C\:\\Users\\Example\\a.pdf:application/pdf`,
    name: "a.pdf",
  },
  {
    field: String.raw`:C:\\Users\\Example\\a.pdf:PDF`,
    name: "a.pdf",
  },
  {
    field: String.raw`:\\\\server\\share\\a.pdf:PDF`,
    name: "a.pdf",
  },
  {
    field: String.raw`Full\: Text:files\\123\\A\; B\:C.pdf:application/pdf`,
    name: "A; B:C.pdf",
    id: "files/123/A; B:C.pdf",
  },
  {
    field: "Full Text PDF:files/123/byte-data:application/pdf",
    name: "byte-data",
    id: "files/123/byte-data",
  },
  {
    field: "Mismatch:files/123/a.PDF:text/html",
    name: "a.PDF",
    id: "files/123/a.PDF",
  },
])(
  "handles escaped BibTeX and JabRef/Mendeley files: $field",
  ({ field, name, id }) => {
    for (const format of ["bibtex", "biblatex"] as const) {
      const result = bibliographyAdapter(format).decode(
        `@article{one,title={Attached paper},file={${field}}}`,
        7,
      );
      expect(result.items[0]!.record!.files).toEqual([
        {
          external_id: id ?? `local-file:7:0:0:${name}`,
          file_name: name,
          media_type: "application/pdf",
          preferred: true,
          size_bytes: null,
          sha256: null,
        },
      ]);
      expect(result.excluded).toEqual([]);
    }
  },
);

it("uses each RIS L1 as a path and hides EndNote and absolute directories", () => {
  const source = [
    "TY  - JOUR",
    "ID  - endnote-paper",
    "TI  - EndNote attachment",
    "L1  - internal-pdf://123-private/EndNote%20Paper.pdf",
    "L1  - files/123/another.pdf",
    "L1  - files/123/note.txt",
    "ER  -",
    "TY  - JOUR",
    "TI  - Zotero attachment",
    "L1  - ../private/invalid.pdf",
    "L1  - files/456/a.pdf",
    "ER  -",
    "TY  - JOUR",
    "TI  - Windows attachment",
    String.raw`L1  - C:\Users\Example\EndNote Paper.pdf`,
    "ER  -",
    "TY  - JOUR",
    "TI  - File URI attachment",
    "L1  - file:///Users/Example/EndNote%20Paper.pdf",
    "ER  -",
  ].join("\n");
  const result = bibliographyAdapter("ris").decode(source, 2);
  expect(
    result.items.map((item) => item.record!.files[0]!.external_id),
  ).toEqual([
    "local-file:2:0:0:EndNote Paper.pdf",
    "files/456/a.pdf",
    "local-file:2:2:0:EndNote Paper.pdf",
    "local-file:2:3:0:EndNote Paper.pdf",
  ]);
  expect(result.items[0]!.record!.external_id).toBe("endnote-paper");
  expect(result.excluded).toEqual([
    { kind: "additional-file", count: 1 },
    { kind: "non-pdf-file", count: 1 },
    { kind: "invalid-file-reference", count: 1 },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/Users|Example|123-private/u);
  expect(
    parseImportData({ records: result.items.map((i) => i.record) }).records,
  ).toHaveLength(4);
});

it.each([
  "../private/escape.pdf",
  "files/../escape.pdf",
  "./escape.pdf",
  "internal-pdf://private/%2e%2e/escape.pdf",
  "internal-pdf://private/escape.pdf?credential=synthetic",
  "internal-pdf://private/escape.pdf%3fcredential=synthetic",
  "internal-pdf://private/%zz.pdf",
  "https://example.invalid/escape.pdf",
  "files/bad\u0000name.pdf",
  "files/bad\tname.pdf",
  "x".repeat(1025) + ".pdf",
  "files/",
])("counts an invalid attachment without losing the record: %j", (path) => {
  const result = bibliographyAdapter("bibtex").decode(
    `@article{one,title={Good metadata},file={Bad:${path}:application/pdf;Good:files/good.pdf:PDF}}`,
    0,
  );
  expect(result.items[0]!.reason).toBeNull();
  expect(result.items[0]!.record!.metadata.title).toBe("Good metadata");
  expect(result.items[0]!.record!.files[0]!.external_id).toBe("files/good.pdf");
  expect(result.excluded).toEqual([
    { kind: "invalid-file-reference", count: 1 },
  ]);
});

it("does not interpret nonstandard CSL JSON file or attachment fields", () => {
  const result = bibliographyAdapter("csl-json").decode(
    JSON.stringify({
      id: "one",
      title: "No standard attachment",
      file: "files/a.pdf",
      attachments: [{ path: "/Users/Example/a.pdf" }],
    }),
    0,
  );
  expect(result.items[0]!.record!.files).toEqual([]);
  expect(result.excluded).toEqual([]);
});
