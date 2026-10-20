import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { parseAsset, parseLiterature } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { BrowserCandidateIntake } from "../src/acquisition/browser-intake.js";
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
    publication_form: "journal-article" as const,
    article_kind: null,
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
async function setup(seed = literature) {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-candidate-acceptance-"),
  );
  let application = await createApplication(home, {});
  await application.database.putLiterature(seed);
  return {
    get app() {
      return application;
    },
    async restart() {
      await application.close();
      application = await createApplication(home, {});
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

it.each([false, true])(
  "publishes an unverified preprint without content identity matching, with a metadata DOI: %s",
  async (withDoi) => {
    const s = await setup(
      parseLiterature({
        ...literature,
        version_role: "preprint",
        metadata: {
          ...literature.metadata,
          identifiers: [
            { namespace: "arxiv", value: "2401.12345" },
            ...(withDoi ? [{ namespace: "doi", value: FIXTURE_DOI }] : []),
          ],
        },
      }),
    );
    try {
      const candidate = await s.candidate(
        "preprint",
        workbenchPdf("arXiv:2401.99999v2", "published"),
      );
      const receipt = await s.app.execution!.acceptance.accept(
        await s.command("preprint"),
      );
      expect(
        (await s.app.library.detail(id(1))).primary_pdf
          ?.article_identity_status,
      ).toBe("unverified");
      expect(receipt.sha256).toBe(candidate.sha256);
      expect(
        (await s.app.database.currentFacts(id(1)))?.literature.status,
      ).toBe("ASSET_READY");
    } finally {
      await s.close();
    }
  },
);

it("accepts a recovered PDF using current Literature facts, replays the receipt, and deduplicates repeated bytes", async () => {
  const s = await setup();
  try {
    // The fact is written through its public API; direct tests never fabricate it with
    // raw SQL, so this proves the production write path.
    await s.app.database.setAutomaticPdfExhaustion(id(1));
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
    expect(result.reference).toBe(
      `originals/pdf/${candidate.sha256.slice(0, 2)}/${candidate.sha256}.pdf`,
    );
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
    expect(saved?.identity).toBe("unverified");
    expect(
      (await s.app.library.detail(id(1))).primary_pdf?.article_identity_status,
    ).toBe("unverified");
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

it("refuses stale, misattributed, conflicting and caller-asserted inputs without losing Candidates", async () => {
  const s = await setup();
  try {
    await s.candidate("wrong-article", workbenchPdf(), id(9));
    await expect(
      s.app.execution!.acceptance.accept(await s.command("wrong-article")),
    ).rejects.toMatchObject({ code: "candidate-misattributed" });
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
      await s.app.execution!.transfers.recover("different-bytes"),
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

it.each([
  { name: "no DOI", pdf: workbenchPdf("", "") },
  { name: "spaced DOI", pdf: workbenchPdf("10.5555/ 1 2 3", "") },
  {
    name: "different DOI and version",
    pdf: workbenchPdf("10.5555/another", "preprint"),
  },
  { name: "no extractable text", pdf: workbenchPdf(FIXTURE_DOI, "", false) },
])(
  "publishes Browser bytes with $name as unverified and preserves the label after restart",
  async ({ pdf }) => {
    const s = await setup(
      parseLiterature({
        ...literature,
        metadata: { ...literature.metadata, identifiers: [] },
      }),
    );
    try {
      const intake = new BrowserCandidateIntake(s.app.execution!.transfers, {
        article_id: id(1),
        identifier: "literature:" + id(1),
        version: "published",
      });
      const received = await intake.receive({
        signal: new AbortController().signal,
        transfer_id: "unverified-browser",
        capture: {
          article_id: id(1),
          session_id: "browser-test",
          page_id: "page-1",
          document_generation: 1,
          source_url: "https://example.test/article/pdf",
          captured_at: "2026-10-04T00:00:00Z",
        },
        chunks: (async function* () {
          yield pdf;
        })(),
      });
      expect(received.assessment).toEqual({ accepted: true, page_count: 1 });
      const command = await s.command("unverified-browser");
      const receipt = await s.app.execution!.acceptance.accept(command);
      expect(
        (await s.app.database.getReceiptIntent(command.receipt_id))?.identity,
      ).toBe("unverified");
      expect(await s.app.files.read(receipt.reference, pdf.length)).toEqual(
        pdf,
      );
      await s.restart();
      const detail = await s.app.library.detail(id(1));
      expect(detail.primary_pdf?.article_identity_status).toBe("unverified");
      expect(detail.primary_pdf?.asset.sha256).toBe(receipt.sha256);
      expect(detail.literature.status).toBe("ASSET_READY");
      expect(detail.missing_step).toBe("raw-parse");
      expect(await s.app.execution!.acceptance.accept(command)).toEqual(
        receipt,
      );
    } finally {
      await s.close();
    }
  },
);

it("keeps Browser file validity and article-task binding checks without content identity extraction", async () => {
  const s = await setup();
  try {
    const intake = new BrowserCandidateIntake(s.app.execution!.transfers, {
      article_id: id(1),
      identifier: "doi:" + FIXTURE_DOI,
      version: "published",
    });
    const input = (bytes: Uint8Array, article = id(1)) => ({
      signal: new AbortController().signal,
      transfer_id: "invalid-browser",
      capture: {
        article_id: article,
        session_id: "browser-test",
        page_id: "page-1",
        document_generation: 1,
        source_url: "https://example.test/article/pdf",
        captured_at: "2026-10-04T00:00:00Z",
      },
      chunks: (async function* () {
        yield bytes;
      })(),
    });
    await expect(
      intake.receive(input(Buffer.from("<html>Access denied</html>"))),
    ).rejects.toMatchObject({ code: "pdf-acceptance" });
    await expect(intake.receive(input(workbenchPdf(), id(2)))).rejects.toThrow(
      "misattributed",
    );
    expect((await s.app.library.detail(id(1))).primary_pdf).toBeNull();
    expect(
      await s.app.execution!.transfers.recover("invalid-browser"),
    ).toBeNull();
  } finally {
    await s.close();
  }
});
