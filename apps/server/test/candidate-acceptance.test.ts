import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseAsset, parseLiterature } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { CandidateAcceptanceService } from "../src/acquisition/candidate-acceptance.js";
import {
  workbenchPdf,
  FIXTURE_DOI,
  FIXTURE_TITLE,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const literature = parseLiterature({
  literature_id: id(1),
  meta_literature_id: id(2),
  version_role: "published",
  status: "UNREVIEWED",
  metadata: {
    title: FIXTURE_TITLE,
    authors: [
      {
        kind: "person",
        display_name: "Fixture Author",
        given_name: null,
        family_name: null,
        orcid: null,
        affiliations: [],
      },
    ],
    abstract: null,
    publication_date: null,
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: FIXTURE_DOI }],
    keywords: [],
  },
});
async function setup() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-candidate-acceptance-"),
  );
  let application = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  await application.database.putLiterature(literature);
  return {
    get app() {
      return application;
    },
    async restart() {
      await application.close();
      application = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
      });
    },
    async candidate(transfer: string, bytes = workbenchPdf(), article = id(1)) {
      const collector = application.execution!.transfers;
      await collector.begin(transfer, 1_000_000, {
        session_id: "fixture-session",
        article_id: article,
        page_id: "fixture-page",
        document_generation: 1,
        source_url: "https://fixture.example.test/paper.pdf",
        captured_at: "2026-09-10T00:00:00Z",
      });
      await collector.append(transfer, bytes);
      return collector.complete(transfer);
    },
    async command(transfer = "transfer-1", receipt = "receipt-1") {
      return {
        literature_id: id(1),
        transfer_id: transfer,
        receipt_id: receipt,
        metadata_snapshot: (await application.database.currentFacts(id(1)))!
          .metadata_snapshot,
      };
    },
    async close() {
      await application.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

it("accepts a recovered PDF using current Literature facts, replays the receipt, and deduplicates repeated bytes", async () => {
  const s = await setup();
  try {
    const catalog = new DatabaseSync(join(s.app.home, "catalog.sqlite"));
    try {
      catalog
        .prepare("INSERT INTO automatic_pdf_acquisition_exhaustions VALUES(?)")
        .run(id(1));
    } finally {
      catalog.close();
    }
    expect(
      (await s.app.library.search({ query: { needs_manual_pdf: true } }))
        .total_count,
    ).toBe(1);
    const candidate = await s.candidate("transfer-1");
    const command = await s.command();
    await s.restart();
    const [result, replay] = await Promise.all([
      s.app.execution!.acceptance.accept(command),
      s.app.execution!.acceptance.accept(command),
    ]);
    expect(replay).toEqual(result);
    const facts = await s.app.database.currentFacts(id(1));
    expect(facts?.literature.status).toBe("ASSET_READY");
    expect(facts?.primary_asset?.sha256).toBe(candidate.sha256);
    expect(
      (await s.app.library.search({ query: { needs_manual_pdf: false } }))
        .total_count,
    ).toBe(1);
    expect(
      (await s.app.library.search({ query: { needs_manual_pdf: true } }))
        .total_count,
    ).toBe(0);
    expect(facts?.literature.metadata.authors[0]?.display_name).toBe(
      "Fixture Author",
    );
    expect(
      await s.app.files.read(result.reference, candidate.size_bytes),
    ).toEqual(workbenchPdf());
    const saved = await s.app.database.getReceiptIntent(command.receipt_id);
    expect(saved?.provenance).toMatchObject({
      source_kind: "asset-provider",
      input_sha256: candidate.sha256,
      source_record_id: "transfer-1",
    });
    await s.candidate("transfer-2");
    const duplicate = await s.app.execution!.acceptance.accept(
      await s.command("transfer-2", "receipt-2"),
    );
    expect(duplicate.asset_id).toBe(result.asset_id);
    expect(duplicate.created).toBe(false);
    expect((await s.app.database.snapshotCounts()).tables).toMatchObject({
      assets: 1,
      literature_assets: 1,
    });
    await s.restart();
    await s.app.database.putLiterature(literature);
    expect(await s.app.execution!.acceptance.accept(command)).toEqual(result);
    await expect(
      s.app.execution!.acceptance.accept({
        ...command,
        transfer_id: "transfer-2",
      }),
    ).rejects.toMatchObject({ code: "candidate-receipt-conflict" });
  } finally {
    await s.close();
  }
}, 20000);

it("reuses an existing catalog Asset ID and reference for matching PDF bytes", async () => {
  const s = await setup();
  try {
    const bytes = workbenchPdf();
    const stage = await s.app.files.stage({ maxBytes: bytes.length });
    await stage.write(bytes);
    const published = await s.app.files.publish(
      stage,
      "objects/existing-paper.pdf",
    );
    const asset = parseAsset({
      asset_id: id(99),
      sha256: published.sha256,
      size_bytes: published.size,
      media_type: "application/pdf",
      path: published.reference,
    });
    await s.app.assets.publish(asset);
    await s.candidate("transfer-1");
    const result = await s.app.execution!.acceptance.accept(await s.command());
    expect(result).toMatchObject({
      asset_id: asset.asset_id,
      reference: asset.path,
      created: false,
    });
    expect((await s.app.database.snapshotCounts()).tables).toMatchObject({
      assets: 1,
      literature_assets: 1,
    });
  } finally {
    await s.close();
  }
}, 20000);

it("refuses stale, misattributed, ambiguous, conflicting, and caller-asserted identity inputs without losing Candidates", async () => {
  const s = await setup();
  try {
    await s.candidate("wrong-article", workbenchPdf(), id(9));
    await expect(
      s.app.execution!.acceptance.accept(await s.command("wrong-article")),
    ).rejects.toMatchObject({ code: "candidate-misattributed" });
    await s.candidate("wrong-doi", workbenchPdf("10.5555/other"));
    await expect(
      s.app.execution!.acceptance.accept(await s.command("wrong-doi")),
    ).rejects.toMatchObject({ code: "candidate-uncertain" });
    await s.candidate("wrong-version", workbenchPdf(FIXTURE_DOI, "preprint"));
    await expect(
      s.app.execution!.acceptance.accept(await s.command("wrong-version")),
    ).rejects.toMatchObject({ code: "candidate-uncertain" });
    await s.candidate("transfer-1");
    const command = await s.command();
    await expect(
      s.app.execution!.acceptance.accept(
        Object.assign({}, command, { identity: "accepted" }),
      ),
    ).rejects.toMatchObject({ code: "candidate-command-invalid" });
    await expect(
      s.app.execution!.acceptance.accept(command, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "candidate-cancelled" });
    await s.app.database.putLiterature(literature);
    await expect(
      s.app.execution!.acceptance.accept(command),
    ).rejects.toMatchObject({ code: "literature-stale" });
    await s.app.execution!.acceptance.accept(await s.command());
    await s.candidate(
      "different-bytes",
      workbenchPdf(FIXTURE_DOI, "published "),
    );
    await expect(
      s.app.execution!.acceptance.accept(
        await s.command("different-bytes", "different-receipt"),
      ),
    ).rejects.toMatchObject({ code: "primary-asset-conflict" });
    expect(
      await s.app.execution!.transfers.recover("wrong-doi"),
    ).not.toBeNull();
    expect((await s.app.database.currentFacts(id(1)))?.literature.status).toBe(
      "ASSET_READY",
    );
    expect((await s.app.database.snapshotCounts()).tables).toMatchObject({
      assets: 1,
      literature_assets: 1,
    });
  } finally {
    await s.close();
  }
}, 20000);

it("rechecks the metadata CAS at publication when facts change after the read snapshot", async () => {
  const s = await setup();
  try {
    await s.candidate("transfer-1");
    const command = await s.command();
    const database = s.app.database;
    const service = new CandidateAcceptanceService(
      {
        getReceiptIntent: (value) => database.getReceiptIntent(value),
        assetByHash: (value) => database.assetByHash(value),
        currentFacts: async (value) => {
          const facts = await database.currentFacts(value);
          await database.putLiterature(literature);
          return facts;
        },
      },
      s.app.execution!.transfers,
      s.app.execution!.publisher,
    );
    await expect(service.accept(command)).rejects.toMatchObject({
      code: "candidate-publication",
      bytes_published: false,
    });
    expect((await database.currentFacts(id(1)))?.literature.status).toBe(
      "UNREVIEWED",
    );
    expect(await database.pendingReceipts()).toEqual([]);
    expect(
      await s.app.execution!.transfers.recover("transfer-1"),
    ).not.toBeNull();
  } finally {
    await s.close();
  }
}, 20000);
