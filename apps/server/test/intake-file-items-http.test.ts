import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type DevicePurpose,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";
import { recognitionPdf } from "./intake-recognition-fixture.js";
import { syntheticPage } from "./intake-page-fixture.js";
import { IntakeRecognitionService } from "../src/literature/intake-recognition.js";

async function fixture(
  recognition?: IntakeRecognitionService,
  availableBytes?: () => Promise<number>,
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-file-http-"));
  let now = Date.now();
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: {
      now: () => now,
      ...(recognition ? { recognition } : {}),
      ...(availableBytes ? { availableBytes } : {}),
    },
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
  async function pair(purposes: DevicePurpose[] = ["intake"]) {
    const request = await app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic",
      purposes,
    });
    return app.deviceConnections.exchange(
      { pairing_code: request.connection_code.split(":")[2] },
      randomUUID(),
    );
  }
  const device = await pair();
  async function post(
    path: string,
    request: unknown = {},
    token = device.token,
  ) {
    const response = await fetch(server.origin + "/api/v1/intake/" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "chrome-extension://synthetic",
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
      },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function upload(
    path: string,
    data: Uint8Array,
    name = "Synthetic.pdf",
    relative: string | null = null,
    token = device.token,
  ) {
    const response = await fetch(server.origin + "/api/v1/intake/" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "chrome-extension://synthetic",
        "Content-Type": "application/pdf",
        "X-Sciretriever-Protocol-Version": "1",
        "X-Sciretriever-File-Name": encodeURIComponent(name),
        ...(relative === null
          ? {}
          : { "X-Sciretriever-Relative-Path": encodeURIComponent(relative) }),
      },
      body: Buffer.from(data),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function batch(format = "file") {
    const created = await post("batches", {
      format,
      source: null,
      scope: "Synthetic file intake",
    });
    expect(created.status).toBe(200);
    return created.result.batch.batch_id as string;
  }
  async function ready(id: string) {
    await vi.waitFor(
      async () => {
        const preview = await post(`batches/${id}/preview`);
        expect(preview.status).toBe(200);
        expect(preview.result.recognition.state).toBe("done");
      },
      { timeout: 20000, interval: 30 },
    );
  }
  async function finish(id: string) {
    const response = await post(`batches/${id}/confirm`);
    expect(response.status).toBe(200);
    expect(response.result.batch.state).toBe("running");
    await vi.waitFor(
      async () =>
        expect((await post(`batches/${id}/status`)).result.batch.state).toBe(
          "finished",
        ),
      { timeout: 20000, interval: 30 },
    );
    return post(`batches/${id}/report`);
  }
  function sql(query: string) {
    const db = new DatabaseSync(join(home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      return db.prepare(query).all();
    } finally {
      db.close();
    }
  }
  return {
    connectionId: device.connection.connection_id,
    home,
    app,
    post,
    upload,
    pair,
    batch,
    ready,
    finish,
    sql,
    advance: () => {
      now += 8 * 86400000;
    },
    async close() {
      await server.close();
      await session.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function candidate(source: string, doi: string) {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    metadata: {
      ...EMPTY_METADATA,
      title: "A synthetic candidate article",
      identifiers: [{ namespace: "doi", value: doi }],
      publication_year: 2026,
    },
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: doi,
      observed_at: "2026-11-15T00:00:00Z",
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
it("keeps include when a user chooses a recognition candidate and never queries again at confirmation", async () => {
  let calls = 0;
  const crossref = candidate("crossref", "10.5555/choice"),
    openalex = candidate("openalex", "10.5555/alternative");
  const f = await fixture(
    new IntakeRecognitionService({
      lookup: async () => [],
      search: async () => {
        calls++;
        return [crossref, openalex];
      },
    }),
  );
  try {
    const id = await f.batch("records"),
      uploaded = await f.upload(
        `batches/${id}/file-items`,
        recognitionPdf({
          info: { title: "A synthetic candidate article" },
          pages: [[{ text: "A synthetic candidate article 2026" }]],
        }),
      );
    const itemId = uploaded.result.item.item_id;
    expect(
      (
        await f.post(`batches/${id}/items/${itemId}/decide`, {
          decision: { kind: "include" },
        })
      ).status,
    ).toBe(200);
    await f.ready(id);
    const item = (await f.post(`batches/${id}/items/${itemId}/status`)).result
      .item;
    expect(item.recognition.state).toBe("candidates");
    expect(
      (
        await f.post(`batches/${id}/items/${itemId}/decide`, {
          decision: {
            kind: "candidate",
            candidate_id: item.recognition.candidates[0].candidate_id,
          },
        })
      ).status,
    ).toBe(200);
    const before = calls;
    expect((await f.finish(id)).result.summary.records.created).toBe(1);
    expect(calls).toBe(before);
    const found = (await f.app.library.search({ query: {} })).items[0]!;
    expect(found.literature.metadata.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.5555/choice",
    });
    expect(found.needs_metadata).toBe(false);
  } finally {
    await f.close();
  }
}, 40000);
it("uploads a single PDF over HTTP, recognizes without library writes, confirms and matches its hash on a second batch", async () => {
  const f = await fixture();
  try {
    const pdf = recognitionPdf({ info: { title: "Synthetic HTTP file" } });
    for (let i = 0; i < 2; i++) {
      const id = await f.batch();
      const uploaded = await f.upload(`batches/${id}/file-items`, pdf);
      expect(uploaded.status).toBe(200);
      expect(uploaded.result.item).toMatchObject({
        origin: "file",
        unpaired: false,
        disposition: null,
      });
      expect((await f.post(`batches/${id}/confirm`)).code).toBe(
        "intake-recognition-pending",
      );
      const before = JSON.stringify(f.sql("SELECT * FROM literatures"));
      const observations = JSON.stringify(
        f.sql("SELECT * FROM metadata_observations"),
      );
      const stateSnapshot = () =>
        Object.fromEntries(
          [
            "literature_metadata",
            "literature_metadata_field_states",
            "library_state_revision",
            "library_state_changes",
            "folders",
            "folder_members",
          ].map((table) => [table, f.sql(`SELECT * FROM ${table}`)]),
        );
      const beforeState = stateSnapshot();
      await f.ready(id);
      expect(JSON.stringify(f.sql("SELECT * FROM literatures"))).toBe(before);
      expect(JSON.stringify(f.sql("SELECT * FROM metadata_observations"))).toBe(
        observations,
      );
      expect(stateSnapshot()).toEqual(beforeState);
      const report = await f.finish(id);
      expect(report.result.batch.result).toBe("completed");
      expect(report.result.summary.records[i ? "matched" : "created"]).toBe(1);
      const files = await f.post(`batches/${id}/files`, { pending: false });
      expect(files.result.items[0].status).toBe(i ? "existing" : "uploaded");
    }
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    const only = (await f.app.library.search({ query: {} })).items[0]!
      .literature.literature_id;
    expect(
      (await f.app.library.detail(only)).primary_pdf!.article_identity_status,
    ).toBe("unverified");
    expect(f.sql("SELECT * FROM literature_needs_metadata")).toHaveLength(1);
    expect(f.sql("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
}, 40000);
it("streams a PDF above 16 MiB as an item outside the JSON data budget and refuses insufficient disk space", async () => {
  const f = await fixture();
  try {
    const pdf = Buffer.from(recognitionPdf()),
      xref = /startxref\s+(\d+)/u.exec(pdf.toString())![1]!;
    const large = Buffer.concat([
      pdf,
      Buffer.alloc(17 * 1024 * 1024, 32),
      Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`),
    ]);
    const id = await f.batch();
    expect((await f.upload(`batches/${id}/file-items`, large)).status).toBe(
      200,
    );
    expect(f.sql("SELECT * FROM import_parts")).toEqual([]);
    await f.ready(id);
    expect((await f.finish(id)).result.batch.result).toBe("completed");
    expect(
      (
        await f.app.library.detail(
          (await f.app.library.search({ query: {} })).items[0]!.literature
            .literature_id,
        )
      ).primary_pdf!.asset.size_bytes,
    ).toBe(large.length);
  } finally {
    await f.close();
  }
  const unavailable = await fixture(undefined, async () => 0);
  try {
    const id = await unavailable.batch();
    expect(
      await unavailable.upload(`batches/${id}/file-items`, recognitionPdf()),
    ).toMatchObject({ status: 507, code: "intake-disk-space" });
    expect(unavailable.sql("SELECT * FROM execution_candidates")).toEqual([]);
  } finally {
    await unavailable.close();
  }
}, 40000);
it("restores a hash-matched literature and refuses a conflicting recognized identifier without importing its observation", async () => {
  let identify = false;
  const f = await fixture(
    new IntakeRecognitionService({
      lookup: async () =>
        identify ? [candidate("crossref", "10.5555/contradicting")] : [],
      search: async () => [],
    }),
  );
  try {
    const pdf = recognitionPdf({
      info: {
        title: "A synthetic candidate article",
        subject: "10.5555/contradicting",
      },
    });
    const first = await f.batch();
    expect((await f.upload(`batches/${first}/file-items`, pdf)).status).toBe(
      200,
    );
    await f.ready(first);
    await f.finish(first);
    const lit = (await f.app.library.search({ query: {} })).items[0]!.literature
      .literature_id;
    const raw = new DatabaseSync(join(f.home, "catalog.sqlite"));
    try {
      raw
        .prepare(
          "INSERT INTO intake_withdrawn_objects VALUES('literature',?,?,?)",
        )
        .run(lit, first, "2026-11-15T00:00:00Z");
    } finally {
      raw.close();
    }
    const second = await f.batch();
    expect((await f.upload(`batches/${second}/file-items`, pdf)).status).toBe(
      200,
    );
    await f.ready(second);
    expect((await f.finish(second)).result.summary.records.restored).toBe(1);
    expect(f.sql("SELECT * FROM intake_withdrawn_objects")).toEqual([]);
    const current = await f.app.metadataFields.read(lit);
    await f.app.metadataFields.edit({
      literature_id: lit,
      expected_revision: current.metadata_revision,
      set: [
        {
          field: "identifiers",
          value: [{ namespace: "doi", value: "10.5555/original" }],
        },
      ],
      unlock: [],
    });
    identify = true;
    const third = await f.batch();
    expect((await f.upload(`batches/${third}/file-items`, pdf)).status).toBe(
      200,
    );
    await f.ready(third);
    const failed = await f.finish(third);
    expect(failed.result.items[0]).toMatchObject({
      disposition: "conflict",
      reason: "file-identity-conflict",
    });
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(
      f.sql("SELECT * FROM provenances WHERE source_name='crossref'"),
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 40000);
it("matches an existing supplementary PDF by hash without creating literature or promoting it to primary", async () => {
  const f = await fixture();
  try {
    const pdf = recognitionPdf({
      info: { title: "Synthetic supplementary PDF" },
    });
    const first = await f.batch();
    expect((await f.upload(`batches/${first}/file-items`, pdf)).status).toBe(
      200,
    );
    await f.ready(first);
    const initial = await f.finish(first);
    const literatureId = initial.result.items[0].literature_id;
    const raw = new DatabaseSync(join(f.home, "catalog.sqlite"));
    try {
      raw
        .prepare(
          "UPDATE literature_assets SET role='supplementary' WHERE literature_id=? AND role='primary-pdf'",
        )
        .run(literatureId);
    } finally {
      raw.close();
    }
    const second = await f.batch();
    expect((await f.upload(`batches/${second}/file-items`, pdf)).status).toBe(
      200,
    );
    await f.ready(second);
    const report = await f.finish(second);
    expect(report.result.batch.result).toBe("completed");
    expect(report.result.summary.records.matched).toBe(1);
    expect(report.result.items[0]).toMatchObject({
      literature_id: literatureId,
      reason: "matched-by-supplementary",
    });
    expect(
      (await f.post(`batches/${second}/files`, { pending: false })).result
        .items[0].status,
    ).toBe("existing");
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(f.sql("SELECT role FROM literature_assets")).toEqual([
      { role: "supplementary" },
    ]);
  } finally {
    await f.close();
  }
}, 40000);
it("cancels a running recognition query without library writes, then resumes it on a later preview", async () => {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const recognition = new IntakeRecognitionService({
    lookup: async (_ids, signal) =>
      new Promise((resolve, reject) => {
        entered();
        if (cancelled) {
          resolve([]);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    search: async () => [],
  });
  const f = await fixture(recognition);
  try {
    const id = await f.batch();
    expect(
      (
        await f.upload(
          `batches/${id}/file-items`,
          recognitionPdf({
            info: { title: "Cancellable input", subject: "10.5555/cancel" },
          }),
        )
      ).status,
    ).toBe(200);
    const before = JSON.stringify(f.sql("SELECT * FROM metadata_observations"));
    expect(
      (await f.post(`batches/${id}/preview`)).result.recognition.state,
    ).toBe("running");
    await reached;
    expect((await f.post(`batches/${id}/confirm`)).code).toBe(
      "intake-recognition-pending",
    );
    expect(
      (await f.post(`batches/${id}/preview/cancel`)).result.recognition.state,
    ).toBe("cancelled");
    expect(cancelled).toBe(true);
    expect(JSON.stringify(f.sql("SELECT * FROM metadata_observations"))).toBe(
      before,
    );
    expect(f.sql("SELECT * FROM literatures")).toEqual([]);
    await f.ready(id);
    expect((await f.finish(id)).result.batch.result).toBe("completed");
  } finally {
    await f.close();
  }
}, 40000);
it("pairs relative paths, leaves unmatched PDFs out by default, and admits only an explicit include", async () => {
  const f = await fixture();
  try {
    const id = await f.batch("bibtex");
    expect(
      (
        await f.post(`batches/${id}/data`, {
          sequence: 0,
          data: "@article{one,title={Paired record},doi={10.5555/paired},file={:files/123/a.pdf:PDF}}",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.upload(
          `batches/${id}/file-items`,
          recognitionPdf(),
          "a.pdf",
          "Export/files/123/a.pdf",
        )
      ).status,
    ).toBe(200);
    const extra = await f.upload(
      `batches/${id}/file-items`,
      recognitionPdf({ info: { title: "Explicitly included" } }),
      "extra.pdf",
      "Export/extra.pdf",
    );
    expect(extra.status).toBe(200);
    await f.ready(id);
    const unpaired = await f.post(`batches/${id}/items`, { needs: "unpaired" });
    expect(unpaired.result.items).toHaveLength(1);
    expect(unpaired.result.items[0].item_id).toBe(extra.result.item.item_id);
    expect(
      (
        await f.post(
          `batches/${id}/items/${extra.result.item.item_id}/decide`,
          { decision: { kind: "include" } },
        )
      ).status,
    ).toBe(200);
    await f.ready(id);
    const report = await f.finish(id);
    expect(report.result.summary.records.created).toBe(2);
    expect(report.result.summary.files.missing).toBe(0);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 40000);
it("discards unmatched files by default and deletes staged candidates on cancellation or expiry", async () => {
  const f = await fixture();
  try {
    const id = await f.batch("records");
    const uploaded = await f.upload(
      `batches/${id}/file-items`,
      recognitionPdf(),
    );
    expect(uploaded.status).toBe(200);
    await f.ready(id);
    const report = await f.finish(id);
    expect(report.result.summary.records.created).toBe(0);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(0);
    await vi.waitFor(
      () => expect(f.sql("SELECT * FROM execution_candidates")).toHaveLength(0),
      { timeout: 20000 },
    );
    for (const expired of [false, true]) {
      const other = await f.batch();
      expect(
        (await f.upload(`batches/${other}/file-items`, recognitionPdf()))
          .status,
      ).toBe(200);
      const candidate = JSON.parse(
        String(
          f.sql("SELECT record_json FROM execution_candidates")[0]!.record_json,
        ),
      );
      if (expired) {
        f.advance();
        await f.app.importSessions.sweep();
      } else expect((await f.post(`batches/${other}/cancel`)).status).toBe(200);
      expect(f.sql("SELECT * FROM execution_candidates")).toHaveLength(0);
      await expect(
        stat(join(f.app.files.root, candidate.reference)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await f.post(`batches/${other}/status`)).result.batch.state).toBe(
        "cancelled",
      );
    }
  } finally {
    await f.close();
  }
}, 40000);
it("checks filename, relative paths, purpose and ownership, and reports non-PDF and encrypted file items", async () => {
  const f = await fixture();
  try {
    const id = await f.batch(),
      other = await f.pair(),
      read = await f.pair(["read"]);
    expect(
      (
        await f.upload(
          `batches/${id}/file-items`,
          recognitionPdf(),
          "a.pdf",
          null,
          other.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await f.upload(
          `batches/${id}/file-items`,
          recognitionPdf(),
          "a.pdf",
          null,
          read.token,
        )
      ).status,
    ).toBe(403);
    for (const path of [
      "/a.pdf",
      "x//a.pdf",
      "x/../a.pdf",
      "x/./a.pdf",
      "x\\a.pdf",
      "x/b.pdf",
      "x/" + "a".repeat(1024) + "/a.pdf",
    ])
      expect(
        (
          await f.upload(
            `batches/${id}/file-items`,
            recognitionPdf(),
            "a.pdf",
            path,
          )
        ).status,
      ).toBe(400);
    expect(
      (await f.upload(`batches/${id}/file-items`, Buffer.from("not a PDF")))
        .result.item.disposition,
    ).toBe("rejected");
    const encrypted = Buffer.from(
      Buffer.from(recognitionPdf())
        .toString()
        .replace("%%EOF", "/Encrypt 90 0 R\n%%EOF"),
    );
    expect(
      (await f.upload(`batches/${id}/file-items`, encrypted)).result.item
        .disposition,
    ).toBe("rejected");
    const report = await f.finish(id);
    expect(
      report.result.items.map((item: { reason: string }) => item.reason).sort(),
    ).toEqual(["encrypted-pdf", "non-pdf-file"]);
    expect(f.sql("SELECT * FROM execution_candidates")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 40000);
it("checks a PDF page's declared hash and size before recognition and leaves no literature or candidate on mismatch", async () => {
  const f = await fixture();
  try {
    for (const [descriptor, code] of [
      [{ sha256: "0".repeat(64) }, "intake-file-hash-mismatch"],
      [{ size_bytes: 1 }, "intake-file-size-mismatch"],
    ] as const) {
      const saved = await f.post("pages/save", {
        request_id: randomUUID(),
        page: { ...syntheticPage(), is_pdf: true },
        file: {
          file_name: "page.pdf",
          source_url: "https://synthetic.invalid/page.pdf",
          ...descriptor,
        },
      });
      expect(saved.status).toBe(200);
      expect(
        await f.upload(
          `batches/${saved.result.batch_id}/files/${saved.result.file.file_id}/bytes`,
          recognitionPdf(),
        ),
      ).toMatchObject({ status: 400, code });
      expect(f.sql("SELECT * FROM literatures")).toEqual([]);
      expect(f.sql("SELECT * FROM execution_candidates")).toEqual([]);
    }
  } finally {
    await f.close();
  }
}, 40000);
it("discards a PDF page upload revoked while recognition is pending, before any literature is admitted", async () => {
  let entered = false;
  const f = await fixture(
    new IntakeRecognitionService({
      lookup: async (_ids, signal) =>
        new Promise((_, reject) => {
          entered = true;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      search: async () => [],
    }),
  );
  try {
    const saved = await f.post("pages/save", {
      request_id: randomUUID(),
      page: { ...syntheticPage(), is_pdf: true },
      file: {
        file_name: "page.pdf",
        source_url: "https://synthetic.invalid/page.pdf",
      },
    });
    expect(saved.status).toBe(200);
    const uploaded = f.upload(
      `batches/${saved.result.batch_id}/files/${saved.result.file.file_id}/bytes`,
      recognitionPdf({
        info: {
          title: "A synthetic candidate article",
          subject: "10.5555/revoked",
        },
      }),
    );
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 20000 });
    await f.app.deviceConnections.revoke({ connection_id: f.connectionId });
    expect(await uploaded).toMatchObject({
      status: 401,
      code: "device-revoked",
    });
    await vi.waitFor(
      () => expect(f.sql("SELECT * FROM execution_candidates")).toEqual([]),
      { timeout: 20000 },
    );
    expect(f.sql("SELECT * FROM literatures")).toEqual([]);
  } finally {
    await f.close();
  }
}, 40000);
it("reports paired bytes as a file conflict when the stored primary differs or a declared size is wrong, without failing the accepted metadata", async () => {
  const f = await fixture();
  try {
    const saved = await f.post("pages/save", {
      request_id: randomUUID(),
      page: syntheticPage({
        title: "Existing paper",
        identifiers: [{ namespace: "doi", value: "10.5555/existing" }],
      }),
      file: {
        file_name: "original.pdf",
        source_url: "https://synthetic.invalid/original.pdf",
      },
    });
    expect(
      (
        await f.upload(
          `batches/${saved.result.batch_id}/files/${saved.result.file.file_id}/bytes`,
          recognitionPdf(),
        )
      ).status,
    ).toBe(200);
    const old = (await f.app.library.detail(saved.result.literature_id))
      .primary_pdf!.asset.sha256;
    for (const sizeMismatch of [false, true]) {
      const id = await f.batch("records");
      const metadata = {
        ...EMPTY_METADATA,
        title: sizeMismatch ? "Declared file size" : "Existing paper",
        identifiers: [
          {
            namespace: "doi",
            value: sizeMismatch ? "10.5555/size" : "10.5555/existing",
          },
        ],
      };
      expect(
        (
          await f.post(`batches/${id}/data`, {
            sequence: 0,
            data: {
              records: [
                {
                  external_id: "record",
                  metadata,
                  files: [
                    {
                      external_id: "files/a.pdf",
                      file_name: "a.pdf",
                      media_type: "application/pdf",
                      preferred: true,
                      ...(sizeMismatch ? { size_bytes: 1 } : {}),
                    },
                  ],
                },
              ],
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.upload(
            `batches/${id}/file-items`,
            recognitionPdf({ info: { title: "Different bytes" } }),
            "a.pdf",
            "files/a.pdf",
          )
        ).status,
      ).toBe(200);
      await f.ready(id);
      const report = await f.finish(id);
      expect(report.result.batch.result).toBe("partial");
      expect(report.result.summary.files.conflicts).toBe(1);
      expect(report.result.items[0].literature_id).not.toBeNull();
    }
    expect(
      (await f.app.library.detail(saved.result.literature_id)).primary_pdf!
        .asset.sha256,
    ).toBe(old);
  } finally {
    await f.close();
  }
}, 40000);
it("counts malformed JSON-LD in a captured page's batch report", async () => {
  const f = await fixture();
  try {
    const saved = await f.post("pages/save", {
      request_id: randomUUID(),
      page: {
        ...syntheticPage({ title: "Original tag title" }),
        json_ld: ["{"],
      },
    });
    expect(saved.status).toBe(200);
    expect(
      (await f.post(`batches/${saved.result.batch_id}/report`)).result.summary
        .excluded,
    ).toContainEqual({ kind: "invalid-json-ld", count: 1 });
  } finally {
    await f.close();
  }
}, 40000);
it("captures original tags and a PDF page, preserving only a scrubbed actual PDF address", async () => {
  const f = await fixture();
  try {
    const raw = syntheticPage({ title: "Original page" });
    const preview = await f.post("pages/preview", { page: raw });
    expect(preview).toMatchObject({
      status: 200,
      result: { metadata: { title: "Original page" } },
    });
    const page = {
      ...raw,
      is_pdf: true,
      url: "https://synthetic.invalid/original.pdf?context=synthetic-context",
      meta: [
        ...raw.meta,
        {
          attribute: "name",
          key: "private-context",
          content: "synthetic-not-retained",
        },
      ],
    };
    const request = {
      request_id: randomUUID(),
      page,
      file: {
        file_name: "page.pdf",
        source_url: "https://synthetic.invalid/actual.pdf?download=1#page=2",
      },
    };
    const saved = await f.post("pages/save", request);
    expect(saved).toMatchObject({
      status: 200,
      result: {
        literature_id: null,
        disposition: null,
        file: { literature_id: null, status: "pending" },
      },
    });
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(0);
    expect(
      JSON.stringify(f.sql("SELECT recognition_json FROM intake_items")),
    ).not.toMatch(/synthetic-context|synthetic-not-retained/u);
    const uploaded = await f.upload(
      `batches/${saved.result.batch_id}/files/${saved.result.file.file_id}/bytes`,
      recognitionPdf({ info: { title: "PDF page article" } }),
    );
    expect(uploaded).toMatchObject({
      status: 200,
      result: { file: { status: "uploaded" } },
    });
    const replay = await f.post("pages/save", request);
    expect(replay.result.literature_id).toBe(
      uploaded.result.file.literature_id,
    );
    expect(f.sql("SELECT source_url FROM literature_assets")).toEqual([
      { source_url: "https://synthetic.invalid/actual.pdf" },
    ]);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 40000);
