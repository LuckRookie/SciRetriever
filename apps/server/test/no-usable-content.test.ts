import { NoUsableContentReclamationFailure } from "../src/entry/no-usable-content.js";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import {
  parseAnalysisInputIdentity,
  parseLiterature,
  type CandidatePublicationIntent,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { prepareCandidateCleanup } from "../src/acquisition/candidate-cleanup.js";
import { setup, lit, id } from "./content-fixture.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
async function prepared() {
  const env = await setup(true);
  const d = await env.app.library.detail(lit),
    primary = d.primary_pdf!,
    asset = primary.asset;
  const transfers = env.app.execution!.transfers;
  await transfers.begin("bad-pdf", undefined, {
    session_id: "fixture-session",
    article_id: lit,
    page_id: "fixture-page",
    document_generation: 1,
    source_url: "https://fixture.invalid/paper",
    captured_at: "2026-09-10T00:00:00Z",
  });
  await transfers.append(
    "bad-pdf",
    await env.app.files.read(asset.path, asset.size_bytes),
  );
  const candidate = await transfers.complete("bad-pdf");
  const intent: CandidatePublicationIntent = {
    candidate,
    receipt_id: "published",
    literature_id: lit,
    asset_id: asset.asset_id,
    literature_asset_id: primary.literature_asset.literature_asset_id,
    metadata_snapshot: {
      revision: d.metadata_revision,
      sha256: d.metadata_sha256,
    },
    target: asset.path,
    provenance: primary.literature_asset.provenance,
    source_url: null,
    identity: "accepted",
  };
  await env.app.execution!.publisher.publish(intent);
  await env.app.database.prepareReceipt({ ...intent, receipt_id: "pending" });
  const decision = {
    outcome: "no_usable_content",
    input: parseAnalysisInputIdentity({
      literature_id: lit,
      primary_asset_id: asset.asset_id,
      primary_pdf_sha256: asset.sha256,
      parser_result_sha256: d.parser_result!.result_sha256,
      input_metadata_revision: d.metadata_revision,
      input_metadata_sha256: d.metadata_sha256,
    }),
  };
  return { ...env, decision, intent, d, candidate };
}
it("atomically removes published/pending receipts and candidate, reclaims bytes, and cannot replay after restart", async () => {
  const env = await prepared();
  let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    await env.app.database.putCandidate({
      ...env.candidate,
      transfer_id: "duplicate-input",
    });
    const result = await env.app.noUsableContent.cleanup(env.decision);
    expect(result.outcome).toBe("no_usable_content_cleaned");
    expect(result.reclamation.deleted).toHaveLength(3);
    expect(result.reclamation.preserved).toEqual([]);
    expect(await env.app.database.getCandidate("bad-pdf")).toBeNull();
    expect(await env.app.database.getCandidate("duplicate-input")).toBeNull();
    expect(await env.app.database.getReceiptIntent("published")).toBeNull();
    expect(await env.app.database.pendingReceipts()).toEqual([]);
    expect(env.app.execution!.transfers.get("bad-pdf")).toBeUndefined();
    await expect(
      env.app.execution!.transfers.complete("bad-pdf"),
    ).rejects.toMatchObject({ code: "browser-transfer" });
    await expect(
      env.app.execution!.publisher.publish(env.intent),
    ).rejects.toMatchObject({
      code: "candidate-publication",
      bytes_published: false,
    });
    for (const reference of result.reclamation.deleted)
      await expect(
        readFile(join(env.app.files.root, reference)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(join(env.app.files.root, "objects"))).some((n) =>
        n.startsWith(".reclaim-"),
      ),
    ).toBe(false);
    expect(
      (await readdir(join(env.app.files.root, ".candidates"))).some((n) =>
        n.startsWith(".reclaim-"),
      ),
    ).toBe(false);
    const after = await env.app.library.detail(lit);
    expect(after.primary_pdf).toBeNull();
    expect(after.parser_result).toBeNull();
    expect(after.literature.metadata).toEqual(env.d.literature.metadata);
    await env.app.close();
    reopened = await createApplication(env.home, {
      executionSchema: "upgrade-synthetic",
    });
    expect(await reopened.execution!.publisher.reconcile()).toEqual([]);
    await expect(
      reopened.execution!.publisher.publish(env.intent),
    ).rejects.toMatchObject({
      code: "candidate-publication",
      bytes_published: false,
    });
    expect(await reopened.library.detail(lit)).toEqual(after);
    await reopened.execution!.transfers.begin(
      "rediscovered",
      undefined,
      env.candidate.capture,
    );
    await reopened.execution!.transfers.append("rediscovered", workbenchPdf());
    expect(
      (await reopened.execution!.transfers.complete("rediscovered")).sha256,
    ).toBe(env.candidate.sha256);
  } finally {
    await reopened?.close();
    await env.close();
  }
});
it.each(["execution_receipts", "execution_candidates", "parser_results"])(
  "rolls back both current facts and execution records when deleting %s fails",
  async (table) => {
    const env = await prepared();
    const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
    try {
      db.exec(
        `CREATE TRIGGER cleanup_fail BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'fixture failure'); END`,
      );
      const snapshot = await env.app.database.candidateCleanupSnapshot();
      await expect(
        env.app.noUsableContent.cleanup(env.decision),
      ).rejects.toBeInstanceOf(Error);
      expect(await env.app.database.candidateCleanupSnapshot()).toEqual(
        snapshot,
      );
      expect(await env.app.library.detail(lit)).toEqual(env.d);
      expect(env.app.execution!.transfers.get("bad-pdf")?.state).toBe(
        "durable-ready",
      );
      expect(
        (
          await env.app.files.read(
            env.candidate.reference,
            env.candidate.size_bytes,
          )
        ).length,
      ).toBe(env.candidate.size_bytes);
    } finally {
      db.close();
      await env.close();
    }
  },
);
it("refuses the lower-level catalog-only cleanup when execution associations need a coordinated decision", async () => {
  const env = await prepared();
  try {
    await expect(
      env.app.literatureCleanup.cleanup(env.decision),
    ).rejects.toMatchObject({ code: "content-cleanup-storage" });
    expect(await env.app.database.getReceiptIntent("published")).not.toBeNull();
    expect(await env.app.library.detail(lit)).toEqual(env.d);
  } finally {
    await env.close();
  }
});
it("CAS includes execution records and rejects a candidate added after owner preparation", async () => {
  const env = await prepared();
  try {
    const command = await env.app.literatureCleanup.prepare(env.decision);
    const candidate_cleanup = prepareCandidateCleanup(
      command.input,
      await env.app.database.candidateCleanupSnapshot(),
    );
    await env.app.database.putCandidate({
      ...env.candidate,
      transfer_id: "concurrent",
    });
    expect(
      await env.app.database.cleanupNoUsableContent({
        ...command,
        candidate_cleanup,
      }),
    ).toBeNull();
    expect(await env.app.library.detail(lit)).toEqual(env.d);
    expect(await env.app.database.getCandidate("concurrent")).not.toBeNull();
  } finally {
    await env.close();
  }
});
it("rejects corrupted execution identity before any current fact or file changes", async () => {
  const env = await prepared();
  const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
  try {
    db.prepare(
      "UPDATE execution_candidates SET record_json=? WHERE transfer_id='bad-pdf'",
    ).run(JSON.stringify({ ...env.candidate, transfer_id: "wrong" }));
    await expect(
      env.app.noUsableContent.cleanup(env.decision),
    ).rejects.toBeInstanceOf(Error);
    expect(await env.app.library.detail(lit)).toEqual(env.d);
    expect(await env.app.database.getReceiptIntent("published")).not.toBeNull();
    expect(
      (
        await env.app.files.read(
          env.candidate.reference,
          env.candidate.size_bytes,
        )
      ).length,
    ).toBe(env.candidate.size_bytes);
  } finally {
    db.close();
    await env.close();
  }
});
it("preserves candidates and pending receipts for another article sharing the same PDF bytes", async () => {
  const env = await prepared();
  try {
    const other = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: id(90),
      meta_literature_id: id(91),
    });
    await env.app.database.putLiterature(other);
    const facts = await env.app.database.currentFacts(other.literature_id);
    const candidate = {
      ...env.candidate,
      transfer_id: "other-article",
      capture: { ...env.candidate.capture!, article_id: other.literature_id },
    };
    await env.app.database.putCandidate(candidate);
    await env.app.database.prepareReceipt({
      ...env.intent,
      candidate,
      literature_id: other.literature_id,
      receipt_id: "other-pending",
      metadata_snapshot: facts!.metadata_snapshot,
    });
    const result = await env.app.noUsableContent.cleanup(env.decision);
    expect(result.reclamation.preserved).toContain(env.candidate.reference);
    expect(result.reclamation.preserved).toContain(env.intent.target);
    expect(await env.app.database.getCandidate("bad-pdf")).toBeNull();
    expect(await env.app.database.getCandidate("other-article")).toEqual(
      candidate,
    );
    expect(
      (await env.app.database.pendingReceipts()).map((r) => r.receipt_id),
    ).toEqual(["other-pending"]);
    expect(await env.app.execution!.transfers.recover("other-article")).toEqual(
      candidate,
    );
  } finally {
    await env.close();
  }
});
it("reports committed catalog cleanup separately when physical reclamation fails, and permits exact retry", async () => {
  const env = await prepared();
  try {
    const reclaim = env.app.artifactReclaimer.reclaim.bind(
      env.app.artifactReclaimer,
    );
    env.app.artifactReclaimer.reclaim = async () => {
      throw new Error("fixture filesystem failure");
    };
    let failure: unknown;
    try {
      await env.app.noUsableContent.cleanup(env.decision);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NoUsableContentReclamationFailure);
    if (!(failure instanceof NoUsableContentReclamationFailure))
      throw new Error("unexpected failure");
    expect(failure.retired_artifacts).toHaveLength(3);
    expect((await env.app.library.detail(lit)).primary_pdf).toBeNull();
    expect(await env.app.database.getCandidate("bad-pdf")).toBeNull();
    expect(await env.app.database.pendingReceipts()).toEqual([]);
    env.app.artifactReclaimer.reclaim = reclaim;
    expect((await reclaim(failure.retired_artifacts)).deleted).toHaveLength(3);
    await expect(
      env.app.execution!.publisher.publish(env.intent),
    ).rejects.toMatchObject({ code: "candidate-publication" });
  } finally {
    await env.close();
  }
});
it("finishes committed cleanup when cancellation arrives after the SQL commit", async () => {
  const env = await prepared(),
    stop = new AbortController();
  try {
    const commit = env.app.database.cleanupNoUsableContent.bind(
      env.app.database,
    );
    env.app.database.cleanupNoUsableContent = async (command) => {
      const result = await commit(command);
      stop.abort();
      return result;
    };
    const result = await env.app.noUsableContent.cleanup(
      env.decision,
      stop.signal,
    );
    expect(result.outcome).toBe("no_usable_content_cleaned");
    expect(result.reclamation.deleted).toHaveLength(3);
    expect(await env.app.database.getCandidate("bad-pdf")).toBeNull();
  } finally {
    await env.close();
  }
});
it("rejects an owner command that omits or adds execution removals", async () => {
  const env = await prepared();
  try {
    const command = await env.app.literatureCleanup.prepare(env.decision);
    const decision = prepareCandidateCleanup(
      command.input,
      await env.app.database.candidateCleanupSnapshot(),
    );
    for (const candidate_cleanup of [
      { ...decision, receipt_ids: [] },
      { ...decision, transfer_ids: [...decision.transfer_ids, "unrelated"] },
    ]) {
      await expect(
        env.app.database.cleanupNoUsableContent({
          ...command,
          candidate_cleanup,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await env.app.library.detail(lit)).toEqual(env.d);
      expect(await env.app.database.getCandidate("bad-pdf")).toEqual(
        env.candidate,
      );
    }
  } finally {
    await env.close();
  }
});
