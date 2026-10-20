import { expect, it } from "vitest";
import { archiveFixture } from "./archive-fixture.js";
import {
  ProcessorRegistry,
  ProcessorService,
  type Processor,
} from "../src/analysis/processor.js";
import { ProcessorArchiveSource } from "../src/analysis/processor-archive.js";
import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
it("supports metadata-only collection operators and invalidates only declared description use", async () => {
  const e = await archiveFixture();
  let service: ProcessorService | undefined,
    store: SqliteProcessorStorage | undefined;
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    const snapshot = await e.app.snapshots.create({
        kind: "literatures",
        literature_ids: [e.id],
      }),
      registry = new ProcessorRegistry();
    for (const uses_description of [false, true]) {
      const processor: Processor = {
        id: uses_description ? "fixture-titles" : "fixture-count",
        version: "2",
        scope: "collection",
        accepts: ["snapshot"],
        model: false,
        uses_description,
        reads: { parts: "main", roles: "all" },
        output_kind: "records",
        definition: {},
        spec_schema: { type: "object" },
        normalizeSpec: () => ({}),
        async run(invocation, ctx) {
          const described = await ctx.describeSnapshot();
          expect(described.members.length).toBe(uses_description ? 1 : 0);
          const value = uses_description
            ? described.members[0]!.metadata.title
            : described.count;
          return {
            status: "ok",
            content: {
              kind: "records",
              schema: {
                type: "object",
                properties: {
                  value: { type: uses_description ? "string" : "integer" },
                },
                required: ["value"],
                additionalProperties: false,
              },
              records: [
                {
                  record_id: "value",
                  payload: { value },
                  missing: {},
                  evidence: [
                    {
                      pointer: "/value",
                      sources: [
                        described.citation(
                          uses_description ? e.id : null,
                          uses_description ? "/metadata/title" : "/count",
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            coverage: [
              {
                input_id: invocation.inputs[0]!.input_id,
                status: "complete",
                read_segments: [],
                gaps: [],
              },
            ],
          };
        },
      };
      registry.register(processor);
    }
    store = new SqliteProcessorStorage(
      e.app.database,
      e.app.files,
      e.app.documentRead,
    );
    service = new ProcessorService(
      registry,
      e.app.documentRead,
      e.app.agents,
      e.app.library,
      store,
      new ProcessorArchiveSource(
        e.app.archive,
        e.app.snapshots,
        new SqliteAnnotationStorage(e.app.database, e.app.files),
        e.app.documentRead,
      ),
    );
    const ids: string[] = [];
    const calls = e.modelCalls;
    for (const id of ["fixture-count", "fixture-titles"]) {
      const prepared = await service.prepare({
        schema_version: 1,
        idempotency_key: id,
        name: id,
        processor: { id, version: "2" },
        spec: {},
        inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      });
      ids.push((await service.execute(prepared.invocations[0])).result_id);
    }
    const before = await store.byId(ids[1]!);
    expect(before!.freshness?.state).toBe("current");
    if (before!.result.content.kind !== "records")
      throw new Error("records required");
    const citation =
      before!.result.content.records[0]!.evidence[0]!.sources[0]!;
    expect((await store.verifyCitation(citation)).value).toBe(
      (await e.app.library.detail(e.id)).literature.metadata.title,
    );
    const meta = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: meta.metadata_revision,
      set: [{ field: "title", value: "Changed title" }],
      unlock: [],
    });
    expect((await store.byId(ids[0]!))!.freshness?.state).toBe("current");
    expect((await store.byId(ids[1]!))!.freshness?.state).toBe("stale");
    expect(e.modelCalls).toBe(calls);
  } finally {
    await service?.close();
    await store?.close();
    await e.close();
  }
});
