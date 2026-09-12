import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseLiterature,
  parseLiteratureId,
  parseMetaLiteratureId,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { prepareBibliographyExport } from "../src/entry/bibliography-export.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (value: number) =>
  `00000000-0000-4000-9000-${String(value).padStart(12, "0")}`;

it("encodes one frozen selection, chooses representatives for work scopes and preserves explicit Literature order", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-bibliography-export-"),
  );
  const app = await createApplication(home);
  const meta = parseMetaLiteratureId(id(101));
  const otherMeta = parseMetaLiteratureId(id(102));
  const preprint = parseLiteratureId(id(1));
  const published = parseLiteratureId(id(2));
  const other = parseLiteratureId(id(3));
  try {
    for (const [literatureId, metaId, role, title, year] of [
      [preprint, meta, "preprint", "Work preprint", 2026],
      [published, meta, "published", "Work published", 2026],
      [other, otherMeta, "published", "Other work", 2025],
    ] as const)
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: literatureId,
          meta_literature_id: metaId,
          version_role: role,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title,
            publication_year: year,
            identifiers: [
              { namespace: "doi", value: `10.1000/export.${literatureId}` },
            ],
          },
        }),
      );

    let reads = 0;
    const library = {
      search: async (request: unknown) => {
        reads += 1;
        return app.library.search(request);
      },
    };
    const byWork = await prepareBibliographyExport(
      library,
      {
        kind: "meta-literatures",
        meta_literature_ids: [meta, otherMeta],
      },
      "csl-json",
    );
    expect(reads).toBe(1);
    expect(byWork.selected_literature_ids).toEqual([published, other]);
    expect(
      (
        JSON.parse(new TextDecoder().decode(byWork.bytes)) as { id: string }[]
      ).map((record) => record.id),
    ).toEqual([published, other]);

    const explicit = await prepareBibliographyExport(
      library,
      { kind: "literatures", literature_ids: [preprint, published] },
      "ris",
    );
    expect(reads).toBe(2);
    expect(explicit.selected_literature_ids).toEqual([preprint, published]);
    const ris = new TextDecoder().decode(explicit.bytes);
    expect(ris.indexOf(`ID  - ${preprint}`)).toBeLessThan(
      ris.indexOf(`ID  - ${published}`),
    );
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
