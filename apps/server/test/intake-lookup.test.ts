import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type Identifier,
  type IntakeLookupResult,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { finishIntake, startIntake } from "../src/literature/intake.js";
import { IntakeRecognitionService } from "../src/literature/intake-recognition.js";
import { lookupLines } from "../src/literature/lookup-adapter.js";

function work(
  title: string,
  doi: string,
  source = "crossref",
  family = "Tester",
) {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    metadata: {
      ...EMPTY_METADATA,
      title,
      publication_year: 2026,
      authors: [
        {
          kind: "person",
          display_name: `Ada ${family}`,
          given_name: "Ada",
          family_name: family,
          orcid: null,
          affiliations: [],
        },
      ],
      identifiers: [{ namespace: "doi", value: doi }],
    },
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
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
const KNOWN = work("Nitrogen rich heterocycles by design", "10.5555/known"),
  UNIQUE = work("A uniquely titled synthetic survey", "10.5555/unique"),
  TWIN_A = work("Twin titled synthetic article", "10.5555/twin-a"),
  TWIN_B = work("Twin titled synthetic article", "10.5555/twin-b", "openalex"),
  // Similarity 0.94: close, not the same title.
  NEAR = work("A merely similar synthetic heading", "10.5555/near"),
  KEPT = work("Already collected synthetic paper", "10.5555/kept"),
  CANDIDATE = work("Discovered synthetic candidate paper", "10.5555/found"),
  DELETED = work("Recently deleted synthetic paper", "10.5555/deleted");
const sources = {
  lookup: vi.fn(async (ids: readonly Identifier[]) =>
    [KNOWN, KEPT, CANDIDATE, DELETED].filter((o) =>
      ids.some((id) => id.value === o.metadata.identifiers[0]!.value),
    ),
  ),
  search: vi.fn(async (title: string) =>
    title.startsWith("A uniquely")
      ? [UNIQUE]
      : title.startsWith("Twin")
        ? [TWIN_A, TWIN_B]
        : title.startsWith("A merely")
          ? [NEAR]
          : [],
  ),
};

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-lookup-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { recognition: new IntakeRecognitionService(sources) },
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  // Only the fake recognition sources above answer; no source port exists.
  expect(app.metadata.lookup_selection).toEqual([]);
  expect(app.metadata.topic_selection).toEqual([]);
  const actor = { kind: "local" as const, origin: "web" as const };
  return {
    home,
    app,
    async batch(text: string) {
      const batch = await app.importSessions.create(
        { format: "lookup", source: null, scope: "Synthetic lookup" },
        actor,
      );
      await app.importSessions.putData(batch.batch_id, 0, text);
      return batch.batch_id as string;
    },
    async ready(id: string) {
      await vi.waitFor(
        async () =>
          expect((await app.importSessions.preview(id)).recognition.state).toBe(
            "done",
          ),
        { timeout: 20000, interval: 20 },
      );
      return app.importSessions.preview(id);
    },
    async items(id: string) {
      return (await app.importSessions.items(id, null, 200)).items.sort(
        (a, b) => a.lookup!.line - b.lookup!.line,
      );
    },
    decide(id: string, item: string, decision: unknown) {
      return app.importSessions.decide(id, item, decision as never, actor);
    },
    async finish(id: string) {
      await app.importSessions.confirm(id);
      const report = await app.importSessions.report(id, null, 200);
      expect(report.batch.state).toBe("finished");
      return report;
    },
    trashed(id: string) {
      const db = new DatabaseSync(join(home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        return !!db
          .prepare("SELECT 1 FROM library_trash WHERE literature_id=?")
          .get(id);
      } finally {
        db.close();
      }
    },
    needs(id: string) {
      const db = new DatabaseSync(join(home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        return !!db
          .prepare(
            "SELECT 1 FROM literature_needs_metadata WHERE literature_id=?",
          )
          .get(id);
      } finally {
        db.close();
      }
    },
    async close() {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

it("classifies lookup lines in the specified order without any lookup", () => {
  const lines = lookupLines(
    [
      "10.5555/Bare.DOI",
      "doi: 10.5555/prefixed",
      "https://doi.org/10.5555/resolver",
      "https://pubs.example.org/doi/full/10.5555/publisher",
      "",
      "   ",
      "arXiv:2101.00001v2",
      "https://arxiv.org/abs/hep-th/9901001",
      "PMID: 12345678",
      "https://pubmed.ncbi.nlm.nih.gov/23456789/",
      "https://example.org/some/article",
      "Too short",
      `A${" very long synthetic title".repeat(20)}`,
      "A complete synthetic title about energetic salts",
      "doi:10.5555/bare.doi",
      "a complete SYNTHETIC title about energetic salts!",
    ].join("\r\n"),
  );
  expect(
    lines.map((l) => [
      l.line,
      l.kind,
      l.identifier?.value ?? l.title,
      l.reason,
    ]),
  ).toEqual([
    [1, "doi", "10.5555/bare.doi", null],
    [2, "doi", "10.5555/prefixed", null],
    [3, "doi", "10.5555/resolver", null],
    [4, "doi", "10.5555/publisher", null],
    [7, "arxiv", "2101.00001", null],
    [8, "arxiv", "hep-th/9901001", null],
    [9, "pmid", "12345678", null],
    [10, "pmid", "23456789", null],
    [11, null, null, "lookup-unsupported-url"],
    [12, null, null, "lookup-too-short"],
    [13, null, null, "lookup-too-long"],
    [14, "title", "A complete synthetic title about energetic salts", null],
    [15, null, null, "duplicate-line"],
    [16, null, null, "duplicate-line"],
  ]);
  expect(lines[4]!.text).toBe("arXiv:2101.00001v2");
  expect(() =>
    lookupLines(
      Array.from({ length: 201 }, (_, i) => `10.5555/line-${i}`).join("\n"),
    ),
  ).toThrow(expect.objectContaining({ code: "intake-lookup-too-many" }));
  expect(
    lookupLines(
      Array.from({ length: 200 }, (_, i) => `10.5555/line-${i}`).join("\n\n"),
    ),
  ).toHaveLength(200);
});

it("previews the four outcomes, decides per line and admits into the library", async () => {
  const f = await fixture();
  try {
    // One paper already collected, one only a candidate of a topic search.
    const kept = await f.batch("10.5555/kept");
    await f.ready(kept);
    const keptId = (await f.finish(kept)).items[0]!.literature_id!;
    const topic = await startIntake(
      f.app.database,
      "topic",
      "Topic",
      {},
      "cli",
    );
    const found = await f.app.identity.observe(CANDIDATE, {
      intake_batch_id: topic,
    });
    await finishIntake(f.app.database, topic, "completed");
    if (found.disposition !== "accepted") throw new Error("fixture");
    expect((await f.app.library.detail(found.literature_id)).collected).toBe(
      false,
    );
    // One recently deleted paper: deleted papers still match by identifier.
    const later = await startIntake(
      f.app.database,
      "topic",
      "Topic",
      {},
      "cli",
    );
    const deleted = await f.app.identity.observe(DELETED, {
      intake_batch_id: later,
    });
    await finishIntake(f.app.database, later, "completed");
    if (deleted.disposition !== "accepted") throw new Error("fixture");
    await executeMaintenance(f.app, "library-trash", {
      operation: "delete",
      selector: {
        kind: "literatures",
        literature_ids: [deleted.literature_id],
      },
    });
    expect(f.trashed(deleted.literature_id)).toBe(true);

    // 200 non-empty lines per batch, whatever the segments.
    const lines = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `10.5555/limit-${from + i}`).join(
        "\n\n",
      );
    const limited = await f.batch(lines(0, 150));
    await expect(
      f.app.importSessions.putData(limited, 1, lines(150, 51)),
    ).rejects.toMatchObject({ code: "intake-lookup-too-many" });
    await f.app.importSessions.putData(limited, 1, lines(150, 50));
    await expect(
      f.app.importSessions.putData(limited, 2, "10.5555/limit-one-more"),
    ).rejects.toMatchObject({ code: "intake-lookup-too-many" });
    expect((await f.app.importSessions.status(limited)).state).toBe(
      "awaiting-confirmation",
    );

    sources.lookup.mockClear();

    const id = await f.batch(
      [
        "https://doi.org/10.5555/known",
        "10.5555/missing",
        "A uniquely titled synthetic survey",
        "Twin titled synthetic article",
        "A merely similar synthetic headline",
        "An unknown synthetic title nobody indexed",
        "10.5555/kept",
        "doi:10.5555/found",
        "https://example.org/not-a-paper",
        "short",
        "10.5555/KNOWN",
        "https://doi.org/10.5555/deleted",
      ].join("\n"),
    );
    expect((await f.app.importSessions.status(id)).label).toBe("指定文献");
    const preview = await f.ready(id);
    expect(preview.summary.lookup).toEqual({
      lines: 12,
      recognized: 2,
      existing: 3,
      candidates: 2,
      unrecognized: 2,
      included: 0,
      rejected: 2,
      duplicates: 1,
      pending: 0,
    });
    expect(preview.summary.records.rejected).toBe(2);
    expect(preview.summary.excluded).toContainEqual({
      kind: "duplicate-line",
      count: 1,
    });
    const items = await f.items(id);
    expect(
      items.map((i) => [i.lookup!.line, i.lookup!.outcome, i.lookup!.reason]),
    ).toEqual([
      [1, "recognized", null],
      [2, "unrecognized", null],
      [3, "recognized", null],
      [4, "candidates", null],
      [5, "candidates", null],
      [6, "unrecognized", null],
      [7, "existing", null],
      [8, "existing", null],
      [9, "rejected", "lookup-unsupported-url"],
      [10, "rejected", "lookup-too-short"],
      [11, "duplicate", "duplicate-line"],
      [12, "existing", null],
    ]);
    // Library papers are matched without asking any source.
    const asked = sources.lookup.mock.calls.flatMap(([ids]) =>
      ids.map((id) => id.value),
    );
    expect(asked.sort()).toEqual(["10.5555/known", "10.5555/missing"]);
    expect(items[7]!.lookup!.found).toMatchObject({
      title: CANDIDATE.metadata.title,
    });
    expect(items[0]!.lookup!.found).toMatchObject({
      title: KNOWN.metadata.title,
      first_author: "Ada Tester",
      identifiers: [{ namespace: "doi", value: "10.5555/known" }],
    });
    expect(items[6]!.recognition!.literature_id).toBe(keptId);
    expect(items[3]!.needs_decision).toBe(true);
    expect(items[3]!.recognition!.candidates.map((c) => c.identifiers)).toEqual(
      [
        [{ namespace: "doi", value: "10.5555/twin-a" }],
        [{ namespace: "doi", value: "10.5555/twin-b" }],
      ],
    );
    // Recognition of the title goes once per line, never with the title check.
    expect(sources.search).not.toHaveBeenCalledWith(
      "https://doi.org/10.5555/known",
      expect.anything(),
    );
    await expect(
      f.decide(id, items[0]!.item_id, { kind: "include" }),
    ).rejects.toMatchObject({ code: "intake-decision-invalid" });
    await expect(
      f.decide(id, items[8]!.item_id, { kind: "include" }),
    ).rejects.toMatchObject({ code: "intake-decision-invalid" });
    const chosen = await f.decide(id, items[3]!.item_id, {
      kind: "candidate",
      candidate_id: items[3]!.recognition!.candidates[1]!.candidate_id,
    });
    expect(chosen.lookup!.outcome).toBe("recognized");
    expect(
      (await f.decide(id, items[5]!.item_id, { kind: "include" })).lookup,
    ).toMatchObject({ outcome: "unrecognized", included: true });

    const calls = sources.search.mock.calls.length;
    const report = await f.finish(id);
    expect(sources.search.mock.calls.length).toBe(calls);
    const byLine = new Map(report.items.map((i) => [i.line!.number, i]));
    expect(byLine.get(1)).toMatchObject({
      disposition: "created",
      reason: null,
      line: { number: 1, text: "https://doi.org/10.5555/known" },
    });
    expect(byLine.get(2)).toMatchObject({
      disposition: "excluded",
      reason: "lookup-unrecognized",
    });
    expect(byLine.get(4)).toMatchObject({ disposition: "created" });
    expect(byLine.get(5)).toMatchObject({
      disposition: "excluded",
      reason: "lookup-candidates",
    });
    expect(byLine.get(6)).toMatchObject({
      disposition: "created",
      reason: "lookup-unrecognized",
    });
    expect(byLine.get(7)).toMatchObject({
      disposition: "matched",
      literature_id: keptId,
    });
    expect(byLine.get(8)).toMatchObject({
      disposition: "matched",
      literature_id: found.literature_id,
    });
    expect(byLine.get(9)).toMatchObject({
      disposition: "rejected",
      reason: "lookup-unsupported-url",
      line: { number: 9, text: "https://example.org/not-a-paper" },
    });
    expect(byLine.get(10)).toMatchObject({
      disposition: "rejected",
      reason: "lookup-too-short",
    });
    expect(byLine.get(11)).toMatchObject({
      disposition: "excluded",
      reason: "duplicate-line",
    });
    expect(byLine.get(12)).toMatchObject({
      disposition: "restored",
      literature_id: deleted.literature_id,
    });
    expect(f.trashed(deleted.literature_id)).toBe(false);
    expect(report.summary.lookup).toMatchObject({
      recognized: 3,
      existing: 3,
      candidates: 1,
      unrecognized: 2,
      included: 1,
    });
    expect(report.summary.records.needs_metadata).toBe(1);
    expect(report.batch.kind).toBe("import");
    expect(sources.lookup.mock.calls.length).toBe(2);
    for (const line of [1, 3, 4, 6, 7, 8, 12]) {
      const literature = byLine.get(line)!.literature_id!;
      expect((await f.app.library.detail(literature)).collected).toBe(true);
    }
    expect(f.needs(byLine.get(6)!.literature_id!)).toBe(true);
    expect(f.needs(byLine.get(3)!.literature_id!)).toBe(false);
    const twin = await f.app.library.detail(byLine.get(4)!.literature_id!);
    expect(twin.literature.metadata.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.5555/twin-b",
    });
  } finally {
    await f.close();
  }
}, 60000);

it("adds named papers synchronously over CLI and stdio MCP and lists the lines not added", async () => {
  const f = await fixture();
  const host = createMcpServer({
    home: f.home,
    maintenance: true,
    sharedApplications: true,
    applicationFactory: async () => f.app,
  });
  const [server, transport] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: "lookup-fixture", version: "1" });
  const cliHome = await mkdtemp(join(tmpdir(), "sciretriever-lookup-cli-"));
  try {
    await host.connect(server);
    await client.connect(transport);
    const mcp = await client.callTool({
      name: "add_literatures",
      arguments: {
        lines: [
          "10.5555/known",
          "Twin titled synthetic article",
          "",
          "https://example.org/x",
        ],
      },
    });
    expect(mcp.isError).not.toBe(true);
    const result = (mcp.structuredContent as { result: IntakeLookupResult })
      .result;
    expect(result.added).toMatchObject([
      {
        line: 1,
        text: "10.5555/known",
        disposition: "created",
        title: KNOWN.metadata.title,
      },
    ]);
    expect(result.not_added).toEqual([
      {
        line: 2,
        text: "Twin titled synthetic article",
        disposition: "excluded",
        reason: "lookup-candidates",
        candidates: [
          {
            title: "Twin titled synthetic article",
            first_author: "Ada Tester",
            publication_year: 2026,
            identifiers: [{ namespace: "doi", value: "10.5555/twin-a" }],
          },
          {
            title: "Twin titled synthetic article",
            first_author: "Ada Tester",
            publication_year: 2026,
            identifiers: [{ namespace: "doi", value: "10.5555/twin-b" }],
          },
        ],
      },
      {
        line: 4,
        text: "https://example.org/x",
        disposition: "rejected",
        reason: "lookup-unsupported-url",
        candidates: [],
      },
    ]);
    expect(
      await f.app.library.intakeBatches({
        operation: "get",
        request: { batch_id: result.intake_batch_id },
      }),
    ).toMatchObject({ kind: "import", origin: "mcp", state: "finished" });
    const tooMany = await client.callTool({
      name: "add_literatures",
      arguments: {
        text: Array.from({ length: 201 }, (_, i) => `10.5555/n${i}`).join("\n"),
      },
    });
    expect(tooMany.isError).toBe(true);
    expect(JSON.stringify(tooMany.structuredContent)).toContain(
      "intake-lookup-too-many",
    );

    // CLI with no metadata sources configured: nothing is recognized.
    await mkdir(join(cliHome, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(cliHome, ".sciretriever", "config.toml"),
      '[sources.metadata]\nmode = "custom"\nproviders = []\n',
      { mode: 0o600 },
    );
    // The CLI builds this same application: prove it selects no source.
    const probe = await createApplication(cliHome, {
      indexRefreshIntervalMs: null,
    });
    try {
      expect(probe.metadata.lookup_selection).toEqual([]);
      expect(probe.metadata.topic_selection).toEqual([]);
    } finally {
      await probe.close();
    }
    const request = join(cliHome, "lookup.json");
    await writeFile(
      request,
      JSON.stringify({ text: "10.5555/offline\nshort\n" }),
    );
    const printed: string[] = [];
    const cli = await runCli(["import", "lookup", "--request", request], {
      home: cliHome,
      stdout: (value) => printed.push(value),
      stderr: () => {},
    });
    expect(cli.code).toBe(0);
    const value = JSON.parse(printed.join("")).result as IntakeLookupResult;
    expect(value.added).toEqual([]);
    expect(value.not_added).toEqual([
      {
        line: 1,
        text: "10.5555/offline",
        disposition: "excluded",
        reason: "lookup-unrecognized",
        candidates: [],
      },
      {
        line: 2,
        text: "short",
        disposition: "rejected",
        reason: "lookup-too-short",
        candidates: [],
      },
    ]);
    expect(value.summary).toMatchObject({ lines: 2, unrecognized: 1 });
  } finally {
    await client.close();
    await host.close();
    await f.close();
    await rm(cliHome, { recursive: true, force: true });
  }
}, 60000);
