import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseMetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { EuropePmcRestAdapter } from "../src/providers/europe-pmc/metadata.js";
import {
  MetadataProviderFailure,
  type MetadataLookupPort,
  type ReferenceQueryPort,
  type ReferenceQueryContext,
  type NeutralMetadataItem,
} from "../src/metadata/ports.js";

function observation(provider: string, name: string) {
  return parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: provider,
      source_record_id: `${provider}-${name}`,
      observed_at: "2026-10-14T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      title: name,
      authors: [],
      abstract: null,
      publication_date: null,
      publication_year: 2026,
      publication_form: null,
      article_kind: null,
      language: null,
      venue: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers: [{ namespace: "doi", value: `10.1000/${name}` }],
      keywords: [],
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

it("publishes mixed-case Europe PMC DOI relations against canonical local identities", async () => {
  const adapter = new EuropePmcRestAdapter({
    transport: {
      request: async () => ({
        hitCount: 1,
        request: { offSet: 1 },
        referenceList: {
          reference: [{ doi: "https://doi.org/10.1000/MIXED" }],
        },
      }),
    },
  });
  const f = await fixture([adapter]);
  try {
    await f.app.identity.observe(observation("other", "mixed"));
    const report = await f.app.citations.run({ ...f.request, max_depth: 1 });
    expect(report.source_results).toEqual([
      { provider_name: "europe-pmc", outcome: "EXHAUSTED", failure: null },
    ]);
    expect(report).toMatchObject({ status: "COMPLETED", result_count: 1 });
    const references = await f.app.database.referenceSnapshot();
    expect(references).toHaveLength(1);
    expect(references[0]?.supports).toHaveLength(1);
    expect((await f.app.database.snapshotCounts()).tables.literatures).toBe(2);
  } finally {
    await f.close();
  }
});

function keyName(key: ProviderLiteratureKey) {
  return key.identifiers
    .find((i) => i.namespace === "doi")!
    .value.split("/")
    .at(-1)!;
}
function failure(code = "metadata-provider-http") {
  return new MetadataProviderFailure({
    code,
    reason: "The provider returned HTTP 404.",
    action: "Inspect the source record.",
    retryable: false,
  });
}
function related(
  provider: string,
  context: ReferenceQueryContext,
  name: string,
  inline = true,
): NeutralMetadataItem {
  const target = observation(provider, name);
  return {
    observations: inline ? [target] : [],
    relations: [
      {
        observation_id: randomUUID(),
        provenance: target.provenance,
        citing: context.keys[0]!,
        cited: {
          record_id: `${provider}-${name}`,
          identifiers: target.metadata.identifiers,
        },
      },
    ],
  };
}
function port(
  provider: string,
  graph: (
    name: string,
    context: ReferenceQueryContext,
  ) => readonly (NeutralMetadataItem | Error)[],
  calls: string[],
): ReferenceQueryPort {
  return {
    provider_name: provider,
    open_reference_query(context) {
      const name = keyName(context.keys[0]!);
      calls.push(`${provider}:${name}`);
      const records = graph(name, context);
      let index = 0;
      return {
        pull_raw_item: () =>
          index < records.length
            ? {
                raw_item: records[index++],
                source_exhausted_after: index === records.length,
              }
            : null,
        convert_raw_item(raw) {
          if (raw instanceof Error) throw raw;
          return raw as NeutralMetadataItem;
        },
      };
    },
  };
}
async function fixture(
  ports: ReferenceQueryPort[],
  lookups: MetadataLookupPort[] = [],
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-fallback-"));
  const app = await createApplication(home, {
    metadata: { reference_query_ports: ports, lookup_ports: lookups },
  });
  const seed = await app.identity.observe(
    observation(ports[0]!.provider_name, "seed"),
  );
  if (seed.disposition !== "accepted" || !seed.literature_id)
    throw new Error("fixture admission failed");
  return {
    app,
    request: {
      seed_literature_ids: [seed.literature_id],
      direction: "references" as const,
      max_depth: 2,
      result_limit: 100,
      providers: ports.map((p) => ({
        provider_name: p.provider_name,
        scan_limit: 100,
      })),
    },
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

it("continues after a target 404 through the rest of its references and every first-layer branch", async () => {
  const calls: string[] = [];
  const p = port(
    "primary",
    (name, context) =>
      (name === "seed"
        ? ["a", "b"]
        : name === "a"
          ? ["missing", "c"]
          : ["d", "c"]
      ).map((n) => related("primary", context, n, n !== "missing")),
    calls,
  );
  const lookup: MetadataLookupPort = {
    provider_name: "primary",
    open_lookup: () => {
      throw failure();
    },
  };
  const f = await fixture([p], [lookup]);
  try {
    const report = await f.app.citations.run(f.request);
    expect(report).toMatchObject({ status: "PARTIAL", result_count: 4 });
    expect(calls).toEqual(["primary:seed", "primary:a", "primary:b"]);
    const saved = await f.app.database.getDiscovery(report.discovery_run_id);
    expect(saved?.citation_causes.filter((c) => c.depth === 1)).toHaveLength(2);
    expect(saved?.citation_causes.filter((c) => c.depth === 2)).toHaveLength(3);
    expect((await f.app.database.snapshotCounts()).tables.literatures).toBe(5);
    expect(await f.app.database.referenceSnapshot()).toHaveLength(5);
    expect(report.source_results[0]?.failure?.code).toBe(
      "metadata-provider-http",
    );
  } finally {
    await f.close();
  }
});

it("falls through on empty or malformed responses and restarts priority for each node", async () => {
  const calls: string[] = [];
  const primary = port(
    "primary",
    (name, context) =>
      name === "seed"
        ? [related("primary", context, "a"), related("primary", context, "b")]
        : name === "a"
          ? []
          : [failure("metadata-record-invalid")],
    calls,
  );
  const free = port(
    "free",
    (name, context) => [related("free", context, name === "a" ? "c" : "d")],
    calls,
  );
  const f = await fixture([primary, free]);
  try {
    const result = await f.app.citations.run(f.request);
    expect(result).toMatchObject({ status: "PARTIAL", result_count: 4 });
    expect(calls).toEqual([
      "primary:seed",
      "primary:a",
      "free:a",
      "primary:b",
      "free:b",
    ]);
  } finally {
    await f.close();
  }
});

it("keeps using a provider on later nodes after one malformed seed record", async () => {
  const calls: string[] = [];
  const primary = port(
    "primary",
    (name, context) =>
      name === "seed"
        ? [
            failure("metadata-record-invalid"),
            related("primary", context, "a"),
            related("primary", context, "b"),
          ]
        : [related("primary", context, "shared")],
    calls,
  );
  const free = port("free", () => [], calls);
  const f = await fixture([primary, free]);
  try {
    const result = await f.app.citations.run(f.request);
    expect(result).toMatchObject({ status: "PARTIAL", result_count: 3 });
    expect(calls).toEqual([
      "primary:seed",
      "free:seed",
      "primary:a",
      "primary:b",
    ]);
    expect(await f.app.database.referenceSnapshot()).toHaveLength(4);
  } finally {
    await f.close();
  }
});

it("resolves a missing target through a later source without leaking native IDs or exceeding budgets", async () => {
  const calls: string[] = [];
  const keys: ProviderLiteratureKey[] = [];
  const primary = port(
    "primary",
    (_, context) => [related("primary", context, "target", false)],
    calls,
  );
  const free = port(
    "free",
    () => {
      throw new Error(
        "successful lookup must not trigger another relation query",
      );
    },
    calls,
  );
  const f = await fixture(
    [primary, free],
    [
      {
        provider_name: "primary",
        open_lookup: () => {
          throw failure();
        },
      },
      {
        provider_name: "free",
        open_lookup(key) {
          keys.push(key);
          return {
            pull_raw_item: () => ({
              raw_item: 1,
              source_exhausted_after: true,
            }),
            convert_raw_item: () => ({
              observations: [observation("free", "target")],
              relations: [],
            }),
          };
        },
      },
    ],
  );
  try {
    const report = await f.app.citations.run({
      ...f.request,
      max_depth: 1,
      providers: [
        { provider_name: "primary", scan_limit: 2 },
        { provider_name: "free", scan_limit: 1 },
      ],
    });
    expect(report).toMatchObject({ status: "PARTIAL", result_count: 1 });
    expect(calls).toEqual(["primary:seed"]);
    expect(keys).toEqual([
      {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.1000/target" }],
      },
    ]);
    expect(report.source_results[1]?.outcome).toBe("SCAN_LIMIT_REACHED");
    expect(
      (await f.app.database.referenceSnapshot())[0]?.supports,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each([
  "metadata-provider-authentication",
  "metadata-provider-authorization",
  "metadata-provider-rate-limited",
])(
  "continues with independent sources after %s without retrying the suspended source",
  async (code) => {
    const calls: string[] = [];
    const primary = port(
      "primary",
      () => {
        throw failure(code);
      },
      calls,
    );
    const free = port(
      "free",
      (name, context) => [
        related("free", context, name === "seed" ? "a" : "b"),
      ],
      calls,
    );
    const f = await fixture([primary, free]);
    try {
      const report = await f.app.citations.run(f.request);
      expect(report).toMatchObject({ status: "PARTIAL", result_count: 2 });
      expect(calls).toEqual(["primary:seed", "free:seed", "free:a"]);
    } finally {
      await f.close();
    }
  },
);

it("does not start fallback after cancellation during a target lookup", async () => {
  const calls: string[] = [];
  const abort = new AbortController();
  const primary = port(
    "primary",
    (_, context) => [related("primary", context, "a", false)],
    calls,
  );
  const free = port("free", () => [], calls);
  const f = await fixture(
    [primary, free],
    [
      {
        provider_name: "primary",
        open_lookup() {
          abort.abort();
          return {
            pull_raw_item: () => null,
            convert_raw_item: () => ({ observations: [], relations: [] }),
          };
        },
      },
    ],
  );
  try {
    const report = await f.app.citations.run({
      ...f.request,
      signal: abort.signal,
    });
    expect(report).toMatchObject({ status: "INTERRUPTED", result_count: 0 });
    expect(calls).toEqual(["primary:seed"]);
  } finally {
    await f.close();
  }
});

it("excludes seeds reached through cycles and does not report uncalled sources as exhausted", async () => {
  const calls: string[] = [];
  const primary = port(
    "primary",
    (name, context) =>
      (name === "seed" ? ["a"] : ["seed", "b"]).map((n) =>
        related("primary", context, n),
      ),
    calls,
  );
  const free = port(
    "free",
    () => {
      throw new Error("lower-priority source must not run");
    },
    calls,
  );
  const f = await fixture([primary, free]);
  try {
    const report = await f.app.citations.run(f.request);
    expect(report).toMatchObject({ status: "COMPLETED", result_count: 2 });
    expect(calls).toEqual(["primary:seed", "primary:a"]);
    expect(report.source_results.map((x) => x.provider_name)).toEqual([
      "primary",
    ]);
    const saved = await f.app.database.getDiscovery(report.discovery_run_id);
    expect(saved?.providers).toHaveLength(2);
    expect(saved?.source_results).toHaveLength(1);
    expect(await f.app.database.referenceSnapshot()).toHaveLength(3);
  } finally {
    await f.close();
  }
});

it("does not try a foreign lookup with only the original provider's native record ID", async () => {
  const calls: string[] = [];
  const primary = port(
    "primary",
    (_, context) => {
      const entry = related("primary", context, "missing", false);
      return [
        {
          observations: [],
          relations: [
            {
              ...entry.relations[0]!,
              cited: { record_id: "primary-only", identifiers: [] },
            },
          ],
        },
      ];
    },
    calls,
  );
  const free = port("free", () => [], calls);
  let foreignLookups = 0;
  const f = await fixture(
    [primary, free],
    [
      {
        provider_name: "primary",
        open_lookup: () => {
          throw failure();
        },
      },
      {
        provider_name: "free",
        open_lookup: () => {
          foreignLookups++;
          throw new Error("native record ID crossed providers");
        },
      },
    ],
  );
  try {
    const report = await f.app.citations.run(f.request);
    expect(report.result_count).toBe(0);
    expect(foreignLookups).toBe(0);
    expect(calls).toEqual(["primary:seed", "free:seed"]);
    expect(await f.app.database.referenceSnapshot()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
