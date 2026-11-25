import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type MetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { IntakeRecognitionService } from "../src/literature/intake-recognition.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { recognitionPdf } from "./intake-recognition-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

afterEach(() => vi.unstubAllEnvs());

/** An empty bundle directory: the server finds no MuPDF, as on a fresh install. */
async function withoutMupdf() {
  const empty = await mkdtemp(join(tmpdir(), "sciretriever-no-mupdf-"));
  vi.stubEnv("SCIRETRIEVER_MUPDF", empty);
  return () => rm(empty, { recursive: true, force: true });
}
function observation(title: string, doi: string): MetadataObservation {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    metadata: {
      ...EMPTY_METADATA,
      title,
      identifiers: [{ namespace: "doi", value: doi }],
    },
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: "crossref",
      source_record_id: doi,
      observed_at: "2026-11-25T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    source_type: null,
    source_type_mapping_version: null,
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
const unread = (counts: Record<string, number> = {}) => {
  const by_reason = {
    "reader-unavailable": 0,
    "reader-timeout": 0,
    "reader-failed": 0,
    "encrypted-pdf": 0,
    "invalid-pdf": 0,
    "image-only": 0,
    ...counts,
  };
  return {
    total: Object.values(by_reason).reduce((a, b) => a + b, 0),
    by_reason,
  };
};

it("declares pdf_reader on the workspace from the MuPDF bundle found at start", async () => {
  for (const missing of [true, false]) {
    const cleanup = missing ? await withoutMupdf() : async () => {};
    const session = new ProductionWorkbenchSession(null, undefined);
    const server = await startWorkbenchHttp({
      session,
      access: workbenchTestAccess,
      assets: new Map([["/", { contentType: "text/html", body: "Synthetic" }]]),
    });
    try {
      const login = await workbenchLogin(server.origin);
      const index = await fetch(server.origin, { headers: { Cookie: login } });
      const cookie = `${login}; ${index.headers.get("set-cookie")!.split(";")[0]!}`;
      const grant = (await (
        await fetch(`${server.origin}/api/clients`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: server.origin,
            "X-Workbench-Init": "1",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).json()) as { client_id: string; csrf: string };
      const response = await fetch(
        `${server.origin}/api/workspace?client_id=${grant.client_id}`,
        {
          headers: {
            Cookie: cookie,
            Origin: server.origin,
            "X-Workbench-Csrf": grant.csrf,
          },
        },
      );
      expect(response.status).toBe(200);
      const { workspace } = (await response.json()) as {
        workspace: { capabilities: Record<string, boolean> };
      };
      expect(workspace.capabilities.pdf_reader).toBe(!missing);
    } finally {
      await server.close();
      await session.close();
      await cleanup();
      vi.unstubAllEnvs();
    }
  }
});

it("counts unread PDFs in a batch, then re-recognizes the saved PDFs once the reader exists", async () => {
  const searched: string[] = [];
  const recognition = new IntakeRecognitionService({
    lookup: async (ids) =>
      ids.some((id) => id.value === "10.5555/recognized")
        ? [observation("A synthetic recognized article", "10.5555/recognized")]
        : [],
    search: async (title) => {
      searched.push(title);
      return /candidate/u.test(title)
        ? [
            observation(
              "A synthetic candidate article on layered materials review",
              "10.5555/candidate",
            ),
          ]
        : [];
    },
  });
  const home = await mkdtemp(join(tmpdir(), "sciretriever-file-recognition-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { recognition },
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "Synthetic" }]]),
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app),
    },
  });
  const request = await app.deviceConnections.create({
    address: server.origin,
    name: "Synthetic",
    purposes: ["intake"],
  });
  const device = await app.deviceConnections.exchange(
    { pairing_code: request.connection_code.split(":")[2] },
    randomUUID(),
  );
  const headers = {
    Authorization: `Bearer ${device.token}`,
    Origin: "chrome-extension://synthetic",
    "X-Sciretriever-Protocol-Version": "1",
  };
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`${server.origin}/api/v1/intake/${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, request: body }),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const upload = async (path: string, data: Uint8Array, name: string) => {
    const response = await fetch(`${server.origin}/api/v1/intake/${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/pdf",
        "X-Sciretriever-File-Name": encodeURIComponent(name),
      },
      body: Buffer.from(data),
    });
    return response.status;
  };
  const restore = await withoutMupdf();
  try {
    const created = await post("batches", {
      format: "file",
      source: null,
      scope: "Synthetic recognition intake",
    });
    const id = created.result.batch.batch_id as string;
    const files = {
      "alpha-recognized.pdf": recognitionPdf({
        pages: [
          [
            { text: "A synthetic recognized article", size: 24 },
            { text: "doi:10.5555/recognized", size: 10 },
          ],
        ],
      }),
      "bravo-title.pdf": recognitionPdf({
        pages: [[{ text: "A replacement title from the PDF", size: 24 }]],
      }),
      "charlie-candidate.pdf": recognitionPdf({
        pages: [
          [
            {
              text: "A synthetic candidate article on layered materials",
              size: 24,
            },
          ],
        ],
      }),
      "delta-scan.pdf": recognitionPdf({ pages: [[]] }),
    };
    for (const [name, pdf] of Object.entries(files))
      expect(await upload(`batches/${id}/file-items`, pdf, name)).toBe(200);
    await vi.waitFor(
      async () =>
        expect(
          (await post(`batches/${id}/preview`)).result.recognition.state,
        ).toBe("done"),
      { timeout: 20000, interval: 30 },
    );
    const preview = await post(`batches/${id}/preview`);
    expect(preview.result.summary.records.clues_unread).toEqual(
      unread({ "reader-unavailable": 4 }),
    );
    expect((await post(`batches/${id}/confirm`)).status).toBe(200);
    await vi.waitFor(
      async () =>
        expect((await post(`batches/${id}/status`)).result.batch.state).toBe(
          "finished",
        ),
      { timeout: 20000, interval: 30 },
    );
    const report = (await post(`batches/${id}/report`)).result;
    expect(report.summary.records).toMatchObject({
      created: 4,
      needs_metadata: 4,
      clues_unread: unread({ "reader-unavailable": 4 }),
    });
    expect(searched).toEqual([]);
    const papers = async (): Promise<
      Record<string, { id: string; needs: boolean; doi: string | null }>
    > =>
      Object.fromEntries(
        (await app.library.search({ query: {} })).items.map((item) => [
          item.literature.metadata.title,
          {
            id: item.literature.literature_id,
            needs: item.needs_metadata,
            doi:
              item.literature.metadata.identifiers.find(
                (i) => i.namespace === "doi",
              )?.value ?? null,
          },
        ]),
      );
    const imported = await papers();
    expect(Object.keys(imported).sort()).toEqual([
      "alpha-recognized",
      "bravo-title",
      "charlie-candidate",
      "delta-scan",
    ]);
    expect(Object.values(imported).every((p) => p.needs)).toBe(true);

    // Without a reader the task is refused, not queued to fail.
    const jobs = (await app.jobs!.listJobs(100)).length;
    await expect(
      executeMaintenance(app, "literature-recognize", {
        selector: { kind: "needs-metadata" },
      }),
    ).rejects.toMatchObject({ code: "pdf-reader-missing" });
    const one = imported["alpha-recognized"]!.id;
    for (const literature_ids of [
      Array.from({ length: 1001 }, () => randomUUID()),
      [one, one],
      [],
    ])
      await expect(
        executeMaintenance(app, "literature-recognize", {
          selector: { kind: "literatures", literature_ids },
        }),
      ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await app.jobs!.listJobs(100)).toHaveLength(jobs);

    await restore();
    vi.unstubAllEnvs();
    const job = (await executeMaintenance(app, "literature-recognize", {
      selector: { kind: "needs-metadata" },
    })) as { job_id: string; status: string };
    expect(job.status).toBe("queued");
    const task = await app.processingTasks!.run(job.job_id);
    expect(task.job.status).toBe("completed");
    expect(
      (task as { literature_recognition?: unknown }).literature_recognition,
    ).toEqual({
      total: 4,
      processed: 4,
      recognized: 1,
      conflicts: 0,
      candidates: 1,
      title_replaced: 1,
      unrecognized: 0,
      unread: unread({ "image-only": 1 }),
      skipped: {
        total: 0,
        by_reason: {
          "not-marked": 0,
          "no-pdf": 0,
          trashed: 0,
          withdrawn: 0,
          missing: 0,
        },
      },
    });
    const outcomes = Object.fromEntries(
      (task.results as { result: { literature_id: string } }[]).map((r) => [
        r.result.literature_id,
        r.result,
      ]),
    );
    expect(outcomes[imported["charlie-candidate"]!.id]).toMatchObject({
      outcome: "candidates",
      title_replaced: true,
    });
    expect(outcomes[imported["delta-scan"]!.id]).toMatchObject({
      outcome: "unread",
      reason: "image-only",
    });
    const after = await papers();
    expect(after).toEqual({
      "A synthetic recognized article": {
        id: imported["alpha-recognized"]!.id,
        needs: false,
        doi: "10.5555/recognized",
      },
      "A replacement title from the PDF": {
        id: imported["bravo-title"]!.id,
        needs: true,
        doi: null,
      },
      "A synthetic candidate article on layered materials": {
        id: imported["charlie-candidate"]!.id,
        needs: true,
        doi: null,
      },
      "delta-scan": { id: imported["delta-scan"]!.id, needs: true, doi: null },
    });
    const detail = await app.library.detail(imported["bravo-title"]!.id);
    expect(
      detail.metadata_observations.map((o) => o.provenance.source_name),
    ).toContain("file-recognition");

    // A literature no longer marked is skipped and counted, not re-read.
    const again = (await executeMaintenance(app, "literature-recognize", {
      selector: { kind: "literatures", literature_ids: [one] },
    })) as { job_id: string };
    const skipped = await app.processingTasks!.run(again.job_id);
    expect(skipped.targets[0]).toMatchObject({ stage: "skipped" });
    expect(
      (skipped as { literature_recognition?: { skipped: unknown } })
        .literature_recognition?.skipped,
    ).toMatchObject({ total: 1, by_reason: { "not-marked": 1 } });
  } finally {
    await restore();
    await server.close();
    await session.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
