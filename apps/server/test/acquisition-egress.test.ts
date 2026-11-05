import { afterEach, expect, it } from "vitest";
import {
  parseMetadataObservation,
  type AcquisitionAttempt,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import {
  DirectPdfSource,
  PublicAcquisitionRegistry,
} from "../src/acquisition/sources/public.js";
import { assemblePublicPdfDownloadTransport } from "../src/acquisition/assembly.js";
import { resolveDoiLanding } from "../src/acquisition/doi-resolution.js";
import { TieredAcquisitionService } from "../src/acquisition/tiered.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { outboundEgress } from "../src/configuration/egress.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { connectProxyFixture } from "./network-egress-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function observation(source: string) {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    source_type: null,
    source_type_mapping_version: null,
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: "synthetic-id",
      observed_at: "2026-11-05T00:00:00.000Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: FIXTURE_LITERATURE.metadata,
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [
      {
        kind: "direct-file",
        url: "https://cdn.test/paper.pdf",
        media_type: "application/pdf",
        asset_role: "primary-pdf",
        version_role: "published",
        access_status: "open",
        license: null,
      },
    ],
  });
}
it("keeps PDF hint requester identity and never adds a generic direct retry of the same attributed URL", async () => {
  const p = await connectProxyFixture({ status: 407 });
  cleanup.push(p.close);
  const config = parseConfiguration(
    `[network]\nproxy="${p.origin}"\n[network.via_proxy]\nsources=["semantic-scholar"]`,
  );
  const source = new DirectPdfSource();
  const obs = observation("semantic-scholar");
  const request = {
    identifiers: FIXTURE_LITERATURE.metadata.identifiers,
    observations: [obs],
    asset_hints: obs.asset_hints,
  };
  const candidates = await source.discover(request);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    source: "direct",
    requester: "semantic-scholar",
  });
  const other = observation("crossref");
  expect(
    (await source.discover({ ...request, observations: [obs, other] })).map(
      (c) => c.requester,
    ),
  ).toEqual(["semantic-scholar", "crossref"]);
  const network = new NetworkBudgetCoordinator();
  cleanup.push(async () => network.close());
  const attempts: AcquisitionAttempt[] = [];
  const result = await new TieredAcquisitionService(
    new PublicAcquisitionRegistry([source], ["direct"]),
  ).run(
    [{ key: "fixture", request }],
    async (_item, _source, candidate, signal) => {
      return assemblePublicPdfDownloadTransport(candidate, network, {
        network: config.network,
        resolver: () => ["93.184.216.34"],
      }).request(candidate.locator, { signal });
    },
    {
      on_attempt: async (a) => {
        attempts.push(a);
      },
    },
  );
  expect(result[0]?.failure?.code).toBe("proxy-unavailable");
  expect(p.connections).toHaveLength(1);
  expect(attempts).toMatchObject([
    {
      source: "direct",
      requested: false,
      egresses: ["proxy"],
      problem: {
        technical_details: { diagnostics: [{ code: "proxy-unavailable" }] },
      },
    },
  ]);
});
it("DOI resolution has its own exit even when no metadata sources use the proxy", async () => {
  const p = await connectProxyFixture({ status: 403 });
  cleanup.push(p.close);
  const c = parseConfiguration(
    `[network]\nproxy="${p.origin}"\n[network.via_proxy]\ndoi_resolution=true`,
  );
  const network = new NetworkBudgetCoordinator();
  cleanup.push(async () => network.close());
  await expect(
    resolveDoiLanding(
      "https://doi.org/10.5555/fixture",
      network,
      new AbortController().signal,
      {
        resolver: () => ["93.184.216.34"],
        egress: outboundEgress(c.network, { kind: "doi-resolution" }),
      },
    ),
  ).rejects.toMatchObject({ code: "proxy-unavailable" });
  expect(p.connections.map((v) => v.authority)).toEqual(["doi.org:443"]);
});
