import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  canonicalJsonBytes,
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  uncheckedProcessorValues,
  PROCESSOR_METHOD_REVISION,
  sha256,
  type EvidenceRef,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import {
  archiveFixture,
  moveIntroductionToMethods,
} from "./archive-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { ProcessorArchiveSource } from "../src/analysis/processor-archive.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

type Fixture = Awaited<ReturnType<typeof coreProcessingFixture>>;
const source = "# Synthetic lifecycle\n\nA fixed synthetic finding.\n";
function checkpoint() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async pause() {
      entered();
      await gate;
    },
  };
}
function query(f: Fixture, sql: string, ...args: SQLInputValue[]) {
  const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}
const head = (f: Fixture) =>
  query(
    f,
    "SELECT source_json FROM archive_content_heads WHERE literature_id=? AND asset_id=?",
    f.parseRequest.literature_id,
    f.asset.asset_id,
  )[0]?.source_json ?? null;
const events = (f: Fixture) =>
  query(
    f,
    "SELECT sequence,old_json,new_json FROM archive_version_events WHERE kind='content-version-changed' AND literature_id=? AND asset_id=? ORDER BY sequence",
    f.parseRequest.literature_id,
    f.asset.asset_id,
  );
const current = (f: Fixture) =>
  f.app.database.documentDefault(
    f.parseRequest.literature_id,
    f.asset.asset_id,
    f.asset.sha256,
  );
async function parse(f: Fixture, force = false) {
  const result = await f.app.documentProcessing.parseDocuments({
    ...f.rawParseRequest,
    profiles: ["vlm-engine"],
    force,
  });
  if (result.draft.status !== "formed" && result.draft.status !== "reused")
    throw new Error("Synthetic draft required");
  return result.draft;
}
async function raw(f: Fixture, profile = "vlm-engine") {
  const value = (await f.app.rawParseStorage!.current(f.asset.asset_id)).find(
    (item) => item.profile === profile,
  )?.result;
  if (!value) throw new Error("Synthetic current raw required");
  return value;
}
const form = async (f: Fixture, profile = "vlm-engine") =>
  f.app.draftDocuments.publish({
    literature_id: f.parseRequest.literature_id,
    asset_id: f.asset.asset_id,
    asset_sha256: f.asset.sha256,
    raw: await raw(f, profile),
  });
async function prepareCorrected(f: Fixture) {
  await f.app.archiveText!.arrange(f.asset.asset_id, "full");
  const proof = await f.app.archiveText!.proofread(
    f.asset.asset_id,
    "full",
    null,
  );
  expect(
    (await f.app.archiveText!.storage.load(proof.proofread_id))!.version.status,
  ).toBe("complete");
  return proof;
}
const render = (f: Fixture) =>
  f.app.archiveText!.render(f.parseRequest.literature_id, f.asset.asset_id);
async function slice(f: Fixture, document_version_id: string) {
  const page = await f.app.documentRead.segments({
    document_version_id,
    section_id: null,
    limit: 200,
    cursor: null,
  });
  for (const segment of page.segments) {
    const result = await f.app.documentRead.slice({
      document_version_id,
      selector: { kind: "segment", segment_id: segment.segment_id },
      max_bytes: 65536,
      continuation: null,
    });
    if (result.text.includes("A fixed synthetic finding.")) return result;
  }
  throw new Error("Known synthetic text missing");
}

