import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  parseLiterature,
  parseReference,
  analysisInputSha256,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { LiteratureContentService } from "../src/literature/content.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { id, lit, setup, proposal } from "./content-fixture.js";
it("atomically accepts final metadata, content and FTS with frozen revision, canonical bytes and lineage", async () => {
  const env = await setup();
  let restarted: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const { app, home } = env;
    const before = await app.library.detail(lit);
    const p = await proposal(before);
    const result = await app.literatureContent.accept(p.value, p.bytes);
    expect(result.literature_content_sha256).toBe(
      p.value.literature_content_sha256,
    );
    const detail = await app.library.detail(lit);
    expect(detail.content).toEqual(result);
    expect(detail.metadata_revision).toBe(2);
    expect(detail.literature.metadata.keywords).toEqual(["spectroscopy"]);
    expect(detail.literature.status).toBe("CONTENT_READY");
    expect(detail.primary_pdf).toEqual(before.primary_pdf);
    expect(detail.parser_result).toEqual(before.parser_result);
    expect(
      (
        await app.library.search({ query: { text: "spectroscopy" }, limit: 10 })
      ).items.map((r) => r.literature.literature_id),
    ).toEqual([lit]);
    await expect(
      app.literatureContent.accept(p.value, p.bytes),
    ).rejects.toMatchObject({ code: "content-stale" });
    await app.close();
    restarted = await createApplication(home);
    expect((await restarted.library.detail(lit)).content).toEqual(result);
  } finally {
    await restarted?.close();
    await env.close();
  }
});
it("rolls back metadata, keywords, content and FTS on transaction failure, and rejects corrupt, stale or cancelled inputs", async () => {
  const env = await setup();
  let raw: DatabaseSync | undefined;
  try {
    const { app, home } = env;
    const first = await proposal(await app.library.detail(lit));
    await app.literatureContent.accept(first.value, first.bytes);
    const before = await app.library.detail(lit);
    const next = await proposal(before, 41, "Replacement magnetism", [
      "magnetism",
    ]);
    raw = new DatabaseSync(join(home, "catalog.sqlite"));
    raw.exec(
      "CREATE TRIGGER fixture_abort_content BEFORE INSERT ON literature_contents BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await expect(
      app.literatureContent.accept(next.value, next.bytes),
    ).rejects.toMatchObject({ code: "content-publication" });
    expect(await app.library.detail(lit)).toEqual(before);
    expect(
      (await app.library.search({ query: { text: "magnetism" }, limit: 10 }))
        .items,
    ).toEqual([]);
    raw.exec("DROP TRIGGER fixture_abort_content");
    await expect(
      app.literatureContent.accept(next.value, Buffer.from("corrupt")),
    ).rejects.toMatchObject({ code: "content-structure" });
    await expect(
      app.literatureContent.accept(
        { ...next.value, metadata_sha256: "0".repeat(64) },
        next.bytes,
      ),
    ).rejects.toMatchObject({ code: "content-structure" });
    await expect(
      app.literatureContent.accept(next.value, next.bytes, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "content-cancelled" });
    const target = join(
      home,
      "artifacts/objects",
      `${next.value.markdown.sha256}.bin`,
    );
    const original = await readFile(target);
    await writeFile(target, "conflicting bytes");
    await expect(
      app.literatureContent.accept(next.value, next.bytes),
    ).rejects.toMatchObject({ code: "content-publication" });
    expect(await readFile(target, "utf8")).toBe("conflicting bytes");
    await writeFile(target, original);
    const racing = new LiteratureContentService(
      app.library,
      {
        locateArtifact: (a) => app.database.locateArtifact(a),
        acceptLiteratureContent: async (command) => {
          raw!
            .prepare(
              "UPDATE literature_assets SET role='supplementary-pdf' WHERE literature_asset_id=?",
            )
            .run(id(31));
          return app.database.acceptLiteratureContent(command);
        },
      },
      app.files,
    );
    await expect(racing.accept(next.value, next.bytes)).rejects.toMatchObject({
      code: "content-stale",
    });
    raw
      .prepare(
        "UPDATE literature_assets SET role='primary-pdf' WHERE literature_asset_id=?",
      )
      .run(id(31));
    expect(await app.library.detail(lit)).toEqual(before);
    const results = await Promise.allSettled([
      app.literatureContent.accept(next.value, next.bytes),
      app.literatureContent.accept(next.value, next.bytes),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await app.library.detail(lit)).metadata_revision).toBe(3);
  } finally {
    raw?.close();
    await env.close();
  }
});
it("preserves reference supports for the same manifest and removes only replaced content support while keeping other evidence", async () => {
  const env = await setup();
  try {
    const { app } = env;
    const p = await proposal(await app.library.detail(lit));
    const accepted = await app.literatureContent.accept(p.value, p.bytes);
    for (const n of [3, 4])
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            identifiers: [{ namespace: "doi", value: `10.5555/ref.${n}` }],
            title: `Target ${n}`,
          },
        }),
      );
    for (const n of [3, 4]) {
      await app.references.publish(
        parseReference({
          reference_id: id(100 + n),
          source_literature_id: lit,
          target_literature_id: id(n),
        }),
      );
      await app.references.supportWithContentReferenceText(
        id(100 + n),
        accepted.literature_content_sha256,
        0,
      );
    }
    await app.observations.publish({
      observation_id: id(80),
      literature_id: lit,
      provenance: {
        provenance_id: id(81),
        source_kind: "metadata-provider",
        source_name: "fixture",
        source_record_id: "source-record",
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: "a".repeat(64),
        parameters_sha256: null,
      },
      version_role: "published",
      metadata: FIXTURE_LITERATURE.metadata,
      declared_keywords: [],
      reference_texts: ["Source evidence"],
      reference_count: null,
      cited_by_count: null,
    });
    await app.references.supportWithMetadataReferenceText(id(104), id(80), 0);
    const same = await proposal(await app.library.detail(lit), 42);
    await app.literatureContent.accept(same.value, same.bytes);
    expect(
      (
        await app.library.references({
          literature_id: lit,
          direction: "references",
        })
      ).items,
    ).toHaveLength(2);
    const changed = await proposal(
      await app.library.detail(lit),
      43,
      "Different content",
      ["different"],
    );
    await app.literatureContent.accept(changed.value, changed.bytes);
    const remaining = await app.library.references({
      literature_id: lit,
      direction: "references",
    });
    expect(remaining.items).toHaveLength(1);
    expect(
      remaining.items[0]!.related_literature.literature.literature_id,
    ).toBe(id(4));
  } finally {
    await env.close();
  }
});
it("rejects misbound proposals and protects the immutable input snapshot during asynchronous acceptance", async () => {
  const env = await setup();
  try {
    const { app } = env;
    const before = await app.library.detail(lit);
    const p = await proposal(before);
    for (const value of [
      { ...p.value, metadata_revision: 20 },
      {
        ...p.value,
        final_metadata: { ...p.value.final_metadata, title: "wrong title" },
      },
      {
        ...p.value,
        provenance: { ...p.value.provenance, input_sha256: "0".repeat(64) },
      },
      {
        ...p.value,
        markdown: {
          ...p.value.markdown,
          byte_size: p.value.markdown.byte_size + 1,
        },
      },
    ])
      await expect(
        app.literatureContent.accept(value, p.bytes),
      ).rejects.toMatchObject({ code: "content-structure" });
    await expect(
      app.literatureContent.accept(
        { ...p.value, primary_asset_id: id(999) },
        p.bytes,
      ),
    ).rejects.toMatchObject({ code: "content-stale" });
    const otherHash = await sha256(Buffer.from("another parser result"));
    await expect(
      app.literatureContent.accept(
        {
          ...p.value,
          parser_result_sha256: otherHash,
          provenance: {
            ...p.value.provenance,
            input_sha256: await analysisInputSha256(
              p.value.primary_pdf_sha256,
              otherHash,
              p.value.metadata_sha256,
            ),
          },
        },
        p.bytes,
      ),
    ).rejects.toMatchObject({ code: "content-stale" });
    expect(await app.library.detail(lit)).toEqual(before);
    const mutable = structuredClone(p.value);
    const bytes = Uint8Array.from(p.bytes);
    const pending = app.literatureContent.accept(mutable, bytes);
    bytes.fill(0);
    Reflect.set(mutable, "input_metadata_revision", 999);
    Reflect.set(mutable.final_metadata, "title", "mutated after call");
    const accepted = await pending;
    expect((await app.library.detail(lit)).content).toEqual(accepted);
    expect((await app.library.detail(lit)).literature.metadata.title).toBe(
      before.literature.metadata.title,
    );
  } finally {
    await env.close();
  }
});
