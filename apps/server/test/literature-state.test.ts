import { expect, it } from "vitest";
import { archiveFixture } from "./archive-fixture.js";
// Reached 2.1 s under Full (36/12) load, too close to the 5 s default.
it("requires a completed archive after parsing and preserves accepted material when metadata editing fails", async () => {
  const e = await archiveFixture();
  try {
    const original = (await e.app.library.detail(e.id)).primary_pdf;
    expect((await e.app.archive.status(e.id)).missing_step).toBe("raw-parse");
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    expect((await e.app.archive.status(e.id)).missing_step).toBe("proofread");
    expect((await e.app.library.detail(e.id)).literature.status).not.toBe(
      "READY",
    );
    await e.submit("archive-ready");
    const before = await e.app.library.detail(e.id);
    expect(before.literature.status).toBe("READY");
    expect(before).not.toHaveProperty("content");
    await expect(
      e.app.metadataFields.edit({
        literature_id: e.id,
        expected_revision: before.metadata_revision + 1,
        set: [{ field: "title", value: "Stale edit" }],
        unlock: [],
      }),
    ).rejects.toThrow();
    expect(await e.app.library.detail(e.id)).toEqual(before);
    expect(before.primary_pdf).toEqual(original);
  } finally {
    await e.close();
  }
}, 30_000);
