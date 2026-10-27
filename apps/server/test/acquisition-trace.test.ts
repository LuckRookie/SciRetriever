import { expect, it } from "vitest";
import type { AcquisitionAttempt } from "@sciretriever/contracts";
import {
  TieredAcquisitionService,
  AcquisitionRouteError,
  AcquisitionCandidateSkippedError,
  AcquisitionUnavailableError,
} from "../src/acquisition/tiered.js";
import { PublicAcquisitionRegistry } from "../src/acquisition/sources/public.js";
import { safeLocator } from "../src/acquisition/sources/locators.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
import {
  assemblePublicAcquisitionRegistry,
  splitAcquisitionRoutes,
} from "../src/acquisition/assembly.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

it("preserves a failed API before later success and emits cooldown without a second request", async () => {
  const attempts: AcquisitionAttempt[] = [];
  let calls = 0;
  const service = new TieredAcquisitionService(
    new PublicAcquisitionRegistry(
      [
        {
          source_name: "wiley",
          acquisition_stage: "publisher-api",
          ready: true,
          discover: async () => {
            calls++;
            networkRequestDispatched();
            throw new AcquisitionRouteError(
              "rate-limited",
              "secret fixture URL https://example.test/?token=synthetic",
            );
          },
        },
        {
          source_name: "alternate",
          acquisition_stage: "public-web",
          ready: true,
          discover: async () => [
            safeLocator(
              "alternate",
              "https://example.test/file.pdf?download=synthetic",
            ),
          ],
        },
      ],
      ["wiley", "alternate"],
    ),
    { now: () => 1000 },
  );
  const run = () =>
    service.run(
      [{ key: "fixture", request: { identifiers: [] } }],
      async () => {
        networkRequestDispatched();
      },
      {
        on_attempt: async (a) => {
          attempts.push(a);
        },
      },
    );
  expect((await run())[0]?.disposition).toBe("acquired");
  expect(attempts.map((a) => [a.source, a.result, a.requested])).toEqual([
    ["wiley", "failed", true],
    ["alternate", "hit", true],
  ]);
  await run();
  expect(calls).toBe(1);
  expect(attempts[2]).toMatchObject({
    result: "cooldown",
    requested: false,
    code: "source-cooldown",
  });
  expect(JSON.stringify(attempts)).not.toMatch(/secret|https|token|synthetic/);
});
it("distinguishes an unconfigured selected API from a local locator with no candidate", async () => {
  const budget = new NetworkBudgetCoordinator();
  const attempts: AcquisitionAttempt[] = [];
  try {
    const routes = splitAcquisitionRoutes(
      assemblePublicAcquisitionRegistry(
        parseConfiguration(
          '[sources.acquisition]\nmode="custom"\nproviders=["wiley"]\n',
        ),
        budget,
      ),
    );
    for (const stage of ["direct", "publisher-api"] as const)
      await new TieredAcquisitionService(routes.stages[stage]).run(
        [{ key: "fixture", request: { identifiers: [] } }],
        async () => {
          throw Error("Unexpected download");
        },
        {
          on_attempt: async (a) => {
            attempts.push(a);
          },
        },
      );
    expect(attempts).toMatchObject([
      {
        source: "direct",
        requested: false,
        result: "not-applicable",
        candidates: 0,
      },
      {
        source: "wiley",
        requested: false,
        result: "unavailable",
        code: "missing-credential",
      },
    ]);
  } finally {
    budget.close();
  }
});
it("keeps concurrent network attribution isolated", async () => {
  const attempts: AcquisitionAttempt[] = [];
  const service = new TieredAcquisitionService(
    new PublicAcquisitionRegistry(
      [
        {
          source_name: "fixture",
          ready: true,
          discover: async (r) => {
            await Promise.resolve();
            if (r.identifiers.length) networkRequestDispatched();
            return [];
          },
        },
      ],
      ["fixture"],
    ),
  );
  await Promise.all(
    [[], [{ namespace: "doi", value: "10.5555/fake" }]].map((identifiers) =>
      service.run(
        [{ key: "fixture", request: { identifiers } }],
        async () => {},
        {
          on_attempt: async (a) => {
            attempts.push(a);
          },
        },
      ),
    ),
  );
  expect(attempts.map((a) => [a.requested, a.result])).toEqual([
    [false, "not-applicable"],
    [true, "miss"],
  ]);
});

it.each(["miss", "unavailable", "rejected"] as const)(
  "keeps the first candidate failure when a later candidate is %s",
  async (later) => {
    const attempts: AcquisitionAttempt[] = [];
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry(
        [
          {
            source_name: "fixture",
            ready: true,
            discover: async () => [
              safeLocator("fixture", "https://example.test/first.pdf"),
              safeLocator("fixture", "https://example.test/second.pdf"),
            ],
          },
        ],
        ["fixture"],
      ),
    );
    const [outcome] = await service.run(
      [{ key: "fixture", request: { identifiers: [] } }],
      async (_item, _source, candidate) => {
        networkRequestDispatched();
        if (candidate.locator.endsWith("first.pdf"))
          throw new AcquisitionRouteError(
            "network-failed",
            "Synthetic failure",
          );
        if (later === "unavailable")
          throw new AcquisitionUnavailableError(
            "download-unavailable",
            "Synthetic HTML",
            "http-route-unavailable",
          );
        throw new AcquisitionCandidateSkippedError(later);
      },
      {
        on_attempt: async (a) => {
          attempts.push(a);
        },
      },
    );
    expect(outcome?.failure?.code).toBe("network-failed");
    expect(attempts).toMatchObject([
      {
        result: "failed",
        code: "network-failed",
        requested: true,
        candidates: 2,
      },
    ]);
  },
);
