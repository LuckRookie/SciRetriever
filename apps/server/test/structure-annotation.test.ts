import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { it, expect } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
async function prepared(model = true) {
  const e = await coreProcessingFixture({ analysisModel: model });
  try {
    e.setText(
      "# Methods\n\nA synthetic experiment.\n\n# Electronic landscape\n\n🧪αβγ synthetic paragraph.\n\n# References\n\n[1] Example. doi:10.1234/example\n",
    );
    e.setModel(() => ({ role: "discussion" }));
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const p = await e.app.proofreading!.build({ asset_id: e.asset.asset_id });
    const v = await e.app.proofreadDocuments.publish({
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: p.version.proofread_id,
      expected_default_revision: null,
    });
    return {
      e,
      id: v.document.document_version_id,
      store: new SqliteAnnotationStorage(e.app.database, e.app.files),
    };
  } catch (error) {
    await e.close();
    throw error;
  }
}
it("publishes, reuses, locks and revokes separate annotations without changing document/evidence identity", async () => {
  const { e, id, store } = await prepared();
  try {
    const request = { document_version_id: id, max_prefix_characters: 3 };
    const first = await e.app.structureAnnotations!.build(request);
    expect(first).toMatchObject({
      published: true,
      manual_revision: 0,
      structure_satisfied: true,
      section_count: 3,
      reference_count: 1,
    });
    const annotation = await store.byId(first.annotation_id);
    expect(annotation?.sections.map((s) => [s.role, s.role_source])).toEqual([
      ["methods", "rule"],
      ["discussion", "model"],
      ["references", "rule"],
    ]);
    expect(e.modelCalls).toBe(1);
    expect(await e.app.structureAnnotations!.build(request)).toEqual({
      ...first,
      published: false,
      usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    expect(e.modelCalls).toBe(1);
    const section = annotation!.sections[0]!.section_id;
    const edit = {
      document_version_id: id,
      section_id: section,
      role: "results",
      expected_manual_revision: 0,
      actor: "synthetic-user",
    };
    await expect(
      executeMaintenance(e.app, "document-role", edit),
    ).rejects.toMatchObject({ code: "archive-contract-obsolete" });
    // Historical annotations remain readable; the internal legacy fixture
    // builder is deliberately separate from the retired public write API.
    const locked = await e.app.structureAnnotations!.setRole(edit);
    expect(locked).toMatchObject({ published: true, manual_revision: 1 });
    const after = await store.current(id);
    expect(after?.sections[0]).toMatchObject({
      role: "results",
      role_source: "manual",
      locked: true,
    });
    expect((await store.byId(first.annotation_id))?.sections[0]?.role).toBe(
      "methods",
    );
    await expect(
      e.app.structureAnnotations!.setRole({
        document_version_id: id,
        section_id: section,
        role: null,
        expected_manual_revision: 0,
        actor: "synthetic-user",
      }),
    ).rejects.toMatchObject({ code: "annotation-manual-stale" });
    expect((await store.current(id))?.annotation_id).toBe(after?.annotation_id);
    const next = await e.app.structureAnnotations!.build({
      ...request,
      max_prefix_characters: 8,
    });
    expect((await store.byId(next.annotation_id))?.sections[0]).toMatchObject({
      role: "results",
      locked: true,
    });
    await e.app.structureAnnotations!.setRole({
      document_version_id: id,
      section_id: section,
      role: null,
      expected_manual_revision: 1,
      actor: "synthetic-user",
    });
    expect((await store.current(id))?.sections[0]).toMatchObject({
      role: "methods",
      role_source: "rule",
      locked: false,
    });
    expect(
      (await e.app.documentRead.describe({ document_version_id: id })).document
        .document_version_id,
    ).toBe(id);
    await e.reopen();
    const reopened = new SqliteAnnotationStorage(e.app.database, e.app.files);
    expect((await reopened.current(id))?.manual_revision).toBe(2);
  } finally {
    await e.close();
  }
}, 30000);
it("publishes an explicit fallback without any model configuration and admits only part-valid human roles", async () => {
  const { e, id, store } = await prepared(false);
  try {
    const result = await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    expect((await store.byId(result.annotation_id))?.sections[1]).toMatchObject(
      {
        role: "body",
        role_source: "fallback",
        failure_code: "role-model-unavailable",
      },
    );
    expect(e.modelCalls).toBe(0);
    const a = await store.current(id);
    await expect(
      e.app.structureAnnotations!.setRole({
        document_version_id: id,
        section_id: a!.sections[0]!.section_id,
        role: "si-methods",
        expected_manual_revision: 0,
        actor: "synthetic-user",
      }),
    ).rejects.toThrow();
    expect((await store.state(id)).manual_revision).toBe(0);
  } finally {
    await e.close();
  }
}, 30000);
it("rejects stale concurrent edits atomically and leaves immutable prior annotations available", async () => {
  const { e, id, store } = await prepared(false);
  try {
    const first = await e.app.structureAnnotations!.build({
        document_version_id: id,
        max_prefix_characters: 20,
      }),
      a = (await store.byId(first.annotation_id))!;
    const result = await Promise.allSettled(
      ["methods", "results"].map((role) =>
        e.app.structureAnnotations!.setRole({
          document_version_id: id,
          section_id: a.sections[1]!.section_id,
          role,
          expected_manual_revision: 0,
          actor: "synthetic-user",
        }),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await store.state(id)).manual_revision).toBe(1);
    expect(await store.byId(first.annotation_id)).toEqual(a);
  } finally {
    await e.close();
  }
}, 30000);

it("pins bounded annotation reads across a manual edit and rejects cross-document continuations", async () => {
  const { e, id, store } = await prepared(false);
  try {
    const first = await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    const q = await createQueryApplication(e.home);
    try {
      let continuation: string | null = null,
        text = "";
      do {
        const page = (await executeQuery(q, "document-annotation", {
          document_version_id: id,
          annotation_id: null,
          field: "all",
          max_bytes: 127,
          continuation,
        })) as {
          annotation_id: string;
          text: string;
          continuation: string | null;
        };
        expect(page.annotation_id).toBe(first.annotation_id);
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(127);
        text += page.text;
        continuation = page.continuation;
        if (text.length === page.text.length) {
          const a = (await store.current(id))!;
          await e.app.structureAnnotations!.setRole({
            document_version_id: id,
            section_id: a.sections[0]!.section_id,
            role: "results",
            expected_manual_revision: 0,
            actor: "synthetic-user",
          });
          await expect(
            executeQuery(q, "document-annotation", {
              document_version_id: "00000000-0000-0000-0000-000000000999",
              annotation_id: null,
              field: "all",
              max_bytes: 127,
              continuation,
            }),
          ).rejects.toThrow();
        }
      } while (continuation);
      await expect(
        executeQuery(q, "document-annotation", {
          document_version_id: id,
          annotation_id: null,
          field: "all",
          max_bytes: 127,
          continuation: Buffer.from("not json").toString("base64url"),
        }),
      ).rejects.toMatchObject({ code: "annotation-invalid" });
      expect(JSON.parse(text)).toMatchObject({
        annotation_id: first.annotation_id,
        document_version_id: id,
        manual_revision: 0,
      });
      expect(e.modelCalls).toBe(0);
    } finally {
      await q.close();
    }
  } finally {
    await e.close();
  }
}, 30000);
it("returns annotated outline and role-filtered segments, and pins old roles after edits", async () => {
  const { e, id, store } = await prepared(false);
  try {
    const first = await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    const request = {
      document_version_id: id,
      limit: 2,
      cursor: null,
      annotation_id: first.annotation_id,
    };
    const outline = await e.app.documentRead.outline(request);
    expect(outline.annotation_id).toBe(first.annotation_id);
    expect(outline.sections.map((s) => s.role)).toEqual(["methods", "body"]);
    const { parseDocumentReadResult, parseDocumentReadRequest } = await import(
      "@sciretriever/contracts"
    );
    parseDocumentReadResult(
      "outline",
      outline,
      parseDocumentReadRequest("outline", request),
    );
    const segmentsRequest = {
      document_version_id: id,
      section_id: null,
      limit: 200,
      cursor: null,
      roles: ["references"],
      annotation_id: first.annotation_id,
    };
    const refs = await e.app.documentRead.segments(segmentsRequest);
    expect(refs.segments).toHaveLength(2);
    parseDocumentReadResult(
      "segments",
      refs,
      parseDocumentReadRequest("segments", segmentsRequest),
    );
    const current = (await store.current(id))!;
    await e.app.structureAnnotations!.setRole({
      document_version_id: id,
      section_id: current.sections[2]!.section_id,
      role: "appendix",
      expected_manual_revision: 0,
      actor: "synthetic-user",
    });
    expect(
      (await e.app.documentRead.segments(segmentsRequest)).segments,
    ).toHaveLength(2);
    expect(
      (
        await e.app.documentRead.segments({
          ...segmentsRequest,
          annotation_id: null,
        })
      ).segments,
    ).toHaveLength(0);
    const page = await e.app.documentRead.outline({
      ...request,
      cursor: outline.next_cursor,
    });
    expect(page.sections[0]?.role).toBe("references");
  } finally {
    await e.close();
  }
}, 30000);

it("reads the same historical annotation through CLI and MCP and rejects obsolete writes", async () => {
  const { e, id } = await prepared(false);
  const server = createMcpServer({
    home: e.home,
    maintenance: true,
    applicationFactory: async () => e.app,
    queryFactory: () => createQueryApplication(e.home),
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annotation-test", version: "1" });
  try {
    await server.connect(left);
    await client.connect(right);
    const published = await client.callTool({
      name: "document_annotate",
      arguments: { document_version_id: id, max_prefix_characters: 20 },
    });
    expect(published.isError).toBe(true);
    expect(JSON.stringify(published)).toContain("archive-contract-obsolete");
    const { annotation_id } = await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    const request = {
      document_version_id: id,
      annotation_id,
      field: "all",
      max_bytes: 65536,
      continuation: null,
    };
    async function* stdin() {
      yield Buffer.from(JSON.stringify(request));
    }
    const cli = await runCli(
      ["document", "annotation", "--request", "-", "--json"],
      { home: e.home, stdin: stdin() },
    );
    expect(cli.code).toBe(0);
    const reply = await client.callTool({
      name: "document_annotation",
      arguments: request,
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(reply.structuredContent).toEqual(cli.value);
    const figures = await client.callTool({
      name: "document_read",
      arguments: {
        operation: "figures",
        request: {
          document_version_id: id,
          annotation_id,
          max_bytes: 65536,
          continuation: null,
        },
      },
    });
    expect(figures.isError, JSON.stringify(figures)).not.toBe(true);
    expect(figures.structuredContent).toMatchObject({ result: { text: "[]" } });
    expect(e.modelCalls).toBe(0);
  } finally {
    await client.close();
    await server.close();
    await e.close();
  }
}, 30000);

it("edits roles without model calls and reclassifies an unlocked unknown section only on explicit annotate", async () => {
  const { e, id, store } = await prepared();
  try {
    await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    const base = (await store.current(id))!;
    expect(e.modelCalls).toBe(1);
    const edit = {
      document_version_id: id,
      section_id: base.sections[1]!.section_id,
      role: "methods",
      expected_manual_revision: 0,
      actor: "synthetic-user",
    };
    await e.app.structureAnnotations!.setRole(edit);
    expect(e.modelCalls).toBe(1);
    expect((await store.current(id))?.method).toMatchObject({
      mode: "manual",
      base_annotation_id: base.annotation_id,
    });
    await e.app.structureAnnotations!.setRole({
      ...edit,
      role: null,
      expected_manual_revision: 1,
    });
    expect(e.modelCalls).toBe(1);
    expect((await store.current(id))?.sections[1]).toMatchObject({
      role: "body",
      role_source: "fallback",
      failure_code: "role-reclassification-needed",
      locked: false,
    });
    await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    expect(e.modelCalls).toBe(2);
    expect((await store.current(id))?.sections[1]).toMatchObject({
      role: "discussion",
      role_source: "model",
    });
  } finally {
    await e.close();
  }
}, 30000);
