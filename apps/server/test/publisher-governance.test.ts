import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
  parseLiteratureDetail,
  canonicalJsonBytes,
  sha256,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type { AgentCall, AgentResult } from "../src/agents/protocol.js";
import { createApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  acceptPublisherNameMappings,
  PublisherGovernanceService,
} from "../src/entry/publisher-governance.js";
import { resolvePublisherNames } from "../src/providers/publisher-names.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const provenance = {
  provider: "fixture",
  model: "model",
  usage: { input_tokens: 1, output_tokens: 1 },
};
async function detail(
  n: number,
  publisher: string,
  sites: readonly string[] = [],
  observationPublisher = publisher,
): Promise<LiteratureDetail> {
  const literature = parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(1000 + n),
    metadata: { ...FIXTURE_LITERATURE.metadata, publisher },
  });
  const observation = parseMetadataObservation({
    observation_id: id(2000 + n),
    metadata: { ...literature.metadata, publisher: observationPublisher },
    provenance: {
      provenance_id: id(3000 + n),
      source_kind: "metadata-provider",
      source_name: "crossref",
      source_record_id: `fixture-${n}`,
      observed_at: "2026-10-11T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: sites.map((url) => ({
      url,
      kind: "landing-page",
      media_type: null,
      asset_role: null,
      version_role: null,
      access_status: null,
      license: null,
    })),
  });
  return parseLiteratureDetail({
    literature,
    meta_literature: {
      meta_literature_id: literature.meta_literature_id,
      representative_literature_id: literature.literature_id,
    },
    metadata_revision: 1,
    metadata_sha256: await sha256(canonicalJsonBytes(literature.metadata)),
    missing_step: "primary-pdf",
    needs_manual_pdf: false,
    metadata_observations: [observation],
    primary_pdf: null,
    additional_assets: [],
    parser_result: null,
    content: null,
    other_versions: [],
    reference_count: 0,
    cited_by_count: 0,
  });
}
function library(items: readonly LiteratureDetail[]) {
  return {
    detail: vi.fn(async (value: unknown) => {
      const found = items.find(
        (item) => item.literature.literature_id === value,
      );
      if (!found) throw new Error("fixture not found");
      return found;
    }),
    search: vi.fn(async (value: unknown) => {
      const request = value as { cursor: string | null; limit: number };
      const start = Number(request.cursor ?? 0);
      const end = Math.min(items.length, start + request.limit);
      return {
        items: items.slice(start, end),
        total_count: items.length,
        next_cursor: end < items.length ? String(end) : null,
      };
    }),
  };
}
function runtime(reply: (call: AgentCall) => AgentResult) {
  const execute = vi.fn(async (call: AgentCall) => reply(call));
  const agent = new DshAgentRuntime([
    {
      role: "analysis",
      provider: "fixture",
      model: "model",
      capabilities: ["structured_text"],
      reasoning: "default",
      stream: false,
      context_window_tokens: 100_000,
      max_output_tokens: 10_000,
      adapter: { provider: "fixture", model: "model", execute },
    },
  ]);
  return { agent, execute };
}
const mappingReply =
  (provider = "elsevier") =>
  (call: AgentCall): AgentResult => {
    const part = call.messages[1]!.parts[0]!;
    if (!("text" in part)) throw new Error("fixture expected text");
    const input = JSON.parse(part.text) as { names: { name: string }[] };
    return {
      kind: "structured",
      value: {
        mappings: input.names.map(({ name }) => ({
          name,
          provider_id: provider,
        })),
      },
      provenance,
    };
  };

it("matches registered aliases deterministically and leaves unknown/conflicting candidates unresolved", () => {
  expect(resolvePublisherNames("  ELSEVIER　 BV ")).toEqual(["elsevier"]);
  expect(resolvePublisherNames("Public Library of Science (PLoS)")).toEqual([
    "plos",
  ]);
  expect(resolvePublisherNames("unknown press")).toEqual([]);
  expect(resolvePublisherNames("crossref")).toEqual([]);
  expect(
    resolvePublisherNames("ambiguous", {
      elsevier: ["Ambiguous"],
      wiley: ["ambiguous"],
    }),
  ).toEqual(["elsevier", "wiley"]);
  expect(resolvePublisherNames("Elsevier", { wiley: ["Elsevier"] })).toEqual([
    "elsevier",
    "wiley",
  ]);
});

