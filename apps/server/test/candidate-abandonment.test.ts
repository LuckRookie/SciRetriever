import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseCandidatePublicationIntent,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

it("abandons only an unpublished durable Candidate and recovers retained evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-abandonment-"));
  let app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const bytes = workbenchPdf();
    const create = async (transferId: string) => {
      await app.execution!.transfers.begin(transferId, bytes.length, {
        session_id: "session-abandonment",
        article_id: FIXTURE_LITERATURE.literature_id,
        page_id: "page-abandonment",
        document_generation: 1,
        source_url: "http://127.0.0.1/paper.pdf",
        captured_at: "2026-09-10T00:00:00Z",
      });
      await app.execution!.transfers.append(transferId, bytes);
      return app.execution!.transfers.complete(transferId);
    };
    const first = await create("candidate-first");
    const second = await create("candidate-second");
    expect(first.reference).toBe(second.reference);

    const result = await app.execution!.abandonment.abandon({
      article_id: FIXTURE_LITERATURE.literature_id,
      transfer_id: first.transfer_id,
      sha256: first.sha256,
    });
    expect(result).toEqual({
      transfer_id: first.transfer_id,
      reclamation: {
        deleted: [],
        preserved: [first.reference],
        missing: [],
      },
    });
    expect(await app.database.getCandidate(first.transfer_id)).toBeNull();
    expect(await app.execution!.transfers.recover(second.transfer_id)).toEqual(
      second,
    );

    const facts = await app.database.currentFacts(
      FIXTURE_LITERATURE.literature_id,
    );
    const intent = parseCandidatePublicationIntent({
      receipt_id: "receipt-pending",
      metadata_snapshot: facts!.metadata_snapshot,
      candidate: second,
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset_id: "50000000-0000-0000-0000-000000000001",
      literature_asset_id: "50000000-0000-0000-0000-000000000002",
      target: `objects/${await sha256(bytes)}.pdf`,
      provenance: {
        provenance_id: "50000000-0000-0000-0000-000000000003",
        source_kind: "asset-provider",
        source_name: "browser",
        source_record_id: second.transfer_id,
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: second.sha256,
        parameters_sha256: null,
      },
      source_url: "http://127.0.0.1/paper.pdf",
      identity: "accepted",
    });
    await app.database.prepareReceipt(intent);
    await expect(
      app.execution!.abandonment.abandon({
        article_id: FIXTURE_LITERATURE.literature_id,
        transfer_id: second.transfer_id,
        sha256: second.sha256,
      }),
    ).rejects.toMatchObject({
      code: "candidate-abandonment",
      catalog_committed: false,
    });

    await app.close();
    app = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    expect(
      await app.execution!.transfers.recover(first.transfer_id),
    ).toBeNull();
    expect(await app.execution!.transfers.recover(second.transfer_id)).toEqual(
      second,
    );
    expect(await app.artifactRecovery.recover()).toEqual([]);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
