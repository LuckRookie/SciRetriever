import { expect, it } from "vitest";
import {
  bibliographyAdapter,
  importAdapters,
} from "../src/literature/import-adapters.js";
import { decodeBibliography } from "../src/literature/bibliography-import.js";

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
