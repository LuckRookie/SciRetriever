import { syntheticCaptureRequest } from "./intake-page-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type DevicePurpose,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
async function fixture(failing = false) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-capture-"));
  let now = new Date(2026, 10, 10, 23, 59).getTime(),
    calls = 0;
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false, now: () => now },
    capture: { now: () => now },
    metadata: {
      lookup_ports: [
        {
          provider_name: "crossref",
          open_lookup(key) {
            calls++;
            if (failing) throw new Error("Synthetic metadata unavailable");
            let sent = false;
            return {
              pull_raw_item: () =>
                sent
                  ? null
                  : ((sent = true),
                    { raw_item: {}, source_exhausted_after: true }),
              convert_raw_item: () => ({
                relations: [],
                observations: [
                  parseMetadataObservation({
                    observation_id: randomUUID(),
                    provenance: {
                      provenance_id: randomUUID(),
                      source_kind: "metadata-provider",
                      source_name: "crossref",
                      source_record_id: JSON.stringify(key.identifiers),
                      observed_at: new Date(now).toISOString(),
                      input_sha256: "a".repeat(64),
                      parameters_sha256: null,
                    },
                    metadata: {
                      ...EMPTY_METADATA,
                      title: "Provider title",
                      abstract: "Provider abstract",
                      identifiers: key.identifiers,
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
                  }),
                ],
              }),
            };
          },
        },
      ],
    },
  });
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    assets: new Map([
      ["/", { contentType: "text/html", body: "fixture" }],
      ["/auth", { contentType: "text/html", body: "login" }],
    ]),
    access: workbenchTestAccess,
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app, undefined, pathToFileURL(home + "/")),
    },
  });
  const pair = async (purposes: DevicePurpose[] = ["intake"]) => {
    const pairing = await app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic capture",
      purposes,
    });
    const exchanged = await app.deviceConnections.exchange(
      { pairing_code: pairing.connection_code.split(":")[2] },
      randomUUID(),
    );
    return {
      token: exchanged.token,
      connection_id: exchanged.connection.connection_id,
    };
  };
  const send = (
    token: string,
    path: string,
    request: unknown = {},
    contentType = "application/json",
  ) =>
    fetch(server.origin + "/api/v1/intake/" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "chrome-extension://synthetic",
        "Content-Type": contentType,
        "X-Sciretriever-Protocol-Version": "1",
      },
      body: JSON.stringify({
        protocol_version: 1,
        request: path.startsWith("pages/")
          ? syntheticCaptureRequest(request)
          : request,
      }),
    });
  const call = async (
    token: string,
    path: string,
    request: unknown = {},
    contentType = "application/json",
  ) => {
    const response = await send(token, path, request, contentType);
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value.result;
  };
  const sql = (query: string) => {
    const db = new DatabaseSync(join(home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      return db.prepare(query).all();
    } finally {
      db.close();
    }
  };
  return {
    home,
    app,
    server,
    pair,
    send,
    call,
    sql,
    setNow: (value: number) => {
      now = value;
    },
    calls: () => calls,
    async close() {
      await server.close();
      await session.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function request(doi = "10.5555/captured", file = true) {
  return {
    request_id: randomUUID(),
    metadata: {
      title: "Captured page title",
      authors: [
        {
          kind: "person",
          display_name: "Ada Example",
          given_name: "Ada",
          family_name: "Example",
          orcid: null,
          affiliations: [],
        },
      ],
      identifiers: [{ namespace: "doi", value: doi }],
      keywords: ["Page keyword"],
    },
    ...(file ? { file: { file_name: "paper.pdf" } } : {}),
  };
}
async function* chunks(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i += 1024)
    yield bytes.subarray(i, i + 1024);
}
it("admits only intake purposes, binds captures to the originating device and never persists or logs tokens", async () => {
  const f = await fixture();
  const logs: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  try {
    const owner = await f.pair(),
      other = await f.pair();
    for (const purpose of ["read", "operate"] as const) {
      const wrong = await f.pair([purpose]);
      for (const path of [
        "pages/preview",
        "pages/save",
        "batches/00000000-0000-4000-8000-000000000001/status",
        "batches/00000000-0000-4000-8000-000000000001/files/00000000-0000-4000-8000-000000000002/hash",
        "batches/00000000-0000-4000-8000-000000000001/files/00000000-0000-4000-8000-000000000002/bytes",
      ])
        expect((await f.send(wrong.token, path, {})).status).toBe(403);
      expect(
        (
          await fetch(f.server.origin + "/api/v1/intake/extension", {
            headers: { Authorization: `Bearer ${wrong.token}` },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await fetch(f.server.origin + "/api/v1/intake/pages/save", {
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.send(owner.token, "pages/save", {
          request_id: randomUUID(),
          metadata: {},
        })
      ).status,
    ).toBe(400);
    expect(f.sql("SELECT * FROM intake_page_requests")).toEqual([]);
    const arxiv = await f.call(owner.token, "pages/save", {
      request_id: randomUUID(),
      metadata: {
        identifiers: [{ namespace: "arxiv", value: "2601.12345v2" }],
      },
    });
    expect(
      await f.call(owner.token, "pages/preview", {
        metadata: {
          identifiers: [{ namespace: "arxiv", value: "2601.12345" }],
        },
      }),
    ).toMatchObject({ found: true, literature_id: arxiv.literature_id });
    const saved = await f.call(owner.token, "pages/save", request());
    expect(
      (await f.send(other.token, `batches/${saved.batch_id}/status`)).status,
    ).toBe(404);
    expect(
      (
        await f.send(
          other.token,
          `batches/${saved.batch_id}/files/${saved.file.file_id}/hash`,
          {
            sha256: "a".repeat(64),
          },
        )
      ).status,
    ).toBe(404);
    for (const path of [
      "/api/v1/import/sessions/list",
      "/api/clients",
      "/api/v1/device-connections",
      "/api/configuration/read",
    ])
      expect(
        (
          await fetch(f.server.origin + path, {
            method: "POST",
            headers: { Authorization: `Bearer ${owner.token}` },
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await fetch(
          f.server.origin +
            "/api/v1/intake/lookup?token=" +
            encodeURIComponent(owner.token),
          { headers: { Authorization: `Bearer ${owner.token}` } },
        )
      ).status,
    ).toBe(400);
    const persisted =
      JSON.stringify(f.sql("SELECT * FROM intake_page_requests")) +
      JSON.stringify(f.sql("SELECT * FROM device_connections")) +
      JSON.stringify(f.sql("SELECT * FROM metadata_observations"));
    expect(persisted).not.toContain(owner.token);
    expect(JSON.stringify(saved)).not.toContain(owner.token);
    expect(logs.join("")).not.toContain(owner.token);
    await f.app.deviceConnections.revoke({
      connection_id: owner.connection_id,
    });
    expect(
      (await f.send(owner.token, `batches/${saved.batch_id}/status`)).status,
    ).toBe(401);
  } finally {
    spy.mockRestore();
    await f.close();
  }
}, 30000);
it("saves page provenance, uses the existing metadata task, merges concurrent retries and groups server-local days per device", async () => {
  const f = await fixture();
  try {
    const actor = await f.pair(),
      other = await f.pair();
    const folder = (await f.app.folders.manage({
      operation: "create",
      request: { name: "Chosen", parent_id: null, position: null },
    })) as { folder_id: string };
    const r = {
      ...request(undefined, false),
      folder_ids: [folder.folder_id, "00000000-0000-4000-8000-000000000007"],
    };
    const before = await f.call(actor.token, "pages/preview", {
      metadata: r.metadata,
    });
    expect(before.found).toBe(false);

    const [a, b] = await Promise.all([
      f.call(actor.token, "pages/save", r),
      f.call(actor.token, "pages/save", r),
    ]);
    expect(a).toEqual(b);
    expect(a.missing_folder_ids).toEqual([
      "00000000-0000-4000-8000-000000000007",
    ]);
    expect(f.calls()).toBe(1);
    expect(a.metadata).toMatchObject({
      status: "completed",
      job_id: expect.any(String),
    });
    const detail = await f.app.library.detail(a.literature_id);
    expect(detail.literature.metadata).toMatchObject({
      title: "Captured page title",
      abstract: "Provider abstract",
    });
    expect(
      detail.metadata_observations.filter(
        (o) => o.provenance.source_name === "web-capture",
      ),
    ).toHaveLength(1);
    expect(
      detail.metadata_observations.find(
        (o) => o.provenance.source_name === "web-capture",
      )!.metadata.abstract,
    ).toBeNull();
    expect(f.sql("SELECT * FROM folder_members")).toHaveLength(1);
    expect(
      await f.call(actor.token, "pages/preview", {
        metadata: r.metadata,
      }),
    ).toMatchObject({
      found: true,
      literature_id: a.literature_id,
      has_pdf: false,
    });
    expect(
      (
        await f.send(actor.token, "pages/save", {
          ...r,
          metadata: { ...r.metadata, title: "Changed" },
        })
      ).status,
    ).toBe(409);
    await executeMaintenance(f.app, "intake-batch-rename", {
      batch_id: a.batch_id,
      label: "Renamed day",
    });
    const sameDay = await f.call(
      actor.token,
      "pages/save",
      request("10.5555/second", false),
    );
    expect(sameDay.batch_id).toBe(a.batch_id);
    const batch = await f.app.library.intakeBatches({
      operation: "get",
      request: { batch_id: a.batch_id },
    });
    expect(batch).toMatchObject({
      label: "Renamed day",
      state: "running",
      result: null,
      confirmation: "per-item",
      counts: { hits: 2, created: 2 },
    });
    expect(
      (await f.call(other.token, "pages/save", request("10.5555/third", false)))
        .batch_id,
    ).not.toBe(a.batch_id);
    f.setNow(new Date(2026, 10, 11, 0, 1).getTime());
    expect((await f.call(actor.token, "pages/save", r)).batch_id).toBe(
      a.batch_id,
    );
    expect(f.calls()).toBe(3);
    const next = await f.call(
      actor.token,
      "pages/save",
      request("10.5555/fourth", false),
    );
    expect(next.batch_id).not.toBe(a.batch_id);
    expect(f.sql("SELECT * FROM intake_open_batches")).toHaveLength(3);
    await f.app.importSessions.sweep();
    expect(await f.app.importSessions.status(a.batch_id)).toMatchObject({
      state: "finished",
      result: "completed",
    });
    expect(await f.app.importSessions.status(next.batch_id)).toMatchObject({
      state: "running",
      result: null,
    });
  } finally {
    await f.close();
  }
}, 30000);
it("recovers a committed identity and its original batch classification after the capture checkpoint is interrupted", async () => {
  const f = await fixture();
  try {
    const actor = await f.pair(),
      value = request("10.5555/checkpoint", false);
    const original = f.app.database.run.bind(f.app.database);
    let interrupt = true;
    const spy = vi
      .spyOn(f.app.database, "run")
      .mockImplementation(async (command, signal) => {
        if (
          interrupt &&
          command.kind === "capture_write" &&
          command.action.op === "accepted"
        ) {
          interrupt = false;
          throw new Error("Synthetic capture checkpoint interruption");
        }
        return original(command, signal);
      });
    await expect(
      f.app.capture.save(actor.connection_id, syntheticCaptureRequest(value)),
    ).rejects.toThrow("Synthetic capture checkpoint interruption");
    spy.mockRestore();
    expect(f.sql("SELECT disposition FROM intake_batch_members")).toEqual([
      { disposition: "created" },
    ]);
    const result = await f.call(actor.token, "pages/save", value);
    expect(result.disposition).toBe("created");
    expect(f.calls()).toBe(1);
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(
      await f.app.library.intakeBatches({
        operation: "get",
        request: { batch_id: result.batch_id },
      }),
    ).toMatchObject({ counts: { hits: 1, created: 1, matched: 0 } });
  } finally {
    await f.close();
  }
}, 30000);

it("streams valid unverified PDFs through the shared import channel and never replaces an existing primary PDF", async () => {
  const f = await fixture();
  try {
    const actor = await f.pair(),
      first = await f.call(
        actor.token,
        "pages/save",
        request(),
        "Application/JSON; CHARSET=UTF-8",
      );
    expect(first.file.action).toBe("upload");
    const bytes = workbenchPdf(),
      sha = createHash("sha256").update(bytes).digest("hex");
    for (const contentType of [
      "application/json; charset=gbk",
      "application/json; foo=bar",
    ]) {
      const response = await f.send(
        actor.token,
        "pages/preview",
        { metadata: request().metadata },
        contentType,
      );
      expect(response.status).toBe(415);
      expect((await response.json()).code).toBe("content-type-unsupported");
    }
    for (const contentType of [
      "text/plain",
      "application/pdf; charset=utf-8",
      "application/octet-stream; foo=bar",
    ]) {
      const response = await fetch(
        `${f.server.origin}/api/v1/intake/batches/${first.batch_id}/files/${first.file.file_id}/bytes`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${actor.token}`,
            "Content-Type": contentType,
            "X-Sciretriever-Protocol-Version": "1",
          },
          body: Buffer.from(bytes),
        },
      );
      expect(response.status).toBe(415);
      expect((await response.json()).code).toBe("content-type-unsupported");
    }
    const invalid = await fetch(
      `${f.server.origin}/api/v1/intake/batches/${first.batch_id}/files/${first.file.file_id}/bytes`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.token}`,
          "Content-Type": "application/pdf",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body: Buffer.from("not a PDF"),
      },
    );
    expect(invalid.status).toBe(422);
    const delivery = await fetch(
      `${f.server.origin}/api/v1/intake/batches/${first.batch_id}/files/${first.file.file_id}/bytes`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.token}`,
          "Content-Type": "Application/Octet-Stream",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body: Buffer.from(bytes),
      },
    );
    expect(delivery.status).toBe(200);
    const uploaded = (await delivery.json()).result.file;
    expect(uploaded.status).toBe("uploaded");
    expect(
      (
        await f.app.importSessions.upload(
          first.batch_id,
          first.file.file_id,
          chunks(bytes),
        )
      ).sha256,
    ).toBe(sha);
    const detail = await f.app.library.detail(first.literature_id),
      asset = detail.primary_pdf!.asset.asset_id;
    expect(detail.primary_pdf!.article_identity_status).toBe("unverified");
    expect(detail.primary_pdf!.literature_asset.provenance.source_name).toBe(
      "web-capture",
    );
    expect(detail.primary_pdf!.literature_asset.provenance).toMatchObject({
      source_kind: "user",
      source_record_id: null,
      input_sha256: sha,
    });
    const receipt = f.sql(
      "SELECT intent_json FROM execution_receipts WHERE json_extract(intent_json,'$.literature_id')='" +
        first.literature_id +
        "'",
    );
    expect(receipt).toHaveLength(1);
    expect(JSON.parse(String(receipt[0]!.intent_json)).source_url).toBe(
      "https://synthetic.invalid/download/paper.pdf",
    );
    const repeat = await f.call(actor.token, "pages/save", request());
    expect(
      (
        await f.app.library.detail(first.literature_id)
      ).metadata_observations.filter(
        (o) => o.provenance.source_name === "web-capture",
      ),
    ).toHaveLength(1);
    expect(repeat.file.action).toBe("hash");
    expect(
      (
        await f.call(
          actor.token,
          `batches/${repeat.batch_id}/files/${repeat.file.file_id}/hash`,
          {
            sha256: "b".repeat(64),
          },
        )
      ).file.status,
    ).toBe("conflict");
    expect(
      (await f.app.library.detail(first.literature_id)).primary_pdf!.asset
        .asset_id,
    ).toBe(asset);
    const again = await f.call(actor.token, "pages/save", request());
    expect(
      (
        await f.call(
          actor.token,
          `batches/${again.batch_id}/files/${again.file.file_id}/hash`,
          {
            sha256: sha,
          },
        )
      ).file.status,
    ).toBe("existing");
    const fresh = await f.call(
      actor.token,
      "pages/save",
      request("10.5555/cancelled"),
    );
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>((r) => {
      reading = r;
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        reading();
        await new Promise<void>(() => {});
        yield bytes;
      },
    };
    const pending = f.app.importSessions.upload(
      fresh.batch_id,
      fresh.file.file_id,
      stream,
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "intake-upload-cancelled",
    });
    expect(
      (await f.app.library.detail(fresh.literature_id)).primary_pdf,
    ).toBeNull();
  } finally {
    await f.close();
  }
}, 30000);
it("keeps captured facts when metadata fails and serves the fixed extension artifact to capture devices or authenticated Web", async () => {
  const f = await fixture(true);
  try {
    const actor = await f.pair(),
      r = await f.call(actor.token, "pages/save", request(undefined, false));
    expect(r.metadata.status).toBe("failed");
    expect(
      (await f.app.library.detail(r.literature_id)).literature.metadata.title,
    ).toBe("Captured page title");
    const url = f.server.origin + "/api/v1/intake/extension",
      device = { Authorization: `Bearer ${actor.token}` };
    expect((await fetch(url, { headers: device })).status).toBe(503);
    await writeFile(
      join(f.home, "browser-extension.zip"),
      Buffer.from([80, 75, 3, 4]),
    );
    const response = await fetch(url, { headers: device });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const login = await workbenchLogin(f.server.origin),
      root = await fetch(f.server.origin, { headers: { Cookie: login } }),
      cookie =
        login +
        "; " +
        root.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; ");
    const grant = await (
      await fetch(f.server.origin + "/api/clients", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: f.server.origin,
          "X-Workbench-Init": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).json();
    expect(
      (
        await fetch(url + "?client_id=" + grant.client_id, {
          headers: { Cookie: cookie, Origin: f.server.origin },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(url + "?client_id=" + grant.client_id, {
          headers: { Cookie: cookie, Origin: "https://outside.invalid" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url)).status).toBe(401);
    expect(
      (
        await fetch(url + "?client_id=" + grant.client_id, {
          headers: {
            Cookie: cookie,
            Authorization: "Bearer invalid",
            Origin: f.server.origin,
          },
        })
      ).status,
    ).toBe(400);
    await rm(join(f.home, "browser-extension.zip"));
    await symlink(
      join(f.home, "catalog.sqlite"),
      join(f.home, "browser-extension.zip"),
    );
    expect((await fetch(url, { headers: device })).status).toBe(503);
    await rm(join(f.home, "browser-extension.zip"));
    await writeFile(
      join(f.home, "browser-extension.zip"),
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );
    expect((await fetch(url, { headers: device })).status).toBe(503);
  } finally {
    await f.close();
  }
}, 30000);

it("saves a title-only page into the shared open batch and rejects an empty item", async () => {
  const f = await fixture();
  try {
    const actor = await f.pair();
    const empty = await f.send(actor.token, "pages/save", {
      request_id: randomUUID(),
      metadata: {},
    });
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe("intake-item-empty");
    const preview = await f.call(actor.token, "pages/preview", {
      metadata: { title: "A title without identifiers" },
    });
    expect(preview).toMatchObject({
      found: false,
      metadata: { title: "A title without identifiers", identifiers: [] },
      has_pdf: false,
      pdf_url: null,
      possible_duplicates: [],
    });
    expect(preview).not.toHaveProperty("sha256");
    expect(f.sql("SELECT * FROM intake_batches")).toEqual([]);
    const input = {
      request_id: randomUUID(),
      metadata: { title: "A title without identifiers" },
    };
    const saved = await f.call(actor.token, "pages/save", input);
    expect(saved).toMatchObject({
      item_id: expect.any(String),
      batch_id: expect.any(String),
      literature_id: expect.any(String),
      disposition: "created",
    });
    expect(
      (await f.app.library.detail(saved.literature_id)).literature.metadata,
    ).toMatchObject({ title: "A title without identifiers", identifiers: [] });
    const settled = {
      ...saved,
      metadata: {
        status: "partial",
        job_id: null,
        code: "intake-needs-metadata",
      },
    };
    await vi.waitFor(
      async () =>
        expect(await f.call(actor.token, "pages/save", input)).toEqual(settled),
      { timeout: 20000 },
    );
    expect(f.sql("SELECT * FROM literatures")).toHaveLength(1);
    expect(
      f.sql("SELECT result_json FROM intake_page_requests")[0]!.result_json,
    ).not.toBeNull();
    expect(
      f.sql(
        "SELECT name FROM sqlite_master WHERE name IN ('capture_items','capture_daily_batches')",
      ),
    ).toEqual([]);
    for (const path of [
      "/api/v1/capture/save",
      "/api/v1/import/sessions",
      "/api/v1/device-connections/instructions",
      "/api/v1/device-connections/skill",
    ]) {
      const response = await fetch(f.server.origin + path, {
        method:
          path.endsWith("instructions") || path.endsWith("skill")
            ? "GET"
            : "POST",
        headers: { Authorization: `Bearer ${actor.token}` },
      });
      expect(response.status).toBe(403);
    }
  } finally {
    await f.close();
  }
}, 30000);
