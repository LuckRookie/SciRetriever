import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  parseRawParse,
  rawParseIdentity,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import { archiveFixture } from "./archive-fixture.js";
import { imageBytes } from "./archive-text-fixture.js";
import {
  renderArrangement,
  arrangementAnnotation,
} from "../src/archive/render.js";
import { documentIdentity } from "../src/document/proofread-publication.js";
import { documentRepresentationHash } from "../src/document/contract.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RawParserBackend } from "../src/parsing/ports.js";

const oldId = "00000000-0000-0000-0000-000000000071";
const badId = "00000000-0000-0000-0000-000000000072";
const text =
  "Methods\nA synthetic result.\nE = mc^2\nFigure 1. A synthetic figure.";
const descriptor = async (
  bytes: Uint8Array,
  media_type: string,
): Promise<ArtifactRef> => ({
  sha256: await sha256(bytes),
  byte_size: bytes.length,
  media_type,
});

async function fixture() {
  const second = Buffer.from(imageBytes);
  second[second.length - 1] = second[second.length - 1]! ^ 1;
  const resources = await Promise.all(
    [imageBytes, second].map(async (bytes, i) => ({
      reference: i ? "figure.png" : "equation.png",
      content: { bytes, artifact: await descriptor(bytes, "image/png") },
    })),
  );
  const identity = {
    parser_version: "equation-image-fixture-v1",
    model_identity: "fixture",
    parameters_sha256: await sha256(Buffer.from("equation-image-fixture-v1")),
  };
  let parses = 0;
  const parser: RawParserBackend = {
    identity: async () => identity,
    parseRaw: async (request, profile) => {
      parses++;
      const values = [
        { type: "title", text: "Methods", image_ref: null, title_level: 2 },
        {
          type: "text",
          text: "A synthetic result.",
          image_ref: null,
          title_level: null,
        },
        {
          type: "equation",
          text: "E = mc^2",
          image_ref: "equation.png",
          title_level: null,
        },
        { type: "image", text: "", image_ref: "figure.png", title_level: null },
        {
          type: "caption",
          text: "Figure 1. A synthetic figure.",
          image_ref: null,
          title_level: null,
        },
      ];
      const blockBytes = canonicalJsonBytes({
        schema_version: 1,
        page_count: 1,
        blocks: values.map((v, index) => ({
          ...v,
          page: 0,
          index,
          html: null,
          bbox: [0, 0, 900, 200],
          source_type: "synthetic",
        })),
      });
      const markdownBytes = Buffer.from(text),
        privateBytes = Buffer.from("[]");
      const blocks = {
          artifact: await descriptor(blockBytes, "application/json"),
          bytes: blockBytes,
        },
        markdown = {
          artifact: await descriptor(markdownBytes, "text/markdown"),
          bytes: markdownBytes,
        },
        private_content_list = {
          artifact: await descriptor(privateBytes, "application/json"),
          bytes: privateBytes,
        };
      const input = {
        source_asset_id: request.source_asset_id,
        source_sha256: request.source_sha256,
        profile,
        ...identity,
        page_count: 1,
        page_sizes: [[595, 842] as const],
        blocks: blocks.artifact,
        markdown: markdown.artifact,
        private_content_list: private_content_list.artifact,
        resources: resources.map((r) => ({
          reference: r.reference,
          artifact: r.content.artifact,
        })),
      };
      return {
        result: await parseRawParse({
          ...input,
          ...(await rawParseIdentity(input)),
        }),
        blocks,
        markdown,
        private_content_list,
        resources,
      };
    },
  };
  const e = await archiveFixture({ offline: true, rawParser: parser });
  try {
    e.setText(text);
    // Recreate a historical v3 corrected default without a newer draft.
    await e.app.rawParsing!.parseAsset(
      e.asset.asset_id,
      ["pipeline", "vlm-engine"],
      undefined,
      { force: false, expected_sha256: e.asset.sha256 },
    );
    const pipeline = e.app.archiveText!;
    await pipeline.arrange(e.asset.asset_id, "full");
    await pipeline.proofread(e.asset.asset_id, "full", null);
    const state = await pipeline.storage.state(e.asset.asset_id),
      output = (await pipeline.storage.load(
        String(state.current!.proofread_id),
      ))!;
    const old = renderArrangement(
      output.bundle,
      output.version.resources,
      "source-order-leaves-v3",
    );
    expect(old.resources).toHaveLength(2);
    expect(old.markdown.toString()).toContain("![](equation.png)\n$$");
    const markdown = await pipeline.storage.write(
        "proofread-markdown",
        old.markdown,
        "text/markdown",
      ),
      structure = await pipeline.storage.write("document-structure", old.bytes);
    const paths: Record<string, string> = {};
    for (const r of old.resources)
      paths[r.reference] = (await e.app.database.locateArtifact(
        r.artifact,
      ))!.reference;
    await e.app.database.proofread("render-resources", {
      proofread_id: output.version.proofread_id,
      manual_revision: state.manual_revision,
      resources: [
        {
          ...markdown,
          kind: "markdown",
          logical_reference: `render/source-order-leaves-v3/${markdown.sha256}`,
        },
        ...old.resources.map((r) => ({
          ...r.artifact,
          reference: paths[r.reference]!,
          kind: "image",
          logical_reference: r.reference,
        })),
      ],
    });
    const material = (await e.app.database.documentMaterial(
      e.id,
      e.asset.asset_id,
    ))!;
    const declared = old.resources.map((r, i) => ({
      ...r,
      resource_id: `r${i + 1}`,
      relation: "image" as const,
    }));
    const representation = {
      source_material_ref: material.material,
      proofread_id: output.version.proofread_id,
      proofread_content_sha256: output.version.content_sha256,
      builder_version: "source-order-leaves-v3" as const,
      locator_scheme: "utf8-segment-v1" as const,
      markdown: await descriptor(old.markdown, "text/markdown"),
      structure: await descriptor(old.bytes, "application/json"),
      resources: declared,
    };
    await e.app.database.commitDocumentVersion({
      version: {
        schema_version: 2,
        document_id: documentIdentity(e.id, e.asset.asset_id),
        document_version_id: oldId,
        representation_sha256: await documentRepresentationHash(representation),
        ...representation,
      },
      source_artifact_path: material.path,
      markdown_artifact_path: markdown.reference,
      structure_artifact_path: structure.reference,
      resource_artifact_paths: paths,
      expected_default_revision: null,
      expected_manual_revision: state.manual_revision,
    });
    await new SqliteAnnotationStorage(e.app.database, e.app.files).publish(
      arrangementAnnotation(oldId, "main", output.bundle, old),
      {
        expected_manual_revision: 0,
        expected_current_revision: null,
        edit: null,
      },
    );
    return {
      e,
      old,
      paths,
      output,
      get parses() {
        return parses;
      },
      request: {
        schema_version: 2,
        literature_id: e.id,
        asset_id: e.asset.asset_id,
        proofread_id: output.version.proofread_id,
        expected_default_revision: 1,
      },
    };
  } catch (error) {
    await e.close();
    throw error;
  }
}

