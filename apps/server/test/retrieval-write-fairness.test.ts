import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  parseLiterature,
  sha256,
} from "@sciretriever/contracts";
import { archiveFixture } from "./archive-fixture.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("admits folder writes during two consecutive archive index updates", async () => {
  const env = await archiveFixture();
  const waits: number[] = [];
  const triggers: (() => void)[] = [];
  // Register continuations outside the rebuild's AsyncLocalStorage scope, just
  // like independent HTTP requests; a nested write would be reentrant.
  const writes = [1, 2].map((n) =>
    new Promise<void>((resolve) => triggers.push(resolve)).then(async () => {
      const started = performance.now();
      await env.app.folders.manage({
        operation: "create",
        request: { name: `During archive ${n}` },
      });
      waits.push(performance.now() - started);
    }),
  );
  let triggered = 0;
  const page = RetrievalStorageClient.prototype.metadataPage;
  let measure = false;
  const observed = vi
    .spyOn(RetrievalStorageClient.prototype, "metadataPage")
    .mockImplementation(async function (
      this: RetrievalStorageClient,
      after,
      limit,
    ) {
      if (measure && after === null) {
        triggers[triggered++]?.();
      }
      return page.call(this, after, limit);
    });
  try {
    // Bulk seed only unrelated synthetic metadata; archive and folder operations
    // below use their real owners and shared write admission.
    const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN; PRAGMA defer_foreign_keys=ON");
      const meta = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
      const lit = db.prepare("INSERT INTO literatures VALUES(?,?,?)");
      const metadata = db.prepare(
        "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      const fts = db.prepare(
        "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,NULL,'','','','',NULL,NULL,NULL,NULL,NULL,'')",
      );
      for (let n = 0; n < 768; n++) {
        const m = {
          ...FIXTURE_LITERATURE.metadata,
          title: `Unrelated synthetic material ${n}`,
          identifiers: [],
        };
        const lid = id(10000 + n),
          mid = id(20000 + n);
        meta.run(mid, lid);
        lit.run(lid, mid, "published");
        metadata.run(
          lid,
          await sha256(canonicalJsonBytes(m)),
          m.title,
          m.abstract,
          m.publication_date,
          m.publication_year,
          m.publication_form,
          m.article_kind,
          m.language,
          m.venue,
          m.publisher,
          m.volume,
          m.issue,
          m.pages,
        );
        fts.run(lid, m.title);
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const second = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: id(3),
      meta_literature_id: id(4),
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        identifiers: [],
        title: "Second synthetic archive",
      },
    });
    await env.app.database.putLiterature(second);
    await env.app.maintenance!.ingestPdf({
      literature_id: second.literature_id,
      bytes: workbenchPdf("10.5555/second-synthetic"),
    });
    const asset = (await env.app.library.detail(second.literature_id))
      .primary_pdf!.asset;
    await env.app.documentProcessing.parseDocuments(env.rawParseRequest);
    await env.app.documentProcessing.parseDocuments({
      ...env.rawParseRequest,
      literature_id: second.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
    });
    measure = true;
    for (const literature_id of [env.id, second.literature_id]) {
      const job = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: `fairness-${literature_id}`,
        operations: [
          {
            operation: "build-archive",
            request: { literature_id, mode: "full", from_step: null },
          },
        ],
      });
      await env.app.processingTasks!.run(job.job_id);
      expect((await env.app.archive.status(literature_id)).status).toBe(
        "READY",
      );
    }
    await Promise.all(writes);
    console.info(
      JSON.stringify({
        fixture: "768 unrelated metadata, two consecutive synthetic archives",
        folder_write_wait_ms: waits.map((n) => Math.round(n)),
        max_wait_ms: Math.round(Math.max(...waits)),
      }),
    );
    expect(waits).toHaveLength(2);
    expect(Math.max(...waits)).toBeLessThan(1000);
  } finally {
    observed.mockRestore();
    for (const trigger of triggers) trigger();
    await Promise.allSettled(writes);
    await env.close();
  }
}, 0);