/** Synthetic future result and read-scope rows; no executor or freshness rule is replaced. */
async function resultOn(f: Fixture, version: string) {
  const document = (
    await f.app.documentRead.describe({ document_version_id: version })
  ).document;
  const passage = await slice(f, version),
    evidence = passage.evidence[0]!;
  const invocation = parseProcessorInvocation({
    schema_version: 1,
    processor: { id: "external-extraction", version: "2" },
    spec: {},
    inputs: [
      {
        kind: "external",
        input_id: "source",
        literature_id: f.parseRequest.literature_id,
        material: document.source_material_ref,
        document,
      },
    ],
    execution: {
      reads: { parts: "main", roles: "all" },
      uses_description: false,
      map: null,
      method_sha256: "a".repeat(64),
      model: null,
    },
  });
  const content = {
    kind: "report" as const,
    text: passage.text,
    claims: [
      {
        record_id: "finding",
        text: passage.text,
        sources: [{ kind: "document" as const, evidence }],
      },
    ],
  };
  const result = await parseProcessorResult({
    schema_version: 1,
    result_id: randomUUID(),
    invocation,
    comparison_sha256: await processorComparison(invocation),
    status: "ok",
    content,
    value_checks: uncheckedProcessorValues(
      content,
      "Synthetic result; no executor or value check was run.",
    ),
    coverage: [
      {
        input_id: "source",
        parts: [],
        status: "complete",
        read_segments: [],
        gaps: [],
      },
    ],
    producer: "external",
    provenance: { source: "synthetic-lifecycle" },
    literature_ids: [f.parseRequest.literature_id],
    created_at: "2026-11-15T00:00:00Z",
  });
  const bytes = canonicalJsonBytes(result),
    digest = await sha256(bytes),
    path = `knowledge/lifecycle-${result.result_id}.json`;
  const stage = await f.app.files.stage({ maxBytes: bytes.length });
  try {
    await stage.write(bytes);
    await f.app.files.publish(stage, path);
  } finally {
    await stage.discard();
  }
  const sourceJson = head(f);
  expect(typeof sourceJson).toBe("string");
  await f.app.writes.run(async () => {
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      db.prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?)").run(
        randomUUID(),
        digest,
        bytes.length,
        "application/json",
        path,
      );
      db.prepare(
        "INSERT INTO processor_results VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        result.result_id,
        result.comparison_sha256,
        invocation.processor.id,
        invocation.processor.version,
        1,
        "external",
        path,
        digest,
        bytes.length,
        "application/json",
        result.created_at,
      );
      db.prepare(
        "INSERT INTO processor_result_documents VALUES(?,?,?,?,?,?)",
      ).run(
        result.result_id,
        f.parseRequest.literature_id,
        f.asset.asset_id,
        f.asset.sha256,
        version,
        document.representation_sha256,
      );
      db.prepare("INSERT INTO processor_result_literatures VALUES(?,?)").run(
        result.result_id,
        f.parseRequest.literature_id,
      );
      db.prepare(
        "INSERT INTO processor_result_summaries VALUES(?,NULL,?,?)",
      ).run(
        result.result_id,
        JSON.stringify({ with_result: 1, empty: 0, incomplete: 0 }),
        PROCESSOR_METHOD_REVISION,
      );
      db.prepare(
        "INSERT INTO processor_result_freshness VALUES(?,'current')",
      ).run(result.result_id);
      db.prepare(
        "INSERT INTO processor_result_archive_scopes VALUES(?,?,'main',0,?)",
      ).run(result.result_id, f.parseRequest.literature_id, "a".repeat(64));
      db.prepare(
        "INSERT INTO processor_result_archive_parts VALUES(?,?,?,'main',?)",
      ).run(
        result.result_id,
        f.parseRequest.literature_id,
        f.asset.asset_id,
        sourceJson,
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("COMMIT");
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });
  const stored = await f.app.processorRead!.byId(result.result_id);
  expect(stored).toMatchObject({
    result,
    freshness: { state: "current", reasons: [] },
  });
  return { result, evidence, passage, sourceJson, digest };
}
async function resolve(f: Fixture, evidence: EvidenceRef) {
  return f.app.documentRead.resolveEvidence({
    evidence,
    max_bytes: 65536,
    continuation: null,
  });
}

