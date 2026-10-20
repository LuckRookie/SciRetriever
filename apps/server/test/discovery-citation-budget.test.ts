import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseMetadataObservation,
  parseReference,
  type MetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { SemanticScholarRestAdapter } from "../src/providers/semantic-scholar/metadata.js";
import type {
  MetadataLookupPort,
  NeutralMetadataItem,
  ReferenceQueryContext,
  ReferenceQueryPort,
} from "../src/metadata/ports.js";

function observation(n: number): MetadataObservation {
  return parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: "fixture",
      source_record_id: String(n),
      observed_at: "2026-10-10T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      title: `Work ${n}`,
      authors: [],
      abstract: null,
      publication_date: null,
      publication_year: 2025,
      publication_form: null,
      article_kind: null,
      language: null,
      venue: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers: [{ namespace: "doi", value: `10.1000/work-${n}` }],
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

function item(
  context: ReferenceQueryContext,
  n: number,
  inline: boolean,
): NeutralMetadataItem {
  const o = observation(n),
    anchor = context.keys[0]!;
  const target = { record_id: String(n), identifiers: o.metadata.identifiers };
  return {
    observations: inline ? [o] : [],
    relations: [
      {
        observation_id: randomUUID(),
        provenance: o.provenance,
        citing: context.direction === "cited-by" ? target : anchor,
        cited: context.direction === "cited-by" ? anchor : target,
      },
    ],
  };
}

async function application(
  port: ReferenceQueryPort,
  lookup?: MetadataLookupPort,
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-budget-"));
  const app = await createApplication(home, {
    metadata: {
      reference_query_ports: [port],
      lookup_ports: lookup ? [lookup] : [],
    },
  });
  const seed = await app.identity.observe(observation(0));
  if (seed.disposition !== "accepted" || !seed.literature_id)
    throw new Error("fixture admission failed");
  return { app, seedId: seed.literature_id };
}

it.each(["references", "cited-by"] as const)(
  "admits inline %s at the raw limit and preserves one edge with multiple supports on replay",
  async (direction) => {
    const port: ReferenceQueryPort = {
      provider_name: "fixture",
      open_reference_query(context) {
        let sent = false;
        return {
          pull_raw_item() {
            if (sent) throw new Error("scan exceeded its budget");
            sent = true;
            return { raw_item: 1, source_exhausted_after: true };
          },
          convert_raw_item: () => item(context, 1, true),
        };
      },
    };
    const { app, seedId } = await application(port);
    try {
      const request = {
        seed_literature_ids: [seedId],
        direction,
        max_depth: 1,
        result_limit: 5,
        providers: [{ provider_name: "fixture", scan_limit: 1 }],
      };
      const first = await app.citations.run(request);
      const page = await app.library.references({
        literature_id: seedId,
        direction,
        limit: 5,
        cursor: null,
      });
      expect(first.result_count).toBe(1);
      expect(page.total_count).toBe(1);
      expect(
        direction === "references"
          ? page.items[0]?.reference.source_literature_id
          : page.items[0]?.reference.target_literature_id,
      ).toBe(seedId);
      const again = await app.citations.run(request);
      const repeated = await app.library.references({
        literature_id: seedId,
        direction,
        limit: 5,
        cursor: null,
      });
      expect(again.result_count).toBe(1);
      expect(repeated.items[0]?.reference.reference_id).toBe(
        page.items[0]?.reference.reference_id,
      );
      expect(repeated.items[0]?.support_count).toBe(2);
      expect((await app.database.snapshotCounts()).tables.literatures).toBe(2);
    } finally {
      await app.close();
    }
  },
);

it("interleaves lookups with relation scanning within one provider raw budget", async () => {
  let pulls = 0,
    lookups = 0;
  const port: ReferenceQueryPort = {
    provider_name: "fixture",
    open_reference_query(context) {
      return {
        pull_raw_item: () => ({
          raw_item: ++pulls,
          source_exhausted_after: false,
        }),
        convert_raw_item: (raw) => item(context, Number(raw), false),
      };
    },
  };
  const lookup: MetadataLookupPort = {
    provider_name: "fixture",
    open_lookup(key) {
      lookups += 1;
      return {
        pull_raw_item: () => ({
          raw_item: key.record_id,
          source_exhausted_after: true,
        }),
        convert_raw_item: (raw) => ({
          observations: [observation(Number(raw))],
          relations: [],
        }),
      };
    },
  };
  const { app, seedId } = await application(port, lookup);
  try {
    const report = await app.citations.run({
      seed_literature_ids: [seedId],
      direction: "references",
      max_depth: 1,
      result_limit: 10,
      providers: [{ provider_name: "fixture", scan_limit: 3 }],
    });
    expect(report.result_count).toBe(1);
    expect(report.source_results[0]?.outcome).toBe("SCAN_LIMIT_REACHED");
    expect({ pulls, lookups }).toEqual({ pulls: 2, lookups: 1 });
    expect((await app.database.snapshotCounts()).tables.literatures).toBe(2);
  } finally {
    await app.close();
  }
});

it.each(["cancel", "provider-failure"] as const)(
  "retains admitted targets and reference evidence after %s",
  async (failure) => {
    const abort = new AbortController();
    const port: ReferenceQueryPort = {
      provider_name: "fixture",
      open_reference_query(context) {
        let sent = false;
        return {
          pull_raw_item() {
            if (!sent) {
              sent = true;
              return { raw_item: 1, source_exhausted_after: false };
            }
            if (failure === "cancel") {
              abort.abort();
              return null;
            }
            throw new Error("later page failed");
          },
          convert_raw_item: () => item(context, 1, true),
        };
      },
    };
    const { app, seedId } = await application(port);
    try {
      const report = await app.citations.run({
        seed_literature_ids: [seedId],
        direction: "references",
        max_depth: 1,
        result_limit: 10,
        providers: [{ provider_name: "fixture", scan_limit: 10 }],
        signal: abort.signal,
      });
      expect(report.status).toBe(
        failure === "cancel" ? "INTERRUPTED" : "PARTIAL",
      );
      expect(report.result_count).toBe(1);
      expect(
        (
          await app.library.references({
            literature_id: seedId,
            direction: "references",
            limit: 5,
            cursor: null,
          })
        ).total_count,
      ).toBe(1);
      expect(
        (await app.database.getDiscovery(report.discovery_run_id))?.results,
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  },
);

it("expands breadth first to the requested depth without scanning beyond its result limit", async () => {
  let pulls = 0;
  const port: ReferenceQueryPort = {
    provider_name: "fixture",
    open_reference_query(context) {
      const value = context.keys[0]!.identifiers[0]!.value;
      const n = Number(value.split("-").at(-1)) + 1;
      return {
        pull_raw_item() {
          pulls += 1;
          return { raw_item: n, source_exhausted_after: true };
        },
        convert_raw_item: () => item(context, n, true),
      };
    },
  };
  const { app, seedId } = await application(port);
  try {
    const report = await app.citations.run({
      seed_literature_ids: [seedId],
      direction: "references",
      max_depth: 5,
      result_limit: 2,
      providers: [{ provider_name: "fixture", scan_limit: 100 }],
    });
    expect(report.result_count).toBe(2);
    expect(pulls).toBe(2);
    expect(
      (
        await app.database.getDiscovery(report.discovery_run_id)
      )?.citation_causes.map((c) => c.depth),
    ).toEqual([1, 2]);
    expect(
      (await app.database.snapshotCounts()).tables.literature_references,
    ).toBe(2);
  } finally {
    await app.close();
  }
});

it("does not admit a lookup response that identifies an unrelated work", async () => {
  const port: ReferenceQueryPort = {
    provider_name: "fixture",
    open_reference_query: (context) => ({
      pull_raw_item: () => ({ raw_item: 1, source_exhausted_after: true }),
      convert_raw_item: () => item(context, 1, false),
    }),
  };
  const lookup: MetadataLookupPort = {
    provider_name: "fixture",
    open_lookup: () => ({
      pull_raw_item: () => ({ raw_item: 99, source_exhausted_after: true }),
      convert_raw_item: () => ({
        observations: [observation(99)],
        relations: [],
      }),
    }),
  };
  const { app, seedId } = await application(port, lookup);
  try {
    const report = await app.citations.run({
      seed_literature_ids: [seedId],
      direction: "references",
      max_depth: 1,
      result_limit: 10,
      providers: [{ provider_name: "fixture", scan_limit: 10 }],
    });
    expect(report.result_count).toBe(0);
    expect((await app.database.snapshotCounts()).tables.literatures).toBe(1);
  } finally {
    await app.close();
  }
});

it("publishes Semantic Scholar inline records and relation provenance atomically without colliding", async () => {
  const adapter = new SemanticScholarRestAdapter({
    transport: {
      request: async () => ({
        offset: 0,
        data: [
          {
            citedPaper: {
              paperId: "s2-target",
              title: "Related work",
              externalIds: { DOI: "10.1000/related" },
            },
          },
        ],
      }),
    },
  });
  const { app, seedId } = await application(adapter);
  try {
    const request = {
      seed_literature_ids: [seedId],
      direction: "references" as const,
      max_depth: 1,
      result_limit: 10,
      providers: [{ provider_name: "semantic-scholar", scan_limit: 1 }],
    };
    expect((await app.citations.run(request)).result_count).toBe(1);
    expect((await app.citations.run(request)).result_count).toBe(1);
    const edges = await app.library.references({
      literature_id: seedId,
      direction: "references",
      limit: 5,
      cursor: null,
    });
    expect(edges.total_count).toBe(1);
    expect(edges.items[0]!.support_count).toBe(2);
  } finally {
    await app.close();
  }
});

it("rolls back a newly proposed reference when its provider evidence does not match the endpoints", async () => {
  const { app, seedId } = await application({
    provider_name: "fixture",
    open_reference_query: () => {
      throw new Error("unused");
    },
  });
  try {
    const target = await app.identity.observe(observation(2));
    if (target.disposition !== "accepted" || !target.literature_id)
      throw new Error("fixture target failed");
    const relation = item(
      {
        direction: "references",
        keys: [
          { record_id: "0", identifiers: observation(0).metadata.identifiers },
        ],
      },
      1,
      false,
    ).relations[0]!;
    await app.observations.publishProviderRelation(relation);
    await expect(
      app.database.publishProviderReference(
        parseReference({
          reference_id: randomUUID(),
          source_literature_id: seedId,
          target_literature_id: target.literature_id,
        }),
        relation.observation_id,
      ),
    ).rejects.toThrow();
    expect(
      (await app.database.snapshotCounts()).tables.literature_references,
    ).toBe(0);
    expect(
      (
        await app.library.references({
          literature_id: seedId,
          direction: "references",
          limit: 10,
          cursor: null,
        })
      ).total_count,
    ).toBe(0);
  } finally {
    await app.close();
  }
});

it("keeps a provider-native seed key alongside DOI identifiers for reverse citation queries", async () => {
  let received: ReferenceQueryContext | undefined;
  const port: ReferenceQueryPort = {
    provider_name: "fixture",
    open_reference_query(context) {
      received = context;
      if (context.keys[0]?.record_id !== "0")
        throw new Error("Provider-native key required");
      return {
        pull_raw_item: () => ({ raw_item: 1, source_exhausted_after: true }),
        convert_raw_item: () => item(context, 1, true),
      };
    },
  };
  const { app, seedId } = await application(port);
  try {
    const report = await app.citations.run({
      seed_literature_ids: [seedId],
      direction: "cited-by",
      max_depth: 1,
      result_limit: 1,
      providers: [{ provider_name: "fixture", scan_limit: 1 }],
    });
    expect(report).toMatchObject({ status: "COMPLETED", result_count: 1 });
    expect(received?.keys[0]).toEqual({
      record_id: "0",
      identifiers: [{ namespace: "doi", value: "10.1000/work-0" }],
    });
    const edges = await app.database.referenceSnapshot();
    expect(edges[0]?.reference.target_literature_id).toBe(seedId);
    expect(edges[0]?.supports).toHaveLength(1);
  } finally {
    await app.close();
  }
});
