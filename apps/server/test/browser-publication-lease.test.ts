import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { BrowserCandidateIntake } from "../src/acquisition/browser-intake.js";
import { PublicAcquisitionRegistry } from "../src/acquisition/sources/public.js";
import { BROWSER_ROUTE_NAME } from "../src/acquisition/assembly.js";
import { EntryPdfAcquisitionService } from "../src/entry/pdf-acquisition.js";
import {
  FIXTURE_LITERATURE,
  FIXTURE_DOI,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import type { BrowserArticleCloseOutcome } from "../src/browser/article-session.js";
import type {
  PdfSourceResult,
  AcquisitionAttempt,
  DurableCandidate,
} from "@sciretriever/contracts";

it.each(["published", "publication-error", "cleanup-error"] as const)(
  "closes the Browser lease after %s while preserving valid file facts",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-browser-lease-"));
    const app = await createApplication(home, {});
    const runtime = app.execution!;
    const closed: BrowserArticleCloseOutcome[] = [];
    const results: PdfSourceResult[] = [];
    const attempts: AcquisitionAttempt[] = [];
    let captured: DurableCandidate | undefined;
    const service = new EntryPdfAcquisitionService({
      registry: new PublicAcquisitionRegistry(
        [
          {
            source_name: BROWSER_ROUTE_NAME,
            ready: true,
            discover: async () => [],
          },
        ],
        [BROWSER_ROUTE_NAME],
      ),
      network_budget: app.networkBudget,
      transfers: runtime.transfers,
      acceptance: runtime.acceptance,
      browser_host: () => ({
        close: async () => undefined,
        deliverCandidate: async (request) => {
          request.on_request_dispatched?.();
          const intake = new BrowserCandidateIntake(runtime.transfers, {
            article_id: request.literature_id,
            identifier: request.identifier,
            version: request.version,
          });
          const result = await intake.receive({
            signal: request.signal,
            transfer_id: "lease-transfer",
            capture: {
              session_id: "lease-session",
              article_id: request.literature_id,
              page_id: "lease-page",
              document_generation: 1,
              source_url: "https://fixture.test/paper.pdf",
              captured_at: new Date().toISOString(),
            },
            chunks: (async function* () {
              yield workbenchPdf(FIXTURE_DOI, "published");
            })(),
          });
          captured = result.candidate;
          return {
            kind: "delivered",
            candidate: result.candidate,
            accepted: true,
            lease: {
              session_id: "lease-session",
              close: async (outcome) => {
                closed.push(outcome);
                if (outcome.kind === "published")
                  expect(
                    (await app.database.currentFacts(request.literature_id))
                      ?.primary_asset?.sha256,
                  ).toBe(captured!.sha256);
                if (mode === "cleanup-error")
                  throw new Error("synthetic close failure");
              },
            },
          };
        },
      }),
    });
    const failure = new Error("synthetic publication failure");
    const spy =
      mode === "publication-error"
        ? vi.spyOn(runtime.acceptance, "accept").mockRejectedValue(failure)
        : undefined;
    try {
      await app.database.putLiterature(FIXTURE_LITERATURE);
      const id = FIXTURE_LITERATURE.literature_id;
      const pending = service.acquire({
        on_source_result: async (value) => {
          results.push(value);
        },
        on_attempt: async (value) => {
          attempts.push(value);
        },
        literature_id: id,
        detail: await app.library.detail(id),
        metadata_snapshot: (await app.database.currentFacts(id))!
          .metadata_snapshot,
        signal: new AbortController().signal,
      });
      if (mode === "publication-error") {
        await expect(pending).rejects.toBe(failure);
        expect(closed).toEqual([
          { kind: "retained", code: "browser-publication-incomplete" },
        ]);
        expect(results).toEqual([]);
        expect(attempts.at(-1)).toMatchObject({
          source: "browser",
          result: "failed",
          requested: true,
        });
        expect((await app.database.currentFacts(id))!.primary_asset).toBeNull();
        expect(await runtime.transfers.recover("lease-transfer")).toEqual(
          captured,
        );
      } else {
        const result = await pending;
        expect(result.kind).toBe("acquired");
        expect(results).toMatchObject([
          {
            source: "browser",
            result: "obtained",
            receipt_id: "entry-browser-lease-transfer",
          },
        ]);
        expect(attempts.at(-1)).toMatchObject({
          source: "browser",
          result: "hit",
          requested: true,
        });
        expect(closed).toEqual([
          { kind: "published", receipt_id: "entry-browser-lease-transfer" },
        ]);
        expect(
          (await app.database.currentFacts(id))!.primary_asset?.sha256,
        ).toBe(captured!.sha256);
      }
    } finally {
      spy?.mockRestore();
      await service.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