it("republishes an existing v3 equation-image document through maintenance and MCP with no model, parser or page tools", async () => {
  const f = await fixture();
  let client: Client | undefined,
    server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const calls = f.e.modelCalls,
      parses = f.parses;
    const inspect = vi
      .spyOn(f.e.app.archiveText!.pdf, "inspect")
      .mockRejectedValue(new Error("page tools unavailable"));
    const first = (await executeMaintenance(
      f.e.app,
      "document-publish-proofread",
      f.request,
    )) as { document_version_id: string; annotation_id: string };
    expect(first).toMatchObject({
      published: true,
      default_updated: true,
      default_revision: 2,
      structure_satisfied: true,
    });
    const snapshot = (await f.e.app.database.documentVersion(
      first.document_version_id,
    ))!;
    expect(snapshot.version.builder_version).toBe("source-order-leaves-v4");
    expect(snapshot.version.resources.map((r) => r.reference)).toEqual([
      "figure.png",
    ]);
    expect(
      (
        await f.e.app.database.proofread<{ kind: string }[]>(
          "resources",
          f.request.proofread_id,
        )
      ).filter((r) => r.kind === "image"),
    ).toHaveLength(2);
    const storage = new SqliteDocumentStorage(f.e.app.database, f.e.app.files);
    await storage.withVerifiedDocument(
      first.document_version_id,
      async (_v, bytes) => {
        expect(Buffer.from(bytes).toString()).toContain("$$\nE = mc^2\n$$");
        expect(Buffer.from(bytes).toString()).not.toContain("equation.png");
        expect(Buffer.from(bytes).toString()).toContain("![](figure.png)");
      },
    );
    await storage.withVerifiedDocument(oldId, async (_v, bytes) =>
      expect(Buffer.from(bytes)).toEqual(f.old.markdown),
    );
    const annotations = new SqliteAnnotationStorage(
      f.e.app.database,
      f.e.app.files,
    );
    expect(
      (await annotations.current(first.document_version_id))?.annotation_id,
    ).toBe(first.annotation_id);
    const reader = f.e.app.documentRead;
    expect(
      (
        await reader.segments({
          document_version_id: first.document_version_id,
          section_id: null,
          limit: 200,
          cursor: null,
        })
      ).segments.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await reader.outline({
          document_version_id: first.document_version_id,
          limit: 200,
          cursor: null,
        })
      ).sections.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await reader.slice({
          document_version_id: first.document_version_id,
          selector: {
            kind: "range",
            start_utf8: 0,
            end_utf8: snapshot.version.markdown.byte_size,
          },
          max_bytes: 65536,
          continuation: null,
        })
      ).text,
    ).not.toContain("equation.png");
    expect(
      (
        await reader.resources({
          document_version_id: first.document_version_id,
          limit: 200,
          cursor: null,
        })
      ).resources,
    ).toHaveLength(1);
    server = createMcpServer({
      maintenance: true,
      home: f.e.home,
      applicationFactory: async () => f.e.app,
    });
    client = new Client({ name: "republish-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const again = await client.callTool({
      name: "document_publish_proofread",
      arguments: f.request,
    });
    expect(again.isError).not.toBe(true);
    expect(again.structuredContent).toMatchObject({
      result: {
        document_version_id: first.document_version_id,
        published: false,
        default_revision: 2,
      },
    });
    expect(f.e.modelCalls).toBe(calls);
    expect(f.parses).toBe(parses);
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await client?.close();
    await server?.close();
    await f.e.close();
  }
}, 30000);

