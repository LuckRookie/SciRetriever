import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { it, expect, vi } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";

it("refuses draft annotation, metadata, tags and references before opening text or invoking a model", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const parsed = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    if (parsed.draft.status !== "formed")
      throw new Error("Synthetic draft missing");
    const document_version_id = parsed.draft.document_version_id;
    const request = {
      literature_id: f.rawParseRequest.literature_id,
      document_version_id,
      annotation_id: "a".repeat(64),
    };
    const store = new SqliteAnnotationStorage(f.app.database, f.app.files);
    expect(await store.state(document_version_id)).toMatchObject({
      part: null,
      text_level: "draft",
      current: null,
    });
    const bytes = vi
      .spyOn(f.app.files, "withVerified")
      .mockRejectedValue(new Error("Draft must not be consumed"));
    await expect(
      executeMaintenance(f.app, "document-annotate", {
        schema_version: 2,
        document_version_id,
        arrangement_id: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "document-unsupported" });
    await expect(
      f.app.structureAnnotations!.buildRules({ document_version_id }),
    ).rejects.toMatchObject({ code: "document-unsupported" });
    await expect(
      f.app.structureAnnotations!.build({
        document_version_id,
        max_prefix_characters: 100,
      }),
    ).rejects.toMatchObject({ code: "document-unsupported" });
    await expect(
      f.app.archiveMetadata.build({
        ...request,
        expected_revision: (await f.app.library.detail(request.literature_id))
          .metadata_revision,
      }),
    ).rejects.toThrow("metadata-default-proofread-required");
    await expect(f.app.archiveReferences.build(request)).rejects.toMatchObject({
      code: "archive-reference-default-required",
    });
    await expect(f.app.tags.build(request)).rejects.toMatchObject({
      code: "tag-annotation-invalid",
    });
    await expect(
      executeMaintenance(f.app, "proofread-save", {
        schema_version: 2,
        literature_id: request.literature_id,
        asset_id: f.asset.asset_id,
        proofread_id: document_version_id,
        expected_arrangement_id: "b".repeat(64),
        expected_manual_revision: 0,
        markdown: "Synthetic edit",
      }),
    ).rejects.toMatchObject({ code: "publication-conflict" });
    await expect(
      executeMaintenance(f.app, "archive-arrangement-edit", {
        schema_version: 2,
        literature_id: request.literature_id,
        asset_id: f.asset.asset_id,
        expected_proofread_id: document_version_id,
        expected_arrangement_id: "b".repeat(64),
        expected_manual_revision: 0,
        changes: [
          {
            kind: "assign",
            leaf_id: document_version_id,
            target: { role: "methods" },
            presentation: { kind: "content" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "publication-conflict" });
    expect(bytes).not.toHaveBeenCalled();
    expect(f.modelCalls).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);
async function prepared(
  model = true,
  text = "# Methods\n\nA synthetic experiment.\n\n# Electronic landscape\n\n🧪αβγ synthetic paragraph.\n\n# References\n\n[1] Example. doi:10.1234/example\n",
) {
  const e = await coreProcessingFixture({ analysisModel: model });
  try {
    e.setText(text);
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

it("pages annotated segments to the end in source order, including role filters and annotated outline", async () => {
  const paragraphs = (start: number) =>
    Array.from(
      { length: 215 },
      (_, i) => `Synthetic paragraph ${start + i} with exact evidence.\n\n`,
    ).join("");
  const { e, id, store } = await prepared(
    false,
    `# Methods\n\n${paragraphs(0)}# Results\n\n${paragraphs(215)}# References\n\n[1] Example.\n`,
  );
  try {
    const first = await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    const annotation = (await store.byId(first.annotation_id))!;
    const structure = await e.app.documentRead.withVerifiedVersion(
      id,
      async (_v, _bytes, s) => s,
    );
    expect(structure.segments.length).toBeGreaterThan(400);
    const rolesById = new Map(
      annotation.segment_roles.map((r) => [r.segment_id, r.role]),
    );
    for (const roles of [undefined, ["methods", "results"] as const]) {
      const expected = structure.segments
        .filter(
          (s) => !roles || roles.some((r) => r === rolesById.get(s.segment_id)),
        )
        .map((s) => s.segment_id);
      const ids: string[] = [];
      let cursor: string | null = null,
        pinned: string | undefined,
        pages = 0;
      do {
        const page = await e.app.documentRead.segments({
          document_version_id: id,
          section_id: null,
          limit: 200,
          cursor,
          ...(pinned ? { annotation_id: pinned } : {}),
          ...(roles ? { roles } : {}),
        });
        expect(page.annotation_id).toBe(first.annotation_id);
        expect(page.total).toBe(expected.length);
        expect(page.segments.length).toBeLessThanOrEqual(200);
        ids.push(...page.segments.map((s) => s.segment_id));
        cursor = page.next_cursor;
        pinned = page.annotation_id;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(ids).toEqual(expected);
    }
    const sectionIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await e.app.documentRead.outline({
        document_version_id: id,
        annotation_id: first.annotation_id,
        limit: 1,
        cursor,
      });
      expect(page.annotation_id).toBe(first.annotation_id);
      sectionIds.push(...page.sections.map((s) => s.section_id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(sectionIds).toEqual(structure.sections.map((s) => s.section_id));
  } finally {
    await e.close();
  }
}, 30000);

it("rejects annotated segment cursor tampering and cross-version reuse while preserving a pinned annotation", async () => {
  const { e, id, store } = await prepared(false);
  try {
    const annotation = await e.app.structureAnnotations!.build({
      document_version_id: id,
      max_prefix_characters: 20,
    });
    const request = {
      document_version_id: id,
      section_id: null,
      annotation_id: annotation.annotation_id,
      roles: ["methods", "body", "references"],
      limit: 1,
      cursor: null,
    };
    const first = await e.app.documentRead.segments(request);
    expect(first.next_cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(first.next_cursor!, "base64url").toString(),
    ) as Record<string, unknown>;
    const selector = decoded.selector as Record<string, unknown>;
    const changed = (patch: Record<string, unknown>, rehash = true) => {
      const value = { ...decoded, ...patch };
      const core = {
        kind: value.kind,
        version: value.version,
        representation: value.representation,
        selector: value.selector,
        next: value.next,
      };
      return Buffer.from(
        JSON.stringify({
          ...value,
          checksum: rehash
            ? createHash("sha256").update(JSON.stringify(core)).digest("hex")
            : decoded.checksum,
        }),
      ).toString("base64url");
    };
    const reordered = changed({
      selector: {
        roles: selector.roles,
        annotation_id: selector.annotation_id,
        section_id: selector.section_id,
      },
    });
    const next = await e.app.documentRead.segments({
      ...request,
      cursor: reordered,
    });
    expect(next.segments).toHaveLength(1);
    expect(next.segments[0]!.segment_id).not.toBe(
      first.segments[0]!.segment_id,
    );
    const current = (await store.current(id))!;
    for (const patch of [
      {
        selector: { ...selector, section_id: current.sections[0]!.section_id },
      },
      { selector: { ...selector, annotation_id: "f".repeat(64) } },
      { selector: { ...selector, roles: ["references"] } },
      { selector: { ...selector, roles: [...request.roles].reverse() } },
      { selector: { ...selector, extra: true } },
      {
        selector: { section_id: null, annotation_id: annotation.annotation_id },
      },
      { selector: null },
      { kind: "outline" },
      { version: "00000000-0000-0000-0000-000000000999" },
      { representation: "f".repeat(64) },
      { next: -1 },
      { next: 1.5 },
      { next: first.total + 1 },
      { extra: true },
    ])
      await expect(
        e.app.documentRead.segments({ ...request, cursor: changed(patch) }),
      ).rejects.toMatchObject({ code: "document-invalid" });
    await expect(
      e.app.documentRead.segments({
        ...request,
        cursor: changed({ next: 2 }, false),
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    await expect(
      e.app.documentRead.segments({
        ...request,
        section_id: current.sections[0]!.section_id,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    await expect(
      e.app.documentRead.segments({
        ...request,
        roles: ["references"],
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    await e.app.structureAnnotations!.setRole({
      document_version_id: id,
      section_id: current.sections[0]!.section_id,
      role: "results",
      expected_manual_revision: 0,
      actor: "synthetic-user",
    });
    await expect(
      e.app.documentRead.segments({ ...request, cursor: first.next_cursor }),
    ).resolves.toMatchObject({
      annotation_id: annotation.annotation_id,
      segments: next.segments,
    });
    await expect(
      e.app.documentRead.segments({
        ...request,
        annotation_id: null,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    e.setText("# Methods\n\nA new fixed document.\n");
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      force: true,
    });
    const proofread = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const newer = await e.app.proofreadDocuments.publish({
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: 1,
    });
    expect(newer.document.document_version_id).not.toBe(id);
    await expect(
      e.app.documentRead.segments({
        ...request,
        document_version_id: newer.document.document_version_id,
        annotation_id: null,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
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
