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

const duplicateTitle = "Solid electrolytes: a comprehensive review";
const duplicateRecord = (title = duplicateTitle) => ({
  title,
  author: [{ family: "Doe", given: "Jane" }],
  issued: { "date-parts": [[2020]] },
  type: "article-journal",
});
async function duplicateBatch(
  f: Awaited<ReturnType<typeof fixture>>,
  title = duplicateTitle,
) {
  const id = await f.batch("csl-json");
  expect(
    (
      await f.post(`batches/${id}/data`, {
        sequence: 0,
        data: JSON.stringify([duplicateRecord(title)]),
      })
    ).status,
  ).toBe(200);
  return id;
}
it("rechecks sequential HTTP records against an admitted predecessor without creating preview literature", async () => {
  const f = await fixture();
  try {
    const id = await f.batch("csl-json");
    expect(
      (
        await f.post(`batches/${id}/data`, {
          sequence: 0,
          data: JSON.stringify([
            duplicateRecord(),
            duplicateRecord(duplicateTitle + "s"),
          ]),
        })
      ).status,
    ).toBe(200);
    const preview = await f.post(`batches/${id}/preview`);
    expect(preview.result.summary.records).toMatchObject({
      created: 2,
      possible_duplicates: 0,
    });
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(0);
    expect(
      f.sql("SELECT * FROM intake_items WHERE origin='data'"),
    ).toHaveLength(2);
    const report = await f.finish(id);
    expect(report.result.summary.records).toMatchObject({
      created: 1,
      possible_duplicates: 1,
      pending_decision: 1,
    });
    const [first, second] = report.result.items;
    expect(first.disposition).toBe("created");
    expect(second).toMatchObject({
      disposition: "pending-decision",
      literature_id: null,
    });
    const items = (await f.post(`batches/${id}/items`, { needs: "decision" }))
      .result.items;
    expect(items).toHaveLength(1);
    expect(
      items[0].possible_duplicates.map(
        (c: { literature_id: string }) => c.literature_id,
      ),
    ).toEqual([first.literature_id]);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
it("audits and revises HTTP duplicate decisions before confirmation, preserving strict and identified matches", async () => {
  const f = await fixture();
  try {
    const first = await duplicateBatch(f);
    const original = (await f.finish(first)).result.items[0].literature_id;
    const second = await duplicateBatch(f, duplicateTitle + "s");
    expect(
      (await f.post(`batches/${second}/preview`)).result.summary.records
        .possible_duplicates,
    ).toBe(1);
    const item = (await f.post(`batches/${second}/items`)).result.items[0];
    const path = `batches/${second}/items/${item.item_id}/decide`;
    const other = await f.pair();
    expect(
      await f.post(path, { decision: { kind: "new" } }, other.token),
    ).toMatchObject({ status: 404, code: "intake-batch-missing" });
    expect(
      await f.post(path, {
        decision: { kind: "merge", literature_id: randomUUID() },
      }),
    ).toMatchObject({ status: 400, code: "intake-decision-invalid" });
    expect(
      (await f.post(path, { decision: { kind: "new" } })).result.item,
    ).toMatchObject({
      decision: { kind: "new" },
      decided_by: `device:${f.connectionId}`,
    });
    expect(
      (
        await f.post(path, {
          decision: { kind: "merge", literature_id: original },
        })
      ).result.item,
    ).toMatchObject({
      decision: { kind: "merge", literature_id: original },
      needs_decision: false,
    });
    expect((await f.finish(second)).result.items[0].literature_id).toBe(
      original,
    );
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(f.sql("SELECT * FROM metadata_observations").length).toBeGreaterThan(
      1,
    );
    const strict = await duplicateBatch(f);
    expect(
      (await f.post(`batches/${strict}/preview`)).result.summary.records,
    ).toMatchObject({ matched: 1, possible_duplicates: 0 });
    expect((await f.finish(strict)).result.items[0].literature_id).toBe(
      original,
    );
    const identified = await f.batch("csl-json");
    await f.post(`batches/${identified}/data`, {
      sequence: 0,
      data: JSON.stringify([
        { ...duplicateRecord(), DOI: "10.5555/identified-duplicate" },
      ]),
    });
    expect(
      (await f.post(`batches/${identified}/preview`)).result.summary.records
        .possible_duplicates,
    ).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);
it("resolves pending HTTP decisions in their original finished batch and expires undecided work after thirty days", async () => {
  const f = await fixture();
  try {
    const originalBatch = await duplicateBatch(f);
    const original = (await f.finish(originalBatch)).result.items[0]
      .literature_id;
    const merged = await duplicateBatch(f, duplicateTitle + "s");
    await f.finish(merged);
    const item = (await f.post(`batches/${merged}/items`)).result.items[0];
    const finished = (await f.post(`batches/${merged}/status`)).result.batch
      .finished_at;
    expect(
      (
        await f.post(`batches/${merged}/items/${item.item_id}/decide`, {
          decision: { kind: "merge", literature_id: original },
        })
      ).status,
    ).toBe(200);
    const report = (await f.post(`batches/${merged}/report`)).result;
    expect(report.batch).toMatchObject({
      batch_id: merged,
      state: "finished",
      result: "completed",
      finished_at: finished,
    });
    expect(report.summary.records.pending_decision).toBe(0);
    expect(report.items[0].literature_id).toBe(original);
    expect(
      f.sql(`SELECT * FROM intake_batch_members WHERE batch_id='${merged}'`),
    ).toHaveLength(1);
    const added = await duplicateBatch(
      f,
      duplicateTitle.replace("Solid", "Solud"),
    );
    await f.finish(added);
    const addItem = (await f.post(`batches/${added}/items`)).result.items[0];
    expect(
      (
        await f.post(`batches/${added}/items/${addItem.item_id}/decide`, {
          decision: { kind: "new" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.post(`batches/${added}/report`)).result.items[0].disposition,
    ).toBe("created");
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
    const expired = await duplicateBatch(
      f,
      duplicateTitle.replace("comprehensive", "comprehensiv"),
    );
    await f.finish(expired);
    const expireItem = (await f.post(`batches/${expired}/items`)).result
      .items[0];
    for (let i = 0; i < 4; i++) f.advance();
    await f.app.importSessions.sweep();
    expect(
      (await f.post(`batches/${expired}/report`)).result.items[0],
    ).toMatchObject({
      disposition: "pending-decision",
      reason: "decision-expired",
    });
    expect(
      f.sql(
        `SELECT recognition_json FROM intake_items WHERE item_id='${expireItem.item_id}'`,
      )[0]!.recognition_json,
    ).toBeNull();
    expect(
      (
        await f.post(`batches/${expired}/items/${expireItem.item_id}/decide`, {
          decision: { kind: "new" },
        })
      ).status,
    ).toBe(409);
    expect(f.sql("SELECT * FROM intake_batches")).toHaveLength(4);
    expect(f.sql("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
it("requires a listed duplicate decision for single-page HTTP capture, with stable replay and explicit new", async () => {
  const f = await fixture();
  try {
    const batch = await duplicateBatch(f);
    const original = (await f.finish(batch)).result.items[0].literature_id;
    const page = syntheticPage({
      title: duplicateTitle + "s",
      publication_year: 2020,
      authors: [
        {
          kind: "person",
          display_name: "Jane Doe",
          given_name: "Jane",
          family_name: "Doe",
          orcid: null,
          affiliations: [],
        },
      ],
    });
    const preview = await f.post("pages/preview", { page });
    expect(preview.result.possible_duplicates).toMatchObject([
      { literature_id: original },
    ]);
    const request = {
      request_id: randomUUID(),
      page,
      folder_ids: [],
      file: null,
    };
    expect(await f.post("pages/save", request)).toMatchObject({
      status: 409,
      code: "intake-decision-required",
    });
    expect(f.sql("SELECT * FROM intake_page_requests")).toEqual([]);
    expect(
      await f.post("pages/save", {
        ...request,
        duplicate_decision: { kind: "merge", literature_id: randomUUID() },
      }),
    ).toMatchObject({ status: 400, code: "intake-decision-invalid" });
    const merge = {
      ...request,
      duplicate_decision: { kind: "merge", literature_id: original },
    };
    const saved = await f.post("pages/save", merge);
    expect(saved.status).toBe(200);
    expect(saved.result.literature_id).toBe(original);
    await vi.waitFor(
      async () =>
        expect((await f.post("pages/save", merge)).result.metadata.status).toBe(
          "partial",
        ),
      { timeout: 20000 },
    );
    const settled = (await f.post("pages/save", merge)).result;
    expect((await f.post("pages/save", merge)).result).toEqual(settled);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    const added = await f.post("pages/save", {
      ...request,
      request_id: randomUUID(),
      page: {
        ...page,
        meta: page.meta.map((m) =>
          m.key === "citation_title"
            ? { ...m, content: duplicateTitle.replace("Solid", "Solud") }
            : m,
        ),
      },
      duplicate_decision: { kind: "new" },
    });
    expect(added.status).toBe(200);
    expect(added.result.disposition).toBe("created");
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
    expect(
      f.sql(
        "SELECT decided_by,decided_at FROM intake_items WHERE origin='page'",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decided_by: `device:${f.connectionId}`,
          decided_at: expect.any(String),
        }),
      ]),
    );
  } finally {
    await f.close();
  }
}, 30000);
it("retains undecided PDF bytes, admits an explicit new decision in the original batch and discards expired bytes", async () => {
  const f = await fixture();
  try {
    const first = await f.batch();
    const title = "Solid electrolytes and molecular transport review";
    await f.upload(
      `batches/${first}/file-items`,
      recognitionPdf({ info: { title } }),
    );
    await f.ready(first);
    await f.finish(first);
    const pending = await f.batch();
    await f.upload(
      `batches/${pending}/file-items`,
      recognitionPdf({ info: { title: title + "s" } }),
    );
    await f.ready(pending);
    expect(
      (await f.post(`batches/${pending}/preview`)).result.summary.records
        .possible_duplicates,
    ).toBe(1);
    expect(
      (await f.finish(pending)).result.summary.records.pending_decision,
    ).toBe(1);
    const item = (await f.post(`batches/${pending}/items`)).result.items[0];
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(1);
    expect(
      (
        await f.post(`batches/${pending}/items/${item.item_id}/decide`, {
          decision: { kind: "new" },
        })
      ).status,
    ).toBe(200);
    const report = (await f.post(`batches/${pending}/report`)).result;
    expect(report.batch.result).toBe("completed");
    expect(report.items[0].disposition).toBe("created");
    expect(
      f.sql("SELECT * FROM literature_assets WHERE role='primary-pdf'"),
    ).toHaveLength(2);
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(0);
    const expired = await f.batch();
    await f.upload(
      `batches/${expired}/file-items`,
      recognitionPdf({ info: { title: title.replace("Solid", "Solud") } }),
    );
    await f.ready(expired);
    await f.finish(expired);
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(1);
    for (let i = 0; i < 4; i++) f.advance();
    await f.app.importSessions.sweep();
    expect(
      (await f.post(`batches/${expired}/report`)).result.items[0].reason,
    ).toBe("decision-expired");
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(0);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
    expect(f.sql("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
it("preserves different same-title papers and source-library matching without fuzzy decisions", async () => {
  const f = await fixture();
  try {
    const id = await f.batch("csl-json");
    await f.post(`batches/${id}/data`, {
      sequence: 0,
      data: JSON.stringify([
        {
          ...duplicateRecord("Introduction"),
          author: [{ family: "Alpha", given: "Alice" }],
        },
        {
          ...duplicateRecord("Introduction"),
          author: [{ family: "Beta", given: "Bob" }],
        },
      ]),
    });
    expect((await f.finish(id)).result.summary.records).toMatchObject({
      created: 2,
      possible_duplicates: 0,
    });
    const original = (await f.sql("SELECT literature_id FROM literatures"))[0]!
      .literature_id;
    expect(original).toBeTypeOf("string");
    const library = {
      system: "synthetic",
      library_id: "stable-library",
      identity: "global",
      name: "Synthetic",
    };
    for (const title of [duplicateTitle, duplicateTitle + "s"]) {
      const created = await f.post("batches", {
        format: "records",
        source: library,
        scope: "Synthetic source library",
      });
      const batch = created.result.batch.batch_id;
      await f.post(`batches/${batch}/data`, {
        sequence: 0,
        data: {
          records: [
            {
              external_id: "same-record",
              metadata: { ...EMPTY_METADATA, title },
              source_type: null,
              groups: [],
              user_tags: [],
              annotations: [],
              files: [],
            },
          ],
          groups: [],
        },
      });
      expect(
        (await f.post(`batches/${batch}/preview`)).result.summary.records
          .possible_duplicates,
      ).toBe(0);
      await f.finish(batch);
    }
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(3);
    expect(
      f.sql(
        "SELECT * FROM external_object_mappings WHERE object_kind='record'",
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
it("recovers a late new decision after its identity commits but its original-report checkpoint fails", async () => {
  const f = await fixture();
  try {
    await f.finish(await duplicateBatch(f));
    const id = await duplicateBatch(f, duplicateTitle + "s");
    await f.finish(id);
    const item = (await f.post(`batches/${id}/items`)).result.items[0];
    const run = f.app.database.run.bind(f.app.database);
    let interrupted = false;
    const spy = vi
      .spyOn(f.app.database, "run")
      .mockImplementation(async (command, ...rest) => {
        if (
          !interrupted &&
          command.kind === "import_write" &&
          command.action.op === "resolve-result"
        ) {
          interrupted = true;
          throw new Error("Synthetic late decision checkpoint failure");
        }
        return run(command, ...rest);
      });
    try {
      await expect(
        f.app.importSessions.decide(
          id,
          item.item_id,
          { kind: "new" },
          { kind: "local", origin: "mcp" },
        ),
      ).rejects.toThrow("Synthetic late decision checkpoint failure");
    } finally {
      spy.mockRestore();
    }
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
    expect(
      (await f.post(`batches/${id}/report`)).result.items[0].disposition,
    ).toBe("pending-decision");
    const audit = (await f.post(`batches/${id}/items/${item.item_id}/status`))
      .result.item;
    const result = await f.app.importSessions.decide(
      id,
      item.item_id,
      { kind: "new" },
      { kind: "local", origin: "mcp" },
    );
    expect(result).toMatchObject({
      disposition: "created",
      decided_by: "mcp",
      decided_at: audit.decided_at,
    });
    expect((await f.post(`batches/${id}/report`)).result.batch.result).toBe(
      "completed",
    );
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
    expect(
      f.sql(`SELECT * FROM intake_batch_members WHERE batch_id='${id}'`),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
it("applies the same explicit duplicate choice to PDF-page preview, save and byte admission", async () => {
  const f = await fixture();
  try {
    const original = (await f.finish(await duplicateBatch(f))).result.items[0]
      .literature_id;
    const title = duplicateTitle + "s";
    const page = { ...syntheticPage({ title }), is_pdf: true };
    expect(
      (await f.post("pages/preview", { page })).result.possible_duplicates,
    ).toMatchObject([{ literature_id: original }]);
    const data = recognitionPdf({ info: { title } });
    const request = {
      request_id: randomUUID(),
      page,
      folder_ids: [],
      file: {
        file_name: "Synthetic.pdf",
        size_bytes: data.byteLength,
        sha256: null,
        source_url: "https://synthetic.invalid/paper.pdf",
      },
    };
    expect(await f.post("pages/save", request)).toMatchObject({
      status: 409,
      code: "intake-decision-required",
    });
    const saved = await f.post("pages/save", {
      ...request,
      duplicate_decision: { kind: "merge", literature_id: original },
    });
    expect(saved.status).toBe(200);
    expect(
      (
        await f.upload(
          `batches/${saved.result.batch_id}/files/${saved.result.file.file_id}/bytes`,
          data,
        )
      ).status,
    ).toBe(200);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(
      f.sql("SELECT * FROM literature_assets WHERE role='primary-pdf'"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
it("refuses a newly discovered PDF-page duplicate before writing facts and accepts a new explicit request", async () => {
  const f = await fixture();
  try {
    await f.finish(await duplicateBatch(f));
    const title = duplicateTitle + "s";
    const data = recognitionPdf({ info: { title } });
    const request = {
      request_id: randomUUID(),
      page: { ...syntheticPage(), is_pdf: true },
      folder_ids: [],
      file: {
        file_name: "Untitled.pdf",
        size_bytes: data.byteLength,
        sha256: null,
        source_url: "https://synthetic.invalid/paper.pdf",
      },
    };
    const saved = await f.post("pages/save", request);
    expect(saved.status).toBe(200);
    expect(
      await f.upload(
        `batches/${saved.result.batch_id}/files/${saved.result.file.file_id}/bytes`,
        data,
      ),
    ).toMatchObject({ status: 409, code: "intake-decision-required" });
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(0);
    const explicit = await f.post("pages/save", {
      ...request,
      request_id: randomUUID(),
      duplicate_decision: { kind: "new" },
    });
    expect(
      (
        await f.upload(
          `batches/${explicit.result.batch_id}/files/${explicit.result.file.file_id}/bytes`,
          data,
        )
      ).status,
    ).toBe(200);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 30000);
it("keeps a paired PDF with pending metadata and attaches it when a late decision creates the literature", async () => {
  const f = await fixture();
  try {
    await f.finish(await duplicateBatch(f));
    const id = await f.batch("records");
    const bytes = recognitionPdf({ info: { title: "Synthetic paired bytes" } });
    await f.post(`batches/${id}/data`, {
      sequence: 0,
      data: {
        records: [
          {
            external_id: "paired-paper",
            metadata: {
              ...EMPTY_METADATA,
              title: duplicateTitle + "s",
              authors: [
                {
                  kind: "person",
                  display_name: "Jane Doe",
                  given_name: "Jane",
                  family_name: "Doe",
                  orcid: null,
                  affiliations: [],
                },
              ],
              publication_year: 2020,
              publication_form: "journal-article",
            },
            source_type: null,
            groups: [],
            user_tags: [],
            annotations: [],
            files: [
              {
                external_id: "folder/paper.pdf",
                file_name: "paper.pdf",
                media_type: "application/pdf",
                preferred: true,
                size_bytes: bytes.byteLength,
                sha256: null,
              },
            ],
          },
        ],
        groups: [],
      },
    });
    expect(
      (
        await f.upload(
          `batches/${id}/file-items`,
          bytes,
          "paper.pdf",
          "folder/paper.pdf",
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.post(`batches/${id}/preview`)).result.summary.records
        .possible_duplicates,
    ).toBe(1);
    await f.finish(id);
    const [item] = (await f.post(`batches/${id}/items`, { needs: "decision" }))
      .result.items;
    expect(item.origin).toBe("data");
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(1);
    expect(
      (
        await f.post(`batches/${id}/items/${item.item_id}/decide`, {
          decision: { kind: "new" },
        })
      ).status,
    ).toBe(200);
    const report = (await f.post(`batches/${id}/report`)).result;
    expect(report.batch.result).toBe("completed");
    expect(report.summary.files.uploaded).toBe(1);
    expect(
      f.sql(
        "SELECT * FROM execution_candidates WHERE transfer_id LIKE 'intake-%'",
      ),
    ).toHaveLength(0);
    expect(
      f.sql(
        `SELECT * FROM literature_assets WHERE literature_id='${report.items[0].literature_id}' AND role='primary-pdf'`,
      ),
    ).toHaveLength(1);
    expect(f.sql("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
it("allows a decided finished item to receive its missing PDF and clears its temporary record after settlement", async () => {
  const f = await fixture();
  try {
    await f.finish(await duplicateBatch(f));
    const id = await f.batch("bibtex");
    const text = `@article{k,title={${duplicateTitle}s},author={Doe, Jane},year={2020},journal={J},file={Full Text PDF:paper.pdf:application/pdf}}`;
    await f.post(`batches/${id}/data`, { sequence: 0, data: text });
    await f.finish(id);
    const item = (await f.post(`batches/${id}/items`, { needs: "decision" }))
      .result.items[0];
    expect(
      (
        await f.post(`batches/${id}/items/${item.item_id}/decide`, {
          decision: { kind: "new" },
        })
      ).status,
    ).toBe(200);
    const [file] = (await f.post(`batches/${id}/files`, { pending: true }))
      .result.items;
    expect(file.status).toBe("pending");
    expect(
      (
        await f.upload(
          `batches/${id}/files/${file.file_id}/bytes`,
          recognitionPdf(),
        )
      ).status,
    ).toBe(200);
    expect((await f.post(`batches/${id}/report`)).result.batch.result).toBe(
      "completed",
    );
    expect(
      f.sql(
        `SELECT recognition_json FROM intake_items WHERE item_id='${item.item_id}'`,
      )[0]!.recognition_json,
    ).toBeNull();
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 30000);
it("clears materialized work after a failed background admission without undoing its accepted identity", async () => {
  const f = await fixture();
  try {
    const id = await f.batch("csl-json");
    await f.post(`batches/${id}/data`, {
      sequence: 0,
      data: JSON.stringify([
        { title: "Accepted before failure", DOI: "10.5555/before-failure" },
        { title: "Never processed", DOI: "10.5555/not-processed" },
      ]),
    });
    const run = f.app.database.run.bind(f.app.database);
    const spy = vi
      .spyOn(f.app.database, "run")
      .mockImplementation(async (command, ...rest) => {
        if (command.kind === "import_write" && command.action.op === "result")
          throw new Error("Synthetic failed record checkpoint");
        return run(command, ...rest);
      });
    try {
      expect((await f.finish(id)).result.batch.result).toBe("failed");
      await vi.waitFor(
        () =>
          expect(
            f.sql(
              `SELECT recognition_json FROM intake_items WHERE batch_id='${id}'`,
            ),
          ).toEqual([{ recognition_json: null }, { recognition_json: null }]),
        { timeout: 20000 },
      );
    } finally {
      spy.mockRestore();
    }
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(f.sql("SELECT * FROM import_parts")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30000);
it("does not automatically admit concurrent similar page saves before a duplicate decision", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        f.post("pages/save", {
          request_id: randomUUID(),
          page: syntheticPage({
            title: `Solid electrolytes and molecular transport review ${i}`,
          }),
          folder_ids: [],
          file: null,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 409, 409, 409, 409, 409, 409, 409,
    ]);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.code === "intake-decision-required"),
    ).toBe(true);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(f.sql("SELECT * FROM intake_page_requests")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