it("keeps publication CAS and image provenance checks while exposing stable storage failures", async () => {
  const f = await fixture();
  try {
    await expect(
      executeMaintenance(f.e.app, "document-publish-proofread", {
        ...f.request,
        expected_default_revision: 99,
      }),
    ).rejects.toMatchObject({ code: "publication-conflict" });
    expect(
      await f.e.app.database.documentDefault(
        f.e.id,
        f.e.asset.asset_id,
        f.e.asset.sha256,
      ),
    ).toMatchObject({ document_version_id: oldId, revision: 1 });
    const result = (await executeMaintenance(
      f.e.app,
      "document-publish-proofread",
      f.request,
    )) as { document_version_id: string };
    const snapshot = (await f.e.app.database.documentVersion(
      result.document_version_id,
    ))!;
    if (snapshot.version.schema_version !== 2)
      throw new Error("v2 document required");
    const {
      schema_version: _schema,
      document_id: _doc,
      document_version_id: _id,
      representation_sha256: _hash,
      ...representation
    } = snapshot.version;
    void _schema;
    void _doc;
    void _id;
    void _hash;
    const resources = snapshot.version.resources.map((r) => ({
      ...r,
      reference: "unregistered.png",
    }));
    await expect(
      f.e.app.database.commitDocumentVersion({
        version: {
          ...snapshot.version,
          document_version_id: badId,
          resources,
          representation_sha256: await documentRepresentationHash({
            ...representation,
            resources,
          }),
        },
        source_artifact_path: snapshot.source_artifact_path,
        markdown_artifact_path: snapshot.markdown_artifact_path,
        structure_artifact_path: snapshot.structure_artifact_path,
        resource_artifact_paths: { "unregistered.png": f.paths["figure.png"]! },
        expected_default_revision: 2,
        expected_manual_revision: 0,
      }),
    ).rejects.toMatchObject({
      code: "document-resources-mismatch",
      message: "sqlite worker operation failed",
    });
    expect(await f.e.app.database.documentVersion(badId)).toBeNull();
    const unused = f.output.version.resources.find(
      (r) => r.reference === "equation.png",
    )!;
    const extra = {
      resource_id: "unused-equation",
      reference: unused.reference,
      relation: "image" as const,
      artifact: unused.artifact,
    };
    const storage = new SqliteDocumentStorage(f.e.app.database, f.e.app.files);
    for (const resources of [
      [],
      [extra],
      [...snapshot.version.resources, extra],
    ])
      expect(
        await storage.inspectExactInput({ ...representation, resources }),
      ).toBe("integrity-failure");
  } finally {
    await f.e.close();
  }
}, 30000);
