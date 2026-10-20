import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { runCli } from "../src/cli/main.js";
let observationCounter = 0;
function observation(title: string, abstract: string | null = null) {
  return parseMetadataObservation({
    observation_id: `00000000-0000-4000-8000-${String(++observationCounter).padStart(12, "0")}`,
    source_type: "journal-article",
    source_type_mapping_version: "source-type-v1",
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: "crossref",
      source_record_id: "10.5555/metadata-editor",
      observed_at: "2026-10-20T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...EMPTY_METADATA,
      title,
      abstract,
      publication_form: "journal-article",
      identifiers: [{ namespace: "doi", value: "10.5555/metadata-editor" }],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
describe("metadata editor", () => {
  it("persists authority sources and manual empty locks, survives new observations, and allows explicit unlock", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-metadata-edit-"));
    const app = await createApplication(home);
    const model = vi
      .spyOn(app.agents, "execute")
      .mockRejectedValue(new Error("metadata editor must not call models"));
    try {
      const accepted = await app.identity.observe(
        observation("Provider title", "Provider abstract"),
      );
      if (accepted.disposition !== "accepted")
        throw new Error("synthetic input rejected");
      const id = accepted.literature_id;
      const before = await app.metadataFields.read(id);
      expect(
        before.field_states.find((f) => f.field === "title")?.evidence.source,
      ).toBe("authority");
      const edited = await app.metadataFields.edit({
        literature_id: id,
        expected_revision: before.metadata_revision,
        set: [
          { field: "title", value: "My corrected title" },
          { field: "abstract", value: null },
        ],
        unlock: [],
      });
      expect(edited.metadata_revision).toBe(before.metadata_revision + 1);
      expect(
        edited.field_states.find((f) => f.field === "abstract"),
      ).toMatchObject({
        locked: true,
        value: null,
        evidence: { source: "manual" },
      });
      await app.identity.observe(
        observation("New provider title", "new provider abstract"),
      );
      const retained = await app.metadataFields.read(id);
      expect(retained.literature.metadata.title).toBe("My corrected title");
      expect(retained.literature.metadata.abstract).toBeNull();
      expect(
        retained.field_states.find((f) => f.field === "title")?.conflict,
      ).toBe(true);
      await expect(
        app.metadataFields.edit({
          literature_id: id,
          expected_revision: before.metadata_revision,
          set: [{ field: "title", value: "stale" }],
          unlock: [],
        }),
      ).rejects.toThrow("metadata-revision-stale");
      const unlocked = await app.metadataFields.edit({
        literature_id: id,
        expected_revision: retained.metadata_revision,
        set: [],
        unlock: ["title"],
      });
      expect(
        unlocked.field_states.find((f) => f.field === "title")?.locked,
      ).toBe(false);
      await app.identity.observe(observation("Another observation"));
      const next = await app.metadataFields.read(id);
      expect(next.literature.metadata.title).toBe("Provider title");
      expect(next.literature.metadata.abstract).toBeNull();
      expect(model).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("exposes the same read and edit operations through product entry and CLI without calling a model", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-metadata-interfaces-"),
    );
    const app = await createApplication(home);
    let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const accepted = await app.identity.observe(
        observation("Synthetic paper"),
      );
      if (accepted.disposition !== "accepted") throw new Error("fixture");
      const id = accepted.literature_id;
      const before = await app.metadataFields.read(id);
      const request = {
        literature_id: id,
        expected_revision: before.metadata_revision,
        set: [{ field: "article_kind", value: "review" }],
        unlock: [],
      };
      const edited = await executeMaintenance(app, "metadata-edit", request);
      expect(edited).toMatchObject({
        metadata: { article_kind: "review" },
        metadata_revision: before.metadata_revision + 1,
      });
      q = await createQueryApplication(home);
      const result = await executeQuery(q, "metadata-fields", {
        literature_id: id,
      });
      const file = join(home, "request.json");
      await writeFile(file, JSON.stringify({ literature_id: id }));
      const cli = await runCli(
        ["literature", "metadata-fields", "--request", file],
        { home },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toEqual({ protocol_version: 1, result });
      const server = createMcpServer({
        home,
        maintenance: true,
        applicationFactory: async () => app,
        queryFactory: () => createQueryApplication(home),
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "metadata-test", version: "1" });
      try {
        await server.connect(left);
        await client.connect(right);
        const read = await client.callTool({
          name: "metadata_fields",
          arguments: { literature_id: id },
        });
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toEqual(cli.value);
        const unlock = await client.callTool({
          name: "metadata_edit",
          arguments: {
            literature_id: id,
            expected_revision: before.metadata_revision + 1,
            set: [],
            unlock: ["article_kind"],
          },
        });
        expect(unlock.isError, JSON.stringify(unlock)).not.toBe(true);
        expect(
          (await app.metadataFields.read(id)).field_states.find(
            (f) => f.field === "article_kind",
          )?.locked,
        ).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
      const errors: string[] = [];
      const removed = await runCli(
        ["literature", "search", "--document-type", "article"],
        { home, stderr: (text) => errors.push(text) },
      );
      expect(removed.code).toBe(2);
      expect(errors.join(" ")).toContain("--publication-form");

      await expect(
        executeMaintenance(app, "metadata-edit", {
          ...request,
          set: [{ field: "document_type", value: "article" }],
        }),
      ).rejects.toThrow();
      await expect(
        executeQuery(q, "metadata-fields", { literature_id: id, extra: true }),
      ).rejects.toThrow();
    } finally {
      await q?.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
