// Synthetic file openings only; no real export is used.
import { expect, it } from "vitest";
import { detectBibliographyFormat } from "../src/index.js";

const BIBTEX = `% Encoding: UTF-8

@article{lin2024,
  title = {Synthetic tetrazole salt A},
  journal = {Synthetic Journal},
  year = {2024}
}`;
const BIBLATEX = `@online{lin2024,
  title = {Synthetic tetrazole salt A},
  date = {2024-03},
}`;
const CSL = `[{"id":"a","type":"article-journal","title":"Synthetic tetrazole salt A"}]`;

it("tells BibTeX from BibLaTeX in a .bib file by its content", () => {
  expect(detectBibliographyFormat("library.bib", BIBTEX)).toBe("bibtex");
  expect(detectBibliographyFormat("library.bib", BIBLATEX)).toBe("biblatex");
  expect(
    detectBibliographyFormat(
      "library.bib",
      "@article{x, journaltitle = {Synthetic}}",
    ),
  ).toBe("biblatex");
  // An explicit extension still names its format.
  expect(detectBibliographyFormat("library.biblatex", BIBTEX)).toBe("biblatex");
});

it("recognizes BibTeX and CSL JSON content without a known extension", () => {
  expect(detectBibliographyFormat(null, BIBTEX)).toBe("bibtex");
  expect(detectBibliographyFormat("export.txt", BIBLATEX)).toBe("biblatex");
  expect(detectBibliographyFormat("download", CSL)).toBe("csl-json");
  expect(
    detectBibliographyFormat(
      null,
      '{"type": "book", "title": "Synthetic handbook"}',
    ),
  ).toBe("csl-json");
  // `@` later in a note, or JSON without a CSL field, is not recognized.
  expect(detectBibliographyFormat("notes.txt", "Mail me @home{x}")).toBeNull();
  expect(
    detectBibliographyFormat(null, '{"name": "x", "value": 1}'),
  ).toBeNull();
});

it("leaves a .json that is not CSL JSON to the user", () => {
  expect(detectBibliographyFormat("library.json", CSL)).toBe("csl-json");
  expect(
    detectBibliographyFormat("settings.json", '{"theme": "dark"}'),
  ).toBeNull();
  expect(detectBibliographyFormat("data.json", "[1, 2, 3]")).toBeNull();
  expect(detectBibliographyFormat("broken.json", "not json")).toBeNull();
});
