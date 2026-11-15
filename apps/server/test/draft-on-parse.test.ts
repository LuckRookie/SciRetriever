import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { DraftPublicationService } from "../src/document/draft-publication.js";
import { DocumentProcessingService } from "../src/document/service.js";
import { ParsingFailure } from "../src/parsing/ports.js";
import { runRawParseStorage } from "../src/storage/sqlite/raw-parsing-engine.js";
import {
  sha256,
  canonicalJsonBytes,
  parseRawParse,
  rawParseIdentity,
} from "@sciretriever/contracts";

const request = (f: Awaited<ReturnType<typeof coreProcessingFixture>>) => ({
  ...f.rawParseRequest,
  profiles: ["vlm-engine"],
  force: false,
});
function counts(f: Awaited<ReturnType<typeof coreProcessingFixture>>) {
  const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    return Object.fromEntries(
      [
        "raw_parses",
        "document_versions",
        "draft_version_facts",
        "draft_current",
      ].map((table) => [
        table,
        Number(db.prepare("SELECT count(*) n FROM " + table).get()!.n),
      ]),
    );
  } finally {
    db.close();
  }
}
it("forms and reuses the known text through the production graph without models or network", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const first = await f.app.documentProcessing.parseDocuments(request(f));
    console.info("Synthetic draft parse receipt: " + JSON.stringify(first));
    expect(first.profiles).toEqual([
      expect.objectContaining({
        profile: "vlm-engine",
        status: "published",
        failure_code: null,
      }),
    ]);
    expect(first.draft).toMatchObject({
      status: "formed",
      default_changed: true,
      default_text_level: "draft",
    });
    if (first.draft.status !== "formed")
      throw new Error("Synthetic initial draft missing");
    const id = first.draft.document_version_id;
    const storage = new SqliteDocumentStorage(f.app.database, f.app.files);
    await storage.withVerifiedDocument(
      id,
      async (document, markdown, structure) => {
        expect(document.schema_version).toBe(3);
        expect(Buffer.from(markdown).toString("utf8")).toContain(
          "A synthetic finding.",
        );
        expect(
          structure.schema_version === 2 &&
            structure.segments.some((s) => s.basis === "text-layer-match"),
        ).toBe(true);
      },
    );
    const second = await f.app.documentProcessing.parseDocuments(request(f));
    expect(second.profiles[0]!.status).toBe("reused");
    expect(second.draft).toEqual({
      ...first.draft,
      status: "reused",
      default_changed: false,
    });
    expect(counts(f)).toEqual({
      raw_parses: 1,
      document_versions: 1,
      draft_version_facts: 1,
      draft_current: 1,
    });
    expect(f.modelCalls).toBe(0);
    expect(f.parseCalls).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

it.each([false, true])(
  "recomputes an archived part after force parsing (draft failure: %s)",
  async (failDraft) => {
    const f = await coreProcessingFixture({ offline: true });
    const unavailable = new DraftPublicationService(
      f.app.database,
      f.app.files,
      f.app.rawParseStorage!,
      null,
      async () => {},
    );
    const service = new DocumentProcessingService(
      f.app.database,
      f.app.rawParsing,
      unavailable,
    );
    try {
      await f.app.documentProcessing.parseDocuments(request(f));
      const proofread = await f.app.proofreading!.build({
        asset_id: f.asset.asset_id,
      });
      const corrected = await f.app.proofreadDocuments.publish({
        literature_id: f.parseRequest.literature_id,
        asset_id: f.asset.asset_id,
        proofread_id: proofread.version.proofread_id,
        expected_default_revision: 1,
      });
      expect(corrected).toMatchObject({
        default_updated: true,
        default_revision: 2,
      });
      const reused = await f.app.documentProcessing.parseDocuments(request(f));
      expect(reused.draft).toMatchObject({
        status: "reused",
        default_changed: false,
        default_text_level: "proofread",
      });
      f.setText("# A replacement source\n\nThe new raw facts.");
      const next = await (
        failDraft ? service : f.app.documentProcessing
      ).parseDocuments({ ...request(f), force: true });
      expect(next.profiles[0]!.status).toBe("published");
      const current = await f.app.documentRead.default({
        literature_id: f.parseRequest.literature_id,
        asset_id: f.asset.asset_id,
        asset_sha256: f.asset.sha256,
      });
      if (failDraft) {
        expect(next.draft).toMatchObject({
          status: "failed",
          failure_code: "page-tools-unavailable",
        });
        expect(current).toMatchObject({
          default: null,
          gap: "document-missing",
        });
      } else {
        expect(next.draft).toMatchObject({
          status: "formed",
          default_text_level: "draft",
          default_changed: true,
        });
        if (next.draft.status !== "formed")
          throw new Error("Replacement draft missing");
        expect(current.default?.document_version_id).toBe(
          next.draft.document_version_id,
        );
      }
      await new SqliteDocumentStorage(
        f.app.database,
        f.app.files,
      ).withVerifiedDocument(
        corrected.document.document_version_id,
        async (_v, bytes) =>
          expect(Buffer.from(bytes).toString()).toContain(
            "A synthetic finding.",
          ),
      );
      expect(f.modelCalls).toBe(0);
    } finally {
      await service.close();
      await unavailable.close();
      await f.close();
    }
  },
  30_000,
);

it("commits the draft after the raw commit scope and retains it when index scheduling fails", async () => {
  const f = await coreProcessingFixture({ offline: true });
  let committing = false;
  const schedule = vi.fn(async () => {
    throw new Error("Synthetic index scheduler unavailable");
  });
  const publisher = new DraftPublicationService(
    f.app.database,
    f.app.files,
    f.app.rawParseStorage!,
    {
      async inspect() {
        expect(committing).toBe(false);
        expect(counts(f).raw_parses).toBe(1);
        return [
          {
            page: 0,
            kind: "text-layer" as const,
            text: "A synthetic finding.",
            visible_glyphs: 20,
            hidden_glyphs: 0,
            unmapped_glyphs: 0,
            has_graphics: false,
          },
        ];
      },
    },
    schedule,
  );
  const service = new DocumentProcessingService(
    f.app.database,
    f.app.rawParsing,
    publisher,
  );
  try {
    const receipt = await service.parseDocuments(
      request(f),
      undefined,
      async (publish) => {
        committing = true;
        try {
          return await publish();
        } finally {
          committing = false;
        }
      },
    );
    expect(receipt.draft).toMatchObject({
      status: "formed",
      default_changed: true,
    });
    expect(schedule).toHaveBeenCalledOnce();
    expect(counts(f).draft_version_facts).toBe(1);
  } finally {
    await service.close();
    await publisher.close();
    await f.close();
  }
}, 30_000);

it("rolls back a raw-current switch if recomputing its default fails in that transaction", async () => {
  const f = await coreProcessingFixture({ offline: true });
  const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
  try {
    await f.app.documentProcessing.parseDocuments(request(f));
    const oldRaw = (await f.app.rawParseStorage!.current(f.asset.asset_id))[0]!
      .result!;
    f.setText("# A new source\n\nA different synthetic result.");
    const next = await f.app.documentProcessing.parseDocuments({
      ...request(f),
      force: true,
    });
    expect(next.draft.status).toBe("formed");
    await f.app.close();
    // Fault injection is at the transaction owner. A live worker correctly
    // rejects this extra test trigger as a noncanonical catalog layout.
    db.exec("PRAGMA foreign_keys=ON");
    const prior = db.prepare("SELECT * FROM document_defaults").get();
    const manifest = db
      .prepare("SELECT * FROM raw_parses WHERE raw_parse_id=?")
      .get(oldRaw.raw_parse_id)!;
    db.exec(
      "CREATE TRIGGER synthetic_default_refusal BEFORE DELETE ON document_defaults BEGIN SELECT RAISE(ABORT,'synthetic-default-refusal'); END",
    );
    expect(() =>
      runRawParseStorage(db, "publish", {
        result: oldRaw,
        manifest: {
          reference: manifest.manifest_reference,
          sha256: manifest.manifest_sha256,
          byte_size: manifest.manifest_size,
          media_type: manifest.manifest_media_type,
        },
        resources: [], // An existing immutable raw version needs no new registration.
      }),
    ).toThrow("synthetic-default-refusal");
    expect(db.prepare("SELECT * FROM document_defaults").get()).toEqual(prior);
    expect(
      db
        .prepare(
          "SELECT raw_parse_id FROM raw_parse_current WHERE profile='vlm-engine'",
        )
        .get()!.raw_parse_id,
    ).toBe(next.profiles[0]!.raw_parse_id);
    expect(counts(f)).toEqual({
      raw_parses: 2,
      document_versions: 2,
      draft_version_facts: 2,
      draft_current: 1,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS synthetic_default_refusal");
    db.close();
    await f.close();
  }
}, 30_000);

it("waits for cancelled page inspection on close and leaves no partial draft records", async () => {
  const f = await coreProcessingFixture({ offline: true });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const cleanup = new Promise<void>((r) => {
    release = r;
  });
  const publisher = new DraftPublicationService(
    f.app.database,
    f.app.files,
    f.app.rawParseStorage!,
    {
      async inspect(_id, _hash, signal) {
        entered();
        await new Promise<void>((r) =>
          signal!.addEventListener("abort", () => r(), { once: true }),
        );
        await cleanup;
        signal!.throwIfAborted();
        return [];
      },
    },
    async () => {},
  );
  const service = new DocumentProcessingService(
    f.app.database,
    f.app.rawParsing,
    publisher,
  );
  try {
    const parsing = service.parseDocuments(request(f));
    await started;
    let closed = false;
    const closing = publisher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect((await parsing).draft).toMatchObject({
      status: "failed",
      failure_code: "cancelled",
    });
    await closing;
    expect(counts(f)).toEqual({
      raw_parses: 1,
      document_versions: 0,
      draft_version_facts: 0,
      draft_current: 0,
    });
    const raw = (await f.app.rawParseStorage!.current(f.asset.asset_id))[0]!
      .result!;
    expect(
      await publisher.publish({
        literature_id: f.parseRequest.literature_id,
        asset_id: f.asset.asset_id,
        asset_sha256: f.asset.sha256,
        raw,
      }),
    ).toMatchObject({ status: "failed", failure_code: "cancelled" });
  } finally {
    release();
    await service.close();
    await publisher.close();
    await f.close();
  }
}, 30_000);

it("reports draft-too-large for a successful raw parse without changing the PDF", async () => {
  const identity = {
    parser_version: "fixture-size-1",
    model_identity: "fixture-size",
    parameters_sha256: await sha256(Buffer.from("synthetic-size-parameters")),
  };
  const f = await coreProcessingFixture({
    offline: true,
    textLayer: () => "",
    rawParser: {
      async identity() {
        return identity;
      },
      async parseRaw(input, profile) {
        // Raw Markdown is small; valid blocks can still render over the 8 MiB
        // draft limit. This is a fake parser, not an injected builder ceiling.
        const large = "a".repeat(3 * 1024 * 1024);
        const artifact = async (bytes: Uint8Array, media_type: string) => ({
          bytes,
          artifact: {
            sha256: await sha256(bytes),
            byte_size: bytes.length,
            media_type,
          },
        });
        const blocks = await artifact(
          canonicalJsonBytes({
            schema_version: 1,
            page_count: 1,
            blocks: Array.from({ length: 3 }, (_, index) => ({
              page: 0,
              index,
              type: "text",
              title_level: null,
              text: large,
              html: null,
              image_ref: null,
              bbox: [0, 0, 1000, 1000],
              source_type: "fixture",
            })),
          }),
          "application/json",
        );
        const markdown = await artifact(
          Buffer.from("An accepted synthetic raw markdown."),
          "text/markdown",
        );
        const private_content_list = await artifact(
          Buffer.from("[]"),
          "application/json",
        );
        const raw = {
          ...identity,
          source_asset_id: input.source_asset_id,
          source_sha256: input.source_sha256,
          profile,
          page_count: 1,
          page_sizes: [[595, 842] as const],
          blocks: blocks.artifact,
          markdown: markdown.artifact,
          private_content_list: private_content_list.artifact,
          resources: [],
        };
        return {
          result: await parseRawParse({
            ...raw,
            ...(await rawParseIdentity(raw)),
          }),
          blocks,
          markdown,
          private_content_list,
          resources: [],
        };
      },
    },
  });
  try {
    const receipt = await f.app.documentProcessing.parseDocuments(request(f));
    expect(receipt.profiles[0]!.status).toBe("published");
    expect(receipt.draft).toMatchObject({
      status: "failed",
      failure_code: "draft-too-large",
    });
    expect(counts(f).document_versions).toBe(0);
    expect(
      await sha256(await readFile(join(f.app.files.root, f.asset.path))),
    ).toBe(f.asset.sha256);
    expect(f.modelCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 90_000);

it("forces a new raw parse and draft, changes the default, and keeps the old fixed evidence readable", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const first = await f.app.documentProcessing.parseDocuments(request(f));
    if (first.draft.status !== "formed")
      throw new Error("Initial draft missing");
    f.setText("# A changed synthetic source\n\nA newly parsed result.");
    const second = await f.app.documentProcessing.parseDocuments({
      ...request(f),
      force: true,
    });
    expect(second.draft).toMatchObject({
      status: "formed",
      default_changed: true,
      default_text_level: "draft",
    });
    if (second.draft.status !== "formed") throw new Error("New draft missing");
    expect(second.draft.raw_parse_id).not.toBe(first.draft.raw_parse_id);
    expect(second.draft.document_version_id).not.toBe(
      first.draft.document_version_id,
    );
    expect(
      (await f.app.database.documentDefault(
        f.parseRequest.literature_id,
        f.asset.asset_id,
        f.asset.sha256,
      ))!.document_version_id,
    ).toBe(second.draft.document_version_id);
    const storage = new SqliteDocumentStorage(f.app.database, f.app.files);
    await storage.withVerifiedDocument(
      first.draft.document_version_id,
      async (_v, bytes) => {
        expect(Buffer.from(bytes).toString()).toContain("A synthetic finding.");
      },
    );
    expect(f.modelCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

it("does not use another profile or a previously successful raw parse when the deployment profile fails", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const other = await f.app.documentProcessing.parseDocuments({
      ...request(f),
      profiles: ["pipeline"],
    });
    expect(other.draft).toEqual({
      status: "not-formed",
      reason: "profile-not-requested",
    });
    expect(counts(f).document_versions).toBe(0);
    const initial = await f.app.documentProcessing.parseDocuments(request(f));
    expect(initial.draft.status).toBe("formed");
    f.setParseHook(async () => {
      throw new ParsingFailure("parser-unavailable");
    });
    const publish = vi.spyOn(f.app.draftDocuments, "publish");
    const failed = await f.app.documentProcessing.parseDocuments({
      ...request(f),
      force: true,
    });
    expect(failed.profiles[0]!.status).toBe("failed");
    expect(failed.draft).toEqual({
      status: "not-formed",
      reason: "raw-parse-failed",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(counts(f).document_versions).toBe(1);
    expect(f.modelCalls).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);

it.each(["page-tools-unavailable", "cancelled"] as const)(
  "keeps the published raw result and PDF when the draft ends with %s",
  async (failure) => {
    const f = await coreProcessingFixture({ offline: true });
    const stop = new AbortController();
    const publisher = new DraftPublicationService(
      f.app.database,
      f.app.files,
      f.app.rawParseStorage!,
      failure === "page-tools-unavailable"
        ? null
        : {
            async inspect() {
              stop.abort();
              throw new Error("Synthetic cancellation");
            },
          },
      async () => {},
    );
    const service = new DocumentProcessingService(
      f.app.database,
      f.app.rawParsing,
      publisher,
    );
    try {
      const parsed = await service.parseDocuments(request(f), stop.signal);
      expect(parsed.profiles[0]!.status).toBe("published");
      expect(parsed.draft).toEqual({
        status: "failed",
        raw_parse_id: parsed.profiles[0]!.raw_parse_id,
        failure_code: failure,
      });
      expect(counts(f)).toEqual({
        raw_parses: 1,
        document_versions: 0,
        draft_version_facts: 0,
        draft_current: 0,
      });
      expect(
        await sha256(await readFile(join(f.app.files.root, f.asset.path))),
      ).toBe(f.asset.sha256);
      expect(f.modelCalls).toBe(0);
    } finally {
      await service.close();
      await publisher.close();
      await f.close();
    }
  },
  30_000,
);

it("reports source-integrity after post-commit raw tampering and never overwrites the accepted PDF", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const raw = f.app.rawParseStorage!;
    const original = raw.publish.bind(raw);
    vi.spyOn(raw, "publish").mockImplementation(async (...args) => {
      const result = await original(...args);
      const located = (await f.app.database.locateArtifact(
        result.result.markdown,
      ))!;
      await writeFile(
        join(f.app.files.root, located.reference),
        Buffer.alloc(result.result.markdown.byte_size, 120),
      );
      return result;
    });
    const parsed = await f.app.documentProcessing.parseDocuments(request(f));
    expect(parsed.profiles[0]!.status).toBe("published");
    expect(parsed.draft).toMatchObject({
      status: "failed",
      failure_code: "source-integrity",
    });
    expect(counts(f).document_versions).toBe(0);
    expect(
      await sha256(await readFile(join(f.app.files.root, f.asset.path))),
    ).toBe(f.asset.sha256);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);
