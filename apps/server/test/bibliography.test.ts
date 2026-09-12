import { expect, it } from "vitest";
import { exportBibliography } from "../src/literature/bibliography.js";
import { setup } from "./content-fixture.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

it("exports current neutral metadata as deterministic BibTeX, BibLaTeX, RIS and CSL-JSON", async () => {
  const env = await setup();
  try {
    const detail = await env.app.library.detail(
      FIXTURE_LITERATURE.literature_id,
    );
    const bibtex = new TextDecoder().decode(
      exportBibliography(detail, "bibtex"),
    );
    expect(bibtex).toContain("@article{");
    expect(bibtex).toContain("title = {Synthetic literature workbench}");
    expect(bibtex).toContain("doi = {10.5555/sciretriever.fixture}");
    const ris = new TextDecoder().decode(exportBibliography(detail, "ris"));
    expect(ris).toContain("TY  - JOUR\r\n");
    expect(ris).toContain("TI  - Synthetic literature workbench\r\n");
    expect(ris).toContain("DO  - 10.5555/sciretriever.fixture\r\n");
    expect(ris).toContain(`ID  - ${FIXTURE_LITERATURE.literature_id}\r\n`);
    const biblatex = new TextDecoder().decode(
      exportBibliography(detail, "biblatex"),
    );
    expect(biblatex).toContain("@article{");
    expect(biblatex).toContain("doi = {10.5555/sciretriever.fixture}");
    const csl = JSON.parse(
      new TextDecoder().decode(exportBibliography(detail, "csl-json")),
    ) as Record<string, unknown>;
    expect(csl).toMatchObject({
      id: FIXTURE_LITERATURE.literature_id,
      title: "Synthetic literature workbench",
      DOI: "10.5555/sciretriever.fixture",
      issued: { "date-parts": [[2026]] },
    });
  } finally {
    await env.close();
  }
});