it("reports stale default CAS consistently through Web, CLI and MCP and accepts their retry with the draft revision", async () => {
  const f = await coreProcessingFixture({ offline: true });
  const queryApp = await createQueryApplication(f.home);
  const screen = new ProductionWorkbenchSession(null, undefined);
  const http = await startWorkbenchHttp({
    session: screen,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
    query: {
      application: queryApp,
      maintenance: f.app.maintenance!,
      archiveOperation: (operation, input, signal) =>
        executeMaintenance(f.app, operation, input, signal),
    },
  });
  const host = createMcpServer({
    home: f.home,
    maintenance: true,
    sharedApplications: true,
    applicationFactory: async () => f.app,
    queryFactory: async () => queryApp,
  });
  const client = new Client({ name: "synthetic-lifecycle", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cli = (operation: string, input: unknown, errors: string[] = []) =>
    runCli(["document", operation, "--request", "-", "--json"], {
      home: f.home,
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(input));
      })(),
      stdout: () => {},
      stderr: (message) => errors.push(message),
    });
  try {
    f.setText(source);
    await parse(f);
    const proof = await prepareCorrected(f);
    const calls = f.modelCalls,
      parses = f.parseCalls;
    await host.connect(a);
    await client.connect(b);
    const login = await workbenchLogin(http.origin),
      landing = await fetch(http.origin, { headers: { Cookie: login } });
    const cookies = `${login}; ${landing.headers.get("set-cookie")!.split(";")[0]!}`;
    const grant = await fetch(http.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: http.origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const access = (await grant.json()) as { client_id: string; csrf: string };
    const post = (path: string, request: unknown) =>
      fetch(`${http.origin}${path}?client_id=${access.client_id}`, {
        method: "POST",
        headers: {
          Cookie: cookies,
          Origin: http.origin,
          "X-Workbench-CSRF": access.csrf,
          "X-SciRetriever-Protocol-Version": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
    const request = {
      schema_version: 2,
      literature_id: f.parseRequest.literature_id,
      asset_id: f.asset.asset_id,
      proofread_id: proof.proofread_id,
      expected_default_revision: null,
    };
    const errors: string[] = [];
    expect((await cli("publish-proofread", request, errors)).code).not.toBe(0);
    expect(errors.join("")).toContain("publication-conflict");
    const refused = await post(
      "/api/v1/maintenance/document-publish-proofread",
      request,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      protocol_version: 1,
      code: "publication-conflict",
    });
    const denied = await client.callTool({
      name: "document_publish_proofread",
      arguments: request,
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("publication-conflict");
    const material = {
      literature_id: request.literature_id,
      asset_id: f.asset.asset_id,
      asset_sha256: f.asset.sha256,
    };
    const webRead = await post("/api/v1/query/document-default", material);
    expect(webRead.status).toBe(200);
    const webValue = (await webRead.json()) as {
      result: { default: { revision: number; document_version_id: string } };
    };
    expect((await cli("default", material)).value).toEqual(webValue);
    const mcpRead = await client.callTool({
      name: "document_read",
      arguments: { operation: "default", request: material },
    });
    expect(mcpRead.isError).not.toBe(true);
    expect(mcpRead.structuredContent).toEqual(webValue);
    expect(webValue.result.default.revision).toBe(1);
    const retry = {
      ...request,
      expected_default_revision: webValue.result.default.revision,
    };
    const accepted = await post(
      "/api/v1/maintenance/document-publish-proofread",
      retry,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      result: { default_updated: true, default_revision: 2 },
    });
    expect(await cli("publish-proofread", retry)).toMatchObject({
      code: 0,
      value: { default_updated: true, default_revision: 2 },
    });
    const again = await client.callTool({
      name: "document_publish_proofread",
      arguments: retry,
    });
    expect(again.isError).not.toBe(true);
    expect(again.structuredContent).toMatchObject({
      result: { default_updated: true, default_revision: 2 },
    });
    const tools = (await client.listTools()).tools;
    const description = tools.find(
      (tool) => tool.name === "document_publish_proofread",
    )!.description;
    for (const term of [
      "expected_default_revision",
      "draft",
      "publication-conflict",
      "document_read/default",
    ])
      expect(description).toContain(term);
    const help: string[] = [];
    await runCli(["--help"], {
      home: f.home,
      stdout: (message) => help.push(message),
    });
    expect(help.join("")).toContain("expected_default_revision");
    expect(help.join("")).toContain("publication-conflict");
    expect(f.modelCalls).toBe(calls);
    expect(f.parseCalls).toBe(parses);
  } finally {
    await client.close();
    await host.close();
    await http.close();
    await screen.close();
    await queryApp.close();
    await f.close();
  }
}, 60_000);

it.each(["draft-paused", "archive-paused"] as const)(
  "serializes fresh default selection across two real publishers with checkpoints (%s)",
  async (order) => {
    const f = await coreProcessingFixture({ offline: true }),
      point = checkpoint();
    let draftWork: ReturnType<typeof form> | undefined;
    let archiveWork: ReturnType<typeof render> | undefined;
    try {
      f.setText(source);
      await f.app.rawParsing!.parseAsset(
        f.asset.asset_id,
        ["vlm-engine"],
        undefined,
        { expected_sha256: f.asset.sha256, force: false },
      );
      await prepareCorrected(f);
      const calls = f.modelCalls;
      if (order === "draft-paused") {
        const inspect = f.app.archiveText!.pdf.inspect.bind(
          f.app.archiveText!.pdf,
        );
        vi.spyOn(f.app.archiveText!.pdf, "inspect").mockImplementationOnce(
          async (...args) => {
            await point.pause();
            return inspect(...args);
          },
        );
        draftWork = form(f);
        await point.reached;
        const corrected = await render(f),
          before = events(f);
        expect((await current(f))!.document_version_id).toBe(
          corrected.document_version_id,
        );
        point.release();
        expect(await draftWork).toMatchObject({
          status: "formed",
          default_changed: false,
          default_text_level: "proofread",
        });
        expect(events(f)).toEqual(before);
        expect((await current(f))!.document_version_id).toBe(
          corrected.document_version_id,
        );
      } else {
        const material = f.app.database.documentMaterial.bind(f.app.database);
        vi.spyOn(f.app.database, "documentMaterial").mockImplementationOnce(
          async (...args) => {
            const result = await material(...args);
            await point.pause();
            return result;
          },
        );
        archiveWork = render(f);
        await point.reached;
        const draft = await form(f);
        expect(draft).toMatchObject({
          status: "formed",
          default_changed: true,
          default_text_level: "draft",
        });
        expect((await current(f))!.revision).toBe(1);
        point.release();
        const corrected = await archiveWork;
        expect(await current(f)).toMatchObject({
          document_version_id: corrected.document_version_id,
          revision: 2,
        });
      }
      expect(
        query(
          f,
          "SELECT schema_version FROM document_versions ORDER BY schema_version",
        ).map((row) => row.schema_version),
      ).toEqual([2, 3]);
      expect(f.modelCalls).toBe(calls);
    } finally {
      point.release();
      await Promise.allSettled([
        ...(draftWork ? [draftWork] : []),
        ...(archiveWork ? [archiveWork] : []),
      ]);
      vi.restoreAllMocks();
      await f.close();
    }
  },
  60_000,
);

it("rechecks raw currentness in the corrected transaction after raw-switch and new-draft commits overtake it", async () => {
  const f = await coreProcessingFixture({ offline: true }),
    point = checkpoint();
  let pending:
    | ReturnType<Fixture["app"]["proofreadDocuments"]["publish"]>
    | undefined;
  try {
    f.setText(source);
    const first = await parse(f);
    const proof = await f.app.proofreading!.build({
      asset_id: f.asset.asset_id,
    });
    const commit = f.app.database.commitDocumentVersion.bind(f.app.database);
    vi.spyOn(f.app.database, "commitDocumentVersion").mockImplementationOnce(
      async (...args) => {
        await point.pause();
        return commit(...args);
      },
    );
    pending = f.app.proofreadDocuments.publish({
      literature_id: f.parseRequest.literature_id,
      asset_id: f.asset.asset_id,
      proofread_id: proof.version.proofread_id,
      expected_default_revision: (await current(f))!.revision,
    });
    const refused = expect(pending).rejects.toMatchObject({
      code: "document-raw-stale",
    });
    await point.reached;
    f.setText(source + "\nA replacement raw parse.\n");
    const next = await parse(f, true);
    expect(next.raw_parse_id).not.toBe(first.raw_parse_id);
    point.release();
    await refused;
    expect((await current(f))!.document_version_id).toBe(
      next.document_version_id,
    );
    expect(
      query(
        f,
        "SELECT schema_version FROM document_versions ORDER BY document_version_id",
      ).map((row) => row.schema_version),
    ).toEqual([3, 3]);
    expect(
      query(
        f,
        "SELECT status FROM proofread_versions WHERE proofread_id=?",
        proof.version.proofread_id,
      )[0]!.status,
    ).toBe("complete");
    expect(
      await f.app.documentRead.describe({
        document_version_id: first.document_version_id,
      }),
    ).toMatchObject({ text_level: "draft" });
  } finally {
    point.release();
    await Promise.allSettled(pending ? [pending] : []);
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

it("archives from an absent raw source through a draft and publishes against that draft revision", async () => {
  const f = await archiveFixture({ offline: true });
  try {
    expect(await current(f)).toBeNull();
    const commit = vi.spyOn(f.app.database, "commitDocumentVersion");
    expect((await f.submit("lifecycle-archive")).failures).toEqual([]);
    expect(
      commit.mock.calls.some(
        ([publication]) => publication.expected_default_revision === 1,
      ),
    ).toBe(true);
    const selected = await current(f);
    expect(selected?.revision).toBe(2);
    expect(
      await f.app.documentRead.describe({
        document_version_id: selected!.document_version_id,
      }),
    ).toMatchObject({ text_level: "proofread" });
    expect(
      query(
        f,
        "SELECT schema_version FROM document_versions ORDER BY schema_version",
      ).map((row) => row.schema_version),
    ).toEqual([2, 3]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

it("emits the exact corrected-to-draft-to-corrected transitions when manual publication invalidates the old corrected default", async () => {
  const f = await archiveFixture({ offline: true }),
    point = checkpoint();
  let pending: ReturnType<typeof moveIntroductionToMethods> | undefined;
  try {
    const draft = await parse(f);
    expect((await f.submit("lifecycle-manual-events")).failures).toEqual([]);
    const selected = await current(f),
      beforeHead = head(f),
      beforeEvents = events(f).length,
      calls = f.modelCalls;
    expect(
      await f.app.documentRead.describe({
        document_version_id: selected!.document_version_id,
      }),
    ).toMatchObject({ text_level: "proofread" });
    const renderCorrected = f.app.archiveText!.render.bind(f.app.archiveText);
    vi.spyOn(f.app.archiveText!, "render").mockImplementationOnce(
      async (...args) => {
        await point.pause();
        return renderCorrected(...args);
      },
    );
    pending = moveIntroductionToMethods(f, "synthetic");
    await point.reached;
    expect((await current(f))!.document_version_id).toBe(
      draft.document_version_id,
    );
    const draftHead = head(f);
    expect(JSON.parse(String(draftHead))).toEqual({
      text_level: "draft",
      document_version_id: draft.document_version_id,
    });
    expect(
      events(f)
        .slice(beforeEvents)
        .map(({ old_json, new_json }) => ({
          old_json,
          new_json,
        })),
    ).toEqual([
      { old_json: beforeHead, new_json: null },
      { old_json: null, new_json: draftHead },
    ]);
    point.release();
    await pending;
    const corrected = await current(f);
    expect(corrected!.document_version_id).not.toBe(
      selected!.document_version_id,
    );
    expect(
      await f.app.documentRead.describe({
        document_version_id: corrected!.document_version_id,
      }),
    ).toMatchObject({ text_level: "proofread" });
    expect(
      events(f)
        .slice(beforeEvents)
        .map(({ old_json, new_json }) => ({
          old_json,
          new_json,
        })),
    ).toEqual([
      { old_json: beforeHead, new_json: null },
      { old_json: null, new_json: draftHead },
      { old_json: draftHead, new_json: null },
      { old_json: null, new_json: head(f) },
    ]);
    expect(f.modelCalls).toBe(calls);
  } finally {
    point.release();
    await Promise.allSettled(pending ? [pending] : []);
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

it("exposes the missing-text window to reading, default search and the unchanged processor admission after reparsing an archived part", async () => {
  const f = await archiveFixture({ offline: true }),
    point = checkpoint();
  let queryApp: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let pending:
    | ReturnType<Fixture["app"]["documentProcessing"]["parseDocuments"]>
    | undefined;
  try {
    expect((await f.submit("lifecycle-missing-window")).failures).toEqual([]);
    expect((await f.app.archive.status(f.id)).status).toBe("READY");
    await f.app.maintenance!.rebuildIndex();
    queryApp = await createQueryApplication(f.home);
    const input = {
      query: "spectroscopy",
      scope: { kind: "literatures", literature_ids: [f.id] },
      kinds: ["document"],
      versions: { kind: "default" },
      budget: { max_items: 20, max_bytes: 65536, token_limit: null },
      continuation: null,
    };
    expect(
      (await queryApp.context!.search(input)).items.length,
    ).toBeGreaterThan(0);
    const processor = new ProcessorArchiveSource(
      f.app.archive,
      f.app.snapshots,
      new SqliteAnnotationStorage(f.app.database, f.app.files),
      f.app.documentRead,
    );
    const reads = { parts: "main", roles: "all" } as const;
    const signal = new AbortController().signal;
    expect(await processor.input(f.id, reads, signal)).toMatchObject({
      kind: "archive-document",
    });
    const calls = f.modelCalls;
    vi.spyOn(f.app.archiveText!.pdf, "inspect").mockImplementationOnce(
      async () => {
        await point.pause();
        throw new Error("Synthetic unavailable draft pages");
      },
    );
    f.setText("# New source\n\nReplacement spectroscopy facts.\n");
    pending = f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
      force: true,
    });
    await point.reached;
    expect(
      await f.app.documentRead.default({
        literature_id: f.id,
        asset_id: f.asset.asset_id,
        asset_sha256: f.asset.sha256,
      }),
    ).toMatchObject({ default: null, gap: "document-missing" });
    const found = await queryApp.context!.search(input);
    expect(found.items).toEqual([]);
    expect(found.gaps).toContainEqual({
      code: "representation-missing",
      literature_id: f.id,
    });
    expect((await f.app.archive.status(f.id)).parts).toContainEqual(
      expect.objectContaining({
        asset_id: f.asset.asset_id,
        document_version_id: null,
        content_version: null,
      }),
    );
    // Plan 16 owns the executor's READY admission. It must not reuse the old
    // corrected document here; this drill does not relax that admission.
    expect(await processor.input(f.id, reads, signal)).toMatchObject({
      kind: "missing",
      reason: "not-ready",
    });
    point.release();
    expect((await pending).draft).toMatchObject({ status: "failed" });
    expect(await current(f)).toBeNull();
    expect(f.modelCalls).toBe(calls);
  } finally {
    point.release();
    await Promise.allSettled(pending ? [pending] : []);
    vi.restoreAllMocks();
    await queryApp?.close();
    await f.close();
  }
}, 60_000);

it("makes draft results stale on upgrade while keeping their original evidence and immutable versions readable", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    f.setText(source);
    const draft = await parse(f),
      bound = await resultOn(f, draft.document_version_id);
    expect(JSON.parse(String(bound.sourceJson))).toEqual({
      text_level: "draft",
      document_version_id: draft.document_version_id,
    });
    await prepareCorrected(f);
    const corrected = await render(f);
    expect(await current(f)).toMatchObject({
      document_version_id: corrected.document_version_id,
      revision: 2,
    });
    const fresh = await f.app.processorRead!.byId(bound.result.result_id);
    const originalVersion = await sha256(
      canonicalJsonBytes(JSON.parse(String(bound.sourceJson))),
    );
    expect(fresh).toMatchObject({
      result: bound.result,
      ref: { content_sha256: bound.digest },
      freshness: {
        state: "stale",
        reasons: expect.arrayContaining([
          expect.objectContaining({
            kind: "content-version-changed",
            old_version: originalVersion,
          }),
        ]),
      },
    });
    const correctedText = await slice(f, corrected.document_version_id);
    expect(correctedText.text).toBe(bound.passage.text);
    const calls = f.modelCalls,
      parses = f.parseCalls;
    expect(await resolve(f, bound.evidence)).toMatchObject({
      text_level: "draft",
      text: bound.passage.text,
      content_sha256: bound.evidence.content_sha256,
    });
    const proofBound = await resultOn(f, corrected.document_version_id),
      before = events(f);
    await f.app.rawParsing!.parseAsset(
      f.asset.asset_id,
      ["pipeline"],
      undefined,
      { expected_sha256: f.asset.sha256, force: false },
    );
    const other = await form(f, "pipeline");
    expect(other).toMatchObject({
      status: "formed",
      default_changed: false,
      default_text_level: "proofread",
    });
    expect(events(f)).toEqual(before);
    expect(
      (await f.app.processorRead!.byId(proofBound.result.result_id))!.freshness,
    ).toMatchObject({ state: "current", reasons: [] });
    expect(f.modelCalls).toBe(calls);
    expect(f.parseCalls).toBe(parses + 1);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON");
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM processor_result_documents WHERE document_version_id=?",
          )
          .get(draft.document_version_id)!.n,
      ).toBe(1);
      expect(
        db
          .prepare("SELECT 1 FROM draft_current WHERE document_version_id=?")
          .all(draft.document_version_id),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT 1 FROM document_defaults WHERE document_version_id=?",
          )
          .all(draft.document_version_id),
      ).toEqual([]);
      expect(() =>
        db
          .prepare("DELETE FROM document_versions WHERE document_version_id=?")
          .run(draft.document_version_id),
      ).toThrow(/FOREIGN KEY/u);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    expect(await resolve(f, bound.evidence)).toMatchObject({
      text_level: "draft",
      text: bound.passage.text,
    });
  } finally {
    await f.close();
  }
}, 60_000);

it.each([false, true])(
  "clears the default at the raw commit checkpoint and stales prior results before draft formation (failure: %s)",
  async (failDraft) => {
    const f = await coreProcessingFixture({ offline: true }),
      point = checkpoint();
    let pending:
      | ReturnType<Fixture["app"]["documentProcessing"]["parseDocuments"]>
      | undefined;
    try {
      f.setText(source);
      const first = await parse(f),
        bound = await resultOn(f, first.document_version_id);
      const inspect = f.app.archiveText!.pdf.inspect.bind(
        f.app.archiveText!.pdf,
      );
      vi.spyOn(f.app.archiveText!.pdf, "inspect").mockImplementationOnce(
        async (...args) => {
          await point.pause();
          if (failDraft) throw new Error("Synthetic unavailable pages");
          return inspect(...args);
        },
      );
      f.setText(source + "\nA new raw paragraph.\n");
      pending = f.app.documentProcessing.parseDocuments({
        ...f.rawParseRequest,
        profiles: ["vlm-engine"],
        force: true,
      });
      await point.reached;
      expect((await raw(f)).raw_parse_id).not.toBe(first.raw_parse_id);
      expect(await current(f)).toBeNull();
      expect(head(f)).toBeNull();
      expect(
        await f.app.documentRead.default({
          literature_id: f.parseRequest.literature_id,
          asset_id: f.asset.asset_id,
          asset_sha256: f.asset.sha256,
        }),
      ).toMatchObject({ default: null, gap: "document-missing" });
      expect(events(f).at(-1)).toMatchObject({
        old_json: bound.sourceJson,
        new_json: null,
      });
      expect(
        (await f.app.processorRead!.byId(bound.result.result_id))!.freshness,
      ).toMatchObject({
        state: "stale",
        reasons: [
          expect.objectContaining({
            kind: "content-version-changed",
            new_version: null,
          }),
        ],
      });
      expect(await resolve(f, bound.evidence)).toMatchObject({
        text_level: "draft",
        text: bound.passage.text,
      });
      point.release();
      const completed = await pending;
      if (failDraft) {
        expect(completed.draft).toMatchObject({
          status: "failed",
          failure_code: "page-tools-unavailable",
        });
        expect(await current(f)).toBeNull();
        expect(head(f)).toBeNull();
      } else {
        expect(completed.draft).toMatchObject({
          status: "formed",
          default_text_level: "draft",
        });
        if (completed.draft.status !== "formed")
          throw new Error("Synthetic draft missing");
        expect((await current(f))!.document_version_id).toBe(
          completed.draft.document_version_id,
        );
      }
      expect(
        query(
          f,
          "SELECT 1 FROM raw_parse_current WHERE raw_parse_id=?",
          first.raw_parse_id,
        ),
      ).toEqual([]);
      expect(
        query(
          f,
          "SELECT 1 FROM raw_parse_pins WHERE raw_parse_id=?",
          first.raw_parse_id,
        ),
      ).toEqual([]);
      await expect(
        f.app.rawParseStorage!.retire(first.raw_parse_id),
      ).rejects.toMatchObject({ code: "raw-parse-in-use" });
      expect(
        (await f.app.rawParseStorage!.byId(first.raw_parse_id))!.raw_parse_id,
      ).toBe(first.raw_parse_id);
    } finally {
      point.release();
      await Promise.allSettled(pending ? [pending] : []);
      vi.restoreAllMocks();
      await f.close();
    }
  },
  60_000,
);

it("keeps a prior profile's fixed default on restart and changes it only after forming the new profile draft", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    f.setText(source);
    const first = await parse(f),
      selected = await current(f);
    // This is the fixture's isolated home, never a personal configuration.
    await writeFile(
      join(f.home, ".sciretriever", "config.toml"),
      '[parsing]\narchive_profile="pipeline"\n',
      { mode: 0o600 },
    );
    await f.reopen();
    expect(f.app.configuration.parsing.archive_profile).toBe("pipeline");
    expect(await current(f)).toEqual(selected);
    expect(
      await f.app.documentRead.describe({
        document_version_id: first.document_version_id,
      }),
    ).toMatchObject({ text_level: "draft" });
    const next = await f.app.documentProcessing.parseDocuments({
      literature_id: f.parseRequest.literature_id,
      asset_id: f.asset.asset_id,
      asset_sha256: f.asset.sha256,
    });
    expect(next.draft).toMatchObject({
      status: "formed",
      default_text_level: "draft",
    });
    if (next.draft.status !== "formed")
      throw new Error("Synthetic new profile draft missing");
    expect(next.draft.document_version_id).not.toBe(first.document_version_id);
    expect((await current(f))!.document_version_id).toBe(
      next.draft.document_version_id,
    );
    expect((await raw(f, "vlm-engine")).raw_parse_id).toBe(first.raw_parse_id);
    expect(
      await resolve(
        f,
        (await slice(f, first.document_version_id)).evidence[0]!,
      ),
    ).toMatchObject({
      text_level: "draft",
      text: "A fixed synthetic finding.",
    });
  } finally {
    await f.close();
  }
}, 60_000);