it("validates optional aliases without changing default configuration or source spellings", () => {
  expect(parseConfiguration("").sources.publisher_aliases).toBeUndefined();
  expect(
    parseConfiguration(
      '[sources.publisher_aliases]\nelsevier = ["  Local Press  "]\n',
    ).sources.publisher_aliases,
  ).toEqual({ elsevier: ["  Local Press  "] });
  for (const text of [
    '[sources.publisher_aliases]\nunknown = ["Name"]',
    '[sources.publisher_aliases]\nelsevier = ["Name", " NAME "]',
    '[sources.publisher_aliases]\nelsevier = [""]',
    '[sources.publisher_aliases]\nelsevier = "Name"',
  ])
    expect(() => parseConfiguration(text)).toThrow();
});

describe("publisher name maintenance", () => {
  it("counts distinct articles and preserves source observations without default model calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-"));
    const rows = [
      await detail(1, "Elsevier BV", [], "ELSEVIER  BV"),
      await detail(2, "Elsevier BV"),
      await detail(3, "Unknown Press"),
      await detail(4, "Ambiguous", [
        "https://www.sciencedirect.com/article/a",
        "https://onlinelibrary.wiley.com/doi/b",
      ]),
    ];
    const before = JSON.stringify(rows);
    const model = runtime(mappingReply());
    try {
      const service = new PublisherGovernanceService(
        library(rows),
        new TypeScriptConfigurationOwner(home),
        model.agent,
      );
      const report = await service.report({ selector: { kind: "all" } });
      expect(report).toMatchObject({
        scanned_literatures: 4,
        complete: true,
        ai_requests: 0,
      });
      expect(
        report.entries.find((entry) => entry.name === "elsevier bv"),
      ).toMatchObject({
        literature_count: 2,
        status: "resolved",
        source_names: ["crossref"],
        raw_names: [
          { name: "ELSEVIER  BV", literature_count: 1 },
          { name: "Elsevier BV", literature_count: 2 },
        ],
      });
      expect(
        report.entries.find((entry) => entry.name === "ambiguous")?.status,
      ).toBe("conflict");
      expect(model.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(rows)).toBe(before);
      expect(
        (await new TypeScriptConfigurationOwner(home).read()).revision,
      ).toBe("missing");
    } finally {
      model.agent.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("paginates a bounded scope, reports continuation, and deduplicates unknown names before inference", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-"));
    const rows = await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        detail(index + 1, index % 2 ? " Novel Press " : "NOVEL PRESS"),
      ),
    );
    const query = library(rows);
    const model = runtime(mappingReply());
    try {
      const service = new PublisherGovernanceService(
        query,
        new TypeScriptConfigurationOwner(home),
        model.agent,
      );
      const report = await service.report({
        selector: { kind: "all" },
        scan_limit: 201,
        ai: true,
      });
      expect(
        query.search.mock.calls.map(
          ([call]) => (call as { limit: number }).limit,
        ),
      ).toEqual([200, 1]);
      expect(report).toMatchObject({
        scanned_literatures: 201,
        complete: false,
        next_cursor: "201",
        ai_requests: 1,
      });
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]).toMatchObject({
        name: "novel press",
        literature_count: 201,
        suggestion: { provider_id: "elsevier" },
      });
      expect(model.execute).toHaveBeenCalledTimes(1);
      const resumed = await service.report({
        selector: { kind: "all" },
        cursor: report.next_cursor,
      });
      expect(resumed).toMatchObject({ scanned_literatures: 4, complete: true });
    } finally {
      model.agent.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    { mappings: [{ name: "invented", provider_id: "elsevier" }] },
    { mappings: [{ name: "novel press", provider_id: "invented" }] },
    {
      mappings: [
        { name: "novel press", provider_id: "elsevier", confidence: 1 },
      ],
    },
    { mappings: [] },
    {
      mappings: [
        { name: "novel press", provider_id: "elsevier" },
        { name: "novel press", provider_id: "wiley" },
      ],
    },
    {
      mappings: [{ name: "novel press", provider_id: "elsevier" }],
      url: "https://invented.test",
    },
  ])(
    "reports malformed model responses without publishing mappings: %j",
    async (value) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-"));
      const model = runtime(() => ({ kind: "structured", value, provenance }));
      try {
        const owner = new TypeScriptConfigurationOwner(home);
        const report = await new PublisherGovernanceService(
          library([await detail(1, "Novel Press")]),
          owner,
          model.agent,
        ).report({ selector: { kind: "all" }, ai: true });
        expect(report.entries[0]).toMatchObject({
          status: "unknown",
          suggestion: null,
          ai_failure: "invalid-response",
        });
        await expect(
          acceptPublisherNameMappings(owner, report, ["novel press"]),
        ).rejects.toThrow();
        expect((await owner.read()).revision).toBe("missing");
      } finally {
        model.agent.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects suggestions contradicted by article sites and does not infer conflict names", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-"));
    const model = runtime(mappingReply("elsevier"));
    try {
      const report = await new PublisherGovernanceService(
        library([
          await detail(1, "Novel Press", [
            "https://onlinelibrary.wiley.com/doi/example",
          ]),
          await detail(2, "Elsevier", [
            "https://onlinelibrary.wiley.com/doi/example",
          ]),
        ]),
        new TypeScriptConfigurationOwner(home),
        model.agent,
      ).report({ selector: { kind: "all" }, ai: true });
      expect(
        report.entries.find((entry) => entry.name === "novel press"),
      ).toMatchObject({ suggestion: null, ai_failure: "context-conflict" });
      expect(
        report.entries.find((entry) => entry.name === "elsevier"),
      ).toMatchObject({ status: "conflict", suggestion: null });
      expect(model.execute).toHaveBeenCalledTimes(1);
    } finally {
      model.agent.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("accepts only explicit selected suggestions, rejects stale reports, and reuses aliases on restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-"));
    const model = runtime(mappingReply());
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const rows = [
        await detail(1, "Novel Press"),
        await detail(2, "Another Press"),
      ];
      const service = new PublisherGovernanceService(
        library(rows),
        owner,
        model.agent,
      );
      const report = await service.report({
        selector: { kind: "literatures", literature_ids: [id(1), id(2)] },
        ai: true,
      });
      const accepted = await acceptPublisherNameMappings(owner, report, [
        "novel press",
      ]);
      expect(accepted.accepted_names).toEqual(["novel press"]);
      expect(
        (await owner.read()).configuration.sources.publisher_aliases,
      ).toEqual({ elsevier: ["Novel Press"] });
      await expect(
        acceptPublisherNameMappings(owner, report, ["another press"]),
      ).rejects.toMatchObject({ code: "configuration-conflict" });
      app = await createApplication(home);
      expect(
        resolvePublisherNames(
          " NOVEL PRESS ",
          app.configuration.sources.publisher_aliases,
        ),
      ).toEqual(["elsevier"]);
      expect(
        resolvePublisherNames(
          "Another Press",
          app.configuration.sources.publisher_aliases,
        ),
      ).toEqual([]);
      const updated = await new PublisherGovernanceService(
        library(rows),
        new TypeScriptConfigurationOwner(home),
        model.agent,
      ).report({ selector: { kind: "all" } });
      expect(
        updated.entries.find((entry) => entry.name === "novel press")?.status,
      ).toBe("resolved");
      expect(rows[0]!.literature.metadata.publisher).toBe("Novel Press");
    } finally {
      await app?.close();
      model.agent.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

it("runs maintenance CLI through the production application and exports reviewable JSON without overwriting", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-cli-"));
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication(home);
    await app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        metadata: { ...FIXTURE_LITERATURE.metadata, publisher: "Elsevier BV" },
      }),
    );
    await app.close();
    app = undefined;
    const path = join(home, "report.json");
    const result = await runCli(
      ["maintenance", "publisher-names", "--all", "--output", path],
      { home },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      ai_requests: 0,
      entries: [{ name: "elsevier bv", status: "resolved" }],
    });
    await writeFile(path, "preserve-this-export");
    expect(
      (
        await runCli(
          ["maintenance", "publisher-names", "--all", "--output", path],
          { home },
        )
      ).code,
    ).toBe(3);
    expect(await readFile(path, "utf8")).toBe("preserve-this-export");
    expect(
      (await runCli(["maintenance", "publisher-names"], { home })).code,
    ).toBe(2);
    expect(
      (
        await runCli(["maintenance", "publisher-names", "--all", "--ai"], {
          home,
        })
      ).value,
    ).toMatchObject({ ai_requests: 0 });
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("bounds AI batches, reports unavailable and failed models, and honors cancellation", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-publisher-budget-"));
  const rows = await Promise.all(
    Array.from({ length: 21 }, (_, index) =>
      detail(index + 1, `Unknown Press ${index}`),
    ),
  );
  const model = runtime(mappingReply("unknown"));
  try {
    const owner = new TypeScriptConfigurationOwner(home);
    const service = new PublisherGovernanceService(
      library(rows),
      owner,
      model.agent,
    );
    const report = await service.report({
      selector: { kind: "all" },
      ai: true,
      max_ai_requests: 1,
    });
    expect(report.ai_requests).toBe(1);
    expect(
      report.entries.filter((entry) => entry.ai_failure === "request-limit"),
    ).toHaveLength(1);
    expect(report.entries.every((entry) => entry.suggestion === null)).toBe(
      true,
    );
    const unavailable = await new PublisherGovernanceService(
      library(rows),
      owner,
    ).report({ selector: { kind: "all" }, ai: true });
    expect(unavailable.ai_requests).toBe(0);
    expect(
      unavailable.entries.every((entry) => entry.ai_failure === "unavailable"),
    ).toBe(true);
    model.execute.mockRejectedValueOnce(
      new Error("private transport diagnostics"),
    );
    const failed = await service.report({
      selector: { kind: "literatures", literature_ids: [id(1)] },
      ai: true,
    });
    expect(failed.entries[0]).toMatchObject({
      ai_failure: "request-failed",
      suggestion: null,
    });
    expect(JSON.stringify(failed)).not.toContain(
      "private transport diagnostics",
    );
    await expect(
      service.report(
        { selector: { kind: "all" }, ai: true },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(model.execute).toHaveBeenCalledTimes(2);
  } finally {
    model.agent.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("accepts a selected JSON report through CLI and preserves concurrent configuration edits", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-publisher-accept-cli-"),
  );
  const model = runtime(mappingReply());
  try {
    const owner = new TypeScriptConfigurationOwner(home);
    const service = new PublisherGovernanceService(
      library([await detail(1, "Novel Press")]),
      owner,
      model.agent,
    );
    const report = await service.report({
      selector: { kind: "all" },
      ai: true,
    });
    const path = join(home, "report.json");
    await writeFile(path, JSON.stringify(report));
    expect(
      (
        await runCli(
          ["maintenance", "publisher-names-accept", "--report", path],
          { home },
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await runCli(
          [
            "maintenance",
            "publisher-names-accept",
            "--report",
            path,
            "--name",
            "novel press",
          ],
          { home },
        )
      ).code,
    ).toBe(0);
    const accepted = await owner.read();
    expect(accepted.configuration.sources.publisher_aliases).toEqual({
      elsevier: ["Novel Press"],
    });
    expect(
      (
        await runCli(
          [
            "maintenance",
            "publisher-names-accept",
            "--report",
            path,
            "--name",
            "novel press",
          ],
          { home },
        )
      ).code,
    ).toBe(4);
    expect((await owner.read()).revision).toBe(accepted.revision);
  } finally {
    model.agent.close();
    await rm(home, { recursive: true, force: true });
  }
});
