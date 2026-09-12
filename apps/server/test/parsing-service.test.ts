import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  parseArtifactRef,
  parseAsset,
  parseProvenance,
  sha256,
  type Sha256,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import {
  type ParserBackend,
  type ParserRequest,
  type StagedParserOutput,
} from "../src/parsing/ports.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const lit = FIXTURE_LITERATURE.literature_id;
const rules = new TypeScriptParserArtifactRules();
function output(
  request: ParserRequest,
  text = "# Synthetic body\n",
  n = 50,
): StagedParserOutput {
  const bytes = Buffer.from(text);
  return {
    source_asset_id: request.source_asset_id,
    source_sha256: request.source_sha256,
    page_count: 1,
    markdown: {
      artifact: parseArtifactRef({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_size: bytes.length,
        media_type: "text/markdown",
      }),
      bytes,
    },
    resources: [],
    provenance: {
      provenance: parseProvenance({
        provenance_id: id(n),
        source_kind: "parser",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: request.source_sha256,
        parameters_sha256: "a".repeat(64),
      }),
      parser_version: "fixture-1",
      mode: null,
      model_identity: null,
    },
  };
}
async function seed(app: Application) {
  await app.database.putLiterature(FIXTURE_LITERATURE);
  const pdf = workbenchPdf();
  const stage = await app.files.stage();
  await stage.write(pdf);
  await app.files.publish(stage, "objects/source.pdf");
  const asset = parseAsset({
    asset_id: id(30),
    sha256: await sha256(pdf),
    size_bytes: pdf.length,
    media_type: "application/pdf",
    path: "objects/source.pdf",
  });
  await app.database.putLiteratureAsset({
    literature_asset_id: id(31),
    literature_id: lit,
    asset,
    role: "primary-pdf",
    source_url: null,
    provenance: {
      provenance_id: id(32),
      source_kind: "asset-provider",
      source_name: "fixture",
      source_record_id: null,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: asset.sha256,
      parameters_sha256: null,
    },
  });
  return asset;
}
it("prepares from verified formal PDF, privately copies output and atomically publishes a reusable immutable parser result", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-parsing-"));
  let captured: ParserRequest | undefined;
  let supplied: StagedParserOutput | undefined;
  let attempt = 50;
  const parser: ParserBackend = {
    parse: async (request) => {
      captured = request;
      await request.withContent(async (chunks) => {
        const hash = createHash("sha256");
        for await (const chunk of chunks) {
          hash.update(chunk);
          chunk.fill(0);
        }
        expect(hash.digest("hex")).toBe(request.source_sha256);
      });
      supplied = output(request, "# Synthetic body\n", attempt++);
      return supplied;
    },
  };
  let app = await createApplication(home, { parsing: { parser, rules } });
  try {
    const asset = await seed(app);
    const prepared = await app.parsing!.prepareCurrentPrimary(lit);
    expect((await app.library.detail(lit)).parser_result).toBeNull();
    await expect(captured!.withContent(async () => true)).rejects.toMatchObject(
      { code: "parser-cancelled" },
    );
    supplied!.markdown.bytes.fill(0);
    const result = await app.parsing!.commitCurrentPrimary(prepared);
    expect(result.source_sha256).toBe(asset.sha256);
    expect((await app.library.detail(lit)).parser_result).toEqual(result);
    await expect(
      app.parsing!.commitCurrentPrimary(prepared),
    ).rejects.toMatchObject({ code: "parser-stale" });
    await expect(
      app.parsing!.commitCurrentPrimary({ result }),
    ).rejects.toMatchObject({ code: "parser-stale" });
    const replay = await app.parsing!.prepareCurrentPrimary(lit);
    expect(replay.result.provenance.provenance.provenance_id).not.toBe(
      result.provenance.provenance.provenance_id,
    );
    await expect(app.parsing!.commitCurrentPrimary(replay)).resolves.toEqual(
      result,
    );
    expect((await app.database.snapshotCounts()).tables.parser_results).toBe(1);
    await app.literatureArtifacts.withArtifact(
      result.markdown,
      async (chunks) => {
        const hash = createHash("sha256");
        for await (const c of chunks) hash.update(c);
        expect(hash.digest("hex")).toBe(result.markdown.sha256);
      },
    );
    const discarded = await app.parsing!.prepareCurrentPrimary(lit);
    app.parsing!.discardPrepared(discarded);
    await expect(
      app.parsing!.commitCurrentPrimary(discarded),
    ).rejects.toMatchObject({ code: "parser-stale" });
    await app.close();
    app = await createApplication(home, { parsing: { parser, rules } });
    expect((await app.library.detail(lit)).parser_result).toEqual(result);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("rejects source mismatch, physical page mismatch, malformed output, failed parsers and cancellation while retaining the accepted result", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-parsing-negative-"));
  let mode = "valid";
  const parser: ParserBackend = {
    parse: async (request, signal) => {
      if (mode === "throw") throw new Error("private parser error");
      if (mode === "cancel") {
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return output(request);
      }
      const value = output(request);
      if (mode === "source")
        return { ...value, source_sha256: "b".repeat(64) as Sha256 };
      if (mode === "pages") return { ...value, page_count: 2 };
      if (mode === "bytes")
        return {
          ...value,
          markdown: { ...value.markdown, bytes: Buffer.from("wrong") },
        };
      return value;
    },
  };
  const app = await createApplication(home, { parsing: { parser, rules } });
  try {
    await seed(app);
    const accepted = await app.parsing!.commitCurrentPrimary(
      await app.parsing!.prepareCurrentPrimary(lit),
    );
    for (const next of ["source", "pages", "bytes", "throw"]) {
      mode = next;
      await expect(
        app.parsing!.prepareCurrentPrimary(lit),
      ).rejects.toMatchObject({
        code: next === "throw" ? "parser-unavailable" : "parser-structure",
      });
      expect((await app.library.detail(lit)).parser_result).toEqual(accepted);
    }
    await expect(
      app.parsing!.prepareCurrentPrimary(lit, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "parser-cancelled" });
    mode = "cancel";
    const abort = new AbortController();
    const pending = app.parsing!.prepareCurrentPrimary(lit, abort.signal);
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "parser-cancelled" });
    mode = "valid";
    const prepared = await app.parsing!.prepareCurrentPrimary(lit);
    await expect(
      app.parsing!.commitCurrentPrimary(prepared, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "parser-cancelled" });
    const file = join(home, "artifacts/objects/source.pdf");
    const original = await readFile(file);
    await writeFile(file, Buffer.alloc(original.length));
    await expect(app.parsing!.prepareCurrentPrimary(lit)).rejects.toMatchObject(
      { code: "parser-unavailable" },
    );
    expect((await app.library.detail(lit)).parser_result).toEqual(accepted);
    expect((await app.database.snapshotCounts()).tables.assets).toBe(1);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("checks current primary inside the commit transaction and preserves previous parser facts on stale, file conflict and provenance collision", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-parsing-cas-"));
  let revision = 0;
  const parser: ParserBackend = {
    parse: async (request) =>
      output(
        request,
        revision ? "# Replacement body\n" : "# Original body\n",
        50,
      ),
  };
  const app = await createApplication(home, { parsing: { parser, rules } });
  let raw: DatabaseSync | undefined;
  try {
    await seed(app);
    const accepted = await app.parsing!.commitCurrentPrimary(
      await app.parsing!.prepareCurrentPrimary(lit),
    );
    revision = 1;
    const stale = await app.parsing!.prepareCurrentPrimary(lit);
    raw = new DatabaseSync(join(home, "catalog.sqlite"));
    raw
      .prepare(
        "UPDATE literature_assets SET role='supplementary-pdf' WHERE literature_asset_id=?",
      )
      .run(id(31));
    await expect(
      app.parsing!.commitCurrentPrimary(stale),
    ).rejects.toMatchObject({ code: "parser-stale" });
    expect(
      raw.prepare("SELECT result_sha256 FROM parser_results").get()!
        .result_sha256,
    ).toBe(accepted.result_sha256);
    raw
      .prepare(
        "UPDATE literature_assets SET role='primary-pdf' WHERE literature_asset_id=?",
      )
      .run(id(31));
    const conflict = await app.parsing!.prepareCurrentPrimary(lit);
    const target = join(
      home,
      "artifacts/objects",
      `${conflict.result.markdown.sha256}.bin`,
    );
    await writeFile(target, "preexisting conflicting evidence");
    await expect(
      app.parsing!.commitCurrentPrimary(conflict),
    ).rejects.toMatchObject({ code: "parser-publication" });
    expect(await readFile(target, "utf8")).toBe(
      "preexisting conflicting evidence",
    );
    expect((await app.library.detail(lit)).parser_result).toEqual(accepted);
    await rm(target);
    const collision = await app.parsing!.prepareCurrentPrimary(lit);
    raw
      .prepare("UPDATE provenances SET source_name=? WHERE provenance_id=?")
      .run("other-fixture", id(50));
    await expect(
      app.parsing!.commitCurrentPrimary(collision),
    ).rejects.toMatchObject({ code: "parser-publication" });
    expect(
      raw.prepare("SELECT result_sha256 FROM parser_results").get()!
        .result_sha256,
    ).toBe(accepted.result_sha256);
    expect(
      raw
        .prepare("SELECT source_name FROM provenances WHERE provenance_id=?")
        .get(id(50))!.source_name,
    ).toBe("other-fixture");
  } finally {
    raw?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("publishes the exact sorted resource closure, reuses registered artifact locations and invalidates preparations on shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-parsing-resources-"));
  const body = "# Images\n![one](assets/😀.txt) ![two](assets/\uffff.txt)\n";
  const resourceBytes = Buffer.from("Synthetic resource\n");
  const resourceArtifact = parseArtifactRef({
    sha256: await sha256(resourceBytes),
    byte_size: resourceBytes.length,
    media_type: "text/plain",
  });
  const parser: ParserBackend = {
    parse: async (request) => ({
      ...output(request, body),
      resources: ["assets/😀.txt", "assets/\uffff.txt"].map((reference) => ({
        reference,
        content: { artifact: resourceArtifact, bytes: resourceBytes },
      })),
    }),
  };
  const app = await createApplication(home, { parsing: { parser, rules } });
  let raw: DatabaseSync | undefined;
  try {
    await seed(app);
    const stage = await app.files.stage();
    await stage.write(resourceBytes);
    await app.files.publish(stage, "objects/existing-resource.txt");
    raw = new DatabaseSync(join(home, "catalog.sqlite"));
    raw
      .prepare(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
      )
      .run(
        id(70),
        resourceArtifact.sha256,
        resourceArtifact.byte_size,
        resourceArtifact.media_type,
        "objects/existing-resource.txt",
      );
    raw
      .prepare(
        "UPDATE literature_metadata SET metadata_revision=10000 WHERE literature_id=?",
      )
      .run(lit);
    expect((await app.library.detail(lit)).metadata_revision).toBe(10000);
    const result = await app.parsing!.commitCurrentPrimary(
      await app.parsing!.prepareCurrentPrimary(lit),
    );
    expect(result.resources.map((r) => r.reference)).toEqual([
      "assets/\uffff.txt",
      "assets/😀.txt",
    ]);
    expect((await app.library.detail(lit)).parser_result).toEqual(result);
    expect(
      raw
        .prepare(
          "SELECT count(*) AS total FROM artifact_objects WHERE sha256=?",
        )
        .get(resourceArtifact.sha256)!.total,
    ).toBe(1);
    expect(
      raw
        .prepare("SELECT artifact_id FROM artifact_objects WHERE sha256=?")
        .get(resourceArtifact.sha256)!.artifact_id,
    ).toBe(id(70));
    for (const r of result.resources)
      await app.literatureArtifacts.withArtifact(r.artifact, async (chunks) => {
        let size = 0;
        for await (const chunk of chunks) size += chunk.length;
        expect(size).toBe(resourceArtifact.byte_size);
      });
    const prepared = await app.parsing!.prepareCurrentPrimary(lit);
    await app.close();
    await expect(
      app.parsing!.commitCurrentPrimary(prepared),
    ).rejects.toMatchObject({ code: "parser-stale" });
    await expect(app.parsing!.prepareCurrentPrimary(lit)).rejects.toMatchObject(
      { code: "parser-cancelled" },
    );
  } finally {
    raw?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
