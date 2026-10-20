import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sha256 } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { EntryPdfAcquisitionService } from "../src/entry/pdf-acquisition.js";
import * as assembly from "../src/acquisition/assembly.js";
import { type AcquisitionSourcePort } from "../src/acquisition/ports.js";
import {
  downloadPdfCandidate,
  PublicAcquisitionRegistry,
  type PdfDownloadTransport,
} from "../src/acquisition/sources/public.js";
import { safeLocator } from "../src/acquisition/sources/locators.js";
import {
  AcquisitionRouteError,
  AcquisitionUnavailableError,
} from "../src/acquisition/tiered.js";
import { NetworkHttpError } from "../src/network/http.js";
import { NetworkPolicyError } from "../src/network/policy.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const response = (status: number, retryAfter = false) => ({
  request: async () => ({
    status,
    headers: retryAfter ? [["retry-after", "60"] as const] : [],
    body: new Uint8Array(),
  }),
});

async function run(options: {
  publicTransport: PdfDownloadTransport;
  api?: "success" | "miss" | "unavailable" | "failure";
  browser?:
    | "success"
    | "miss"
    | "disabled"
    | "access-unavailable"
    | "no-viable-path";
  cohort?: boolean;
  discoveryError?: Error;
}) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-public-fallback-"));
  const app = await createApplication(home, {});
  const mocked = vi
    .spyOn(assembly, "assemblePublicPdfDownloadTransport")
    .mockReturnValue(options.publicTransport);
  const phases: string[] = [];
  const pdf = workbenchPdf();
  const sources: AcquisitionSourcePort[] = [
    {
      source_name: "fixture-public",
      acquisition_tier: "public",
      ready: true,
      async discover() {
        phases.push("public");
        if (options.discoveryError) throw options.discoveryError;
        return [
          safeLocator("fixture-public", "https://mirror.example.test/article"),
        ];
      },
    },
    {
      source_name: "fixture-api",
      acquisition_tier: "authorized-api",
      ready: true,
      async discover() {
        phases.push("api");
        if (options.api === "unavailable")
          throw new AcquisitionUnavailableError(
            "download-unavailable",
            "No API PDF capability.",
            "no-capability",
          );
        if (options.api === "failure")
          throw new AcquisitionRouteError(
            "http-response-failed",
            "API HTTP 503.",
          );
        return options.api === "success"
          ? [safeLocator("fixture-api", "https://api.example.test/file.pdf")]
          : [];
      },
      async download_candidate() {
        return {
          kind: "download",
          bytes: pdf,
          media_type: "application/pdf",
          safe_source_url: "https://api.example.test/file.pdf",
          entitlement: "granted",
          locator: {
            namespace: "doi",
            value: "10.1000/fixture",
            declared_media_type: "application/pdf",
            source_record_id: "fixture",
          },
        };
      },
    },
  ];
  if (options.browser !== "disabled")
    sources.push({
      source_name: assembly.BROWSER_ROUTE_NAME,
      ready: true,
      discover: async () => {
        throw new Error("Browser marker is not a locator");
      },
    });
  const service = new EntryPdfAcquisitionService({
    registry: new PublicAcquisitionRegistry(
      sources,
      sources.map((s) => s.source_name),
    ),
    network_budget: app.networkBudget,
    transfers: app.execution!.transfers,
    acceptance: app.execution!.acceptance,
    browser_host: () => ({
      async deliverCandidate(request) {
        phases.push("browser");
        if (
          options.browser === "access-unavailable" ||
          options.browser === "no-viable-path"
        )
          return {
            kind: "refused",
            code: `browser-agent-${options.browser}`,
            reason:
              "The article PDF link returned to the purchase page; no usable alternative remains.",
            retryable: false,
          };

        if (options.browser !== "success")
          return { kind: "exhausted", reason: "No PDF in fixture." };
        const candidate = await downloadPdfCandidate(
          safeLocator("browser", "https://publisher.example.test/file.pdf"),
          {
            request: async () => ({ status: 200, headers: [], body: pdf }),
          },
          {
            collector: app.execution!.transfers,
            transfer_id: "browser-fallback",
            capture: {
              session_id: "session",
              article_id: request.literature_id,
              page_id: "page",
              document_generation: 0,
              source_url: "https://publisher.example.test/file.pdf",
              captured_at: new Date().toISOString(),
            },
          },
        );
        return { kind: "delivered", candidate, accepted: true };
      },
      close: async () => undefined,
    }),
  });
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const id = FIXTURE_LITERATURE.literature_id;
    const request = {
      literature_id: id,
      detail: await app.library.detail(id),
      metadata_snapshot: (await app.database.currentFacts(id))!
        .metadata_snapshot,
      signal: new AbortController().signal,
    };
    const outcome = options.cohort
      ? (await service.acquireCohort([request]))[0]!
      : await service.acquire(request);
    const primary = (await app.library.detail(id)).primary_pdf;
    if (outcome.kind === "acquired") {
      expect(primary?.asset.sha256).toBe(await sha256(pdf));
      expect(primary?.article_identity_status).toBe("unverified");
    } else expect(primary).toBeNull();
    return { outcome, phases };
  } catch (error) {
    expect(phases).toEqual(["public"]);
    throw error;
  } finally {
    mocked.mockRestore();
    await service.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}

it.each([false, true])(
  "continues Public HTTP 502 into API publication (cohort=%s)",
  async (cohort) => {
    const result = await run({
      publicTransport: response(502),
      api: "success",
      browser: "success",
      cohort,
    });
    expect(result.outcome.kind).toBe("acquired");
    expect(result.phases).toEqual(["public", "api"]);
  },
);

it.each([false, true])(
  "continues a public timeout into Browser publication after API miss (cohort=%s)",
  async (cohort) => {
    const result = await run({
      publicTransport: {
        request: async () => {
          throw new NetworkHttpError("timeout");
        },
      },
      api: "miss",
      browser: "success",
      cohort,
    });
    expect(result.outcome.kind).toBe("acquired");
    expect(result.phases).toEqual(["public", "api", "browser"]);
  },
);

it.each([false, true])(
  "retains the original public outage when later routes miss (cohort=%s)",
  async (cohort) => {
    for (const browser of ["disabled", "miss"] as const) {
      for (const api of ["miss", "unavailable"] as const) {
        const result = await run({
          publicTransport: response(502),
          api,
          browser,
          cohort,
        });
        expect(result.outcome).toMatchObject({
          kind: "route-failure",
          failure: {
            source: "fixture-public",
            code: "http-response-failed",
            reason: "Public HTTP returned 502; no PDF was delivered.",
            retryable: true,
          },
        });
        expect(result.phases).toEqual(
          browser === "disabled"
            ? ["public", "api"]
            : ["public", "api", "browser"],
        );
      }
    }
  },
);

it.each([
  [401, false],
  [429, false],
  [502, true],
] as const)(
  "continues independent API delivery after HTTP %s / Retry-After %s",
  async (status, retryAfter) => {
    const result = await run({
      publicTransport: response(status, retryAfter),
      api: "success",
      browser: "success",
    });
    expect(result.outcome.kind).toBe("acquired");
    expect(result.phases).toEqual(["public", "api"]);
  },
);

it("continues source outages through independent Browser delivery", async () => {
  const result = await run({
    publicTransport: response(502),
    api: "failure",
    browser: "success",
  });
  expect(result.outcome).toMatchObject({ kind: "acquired" });
  expect(result.phases).toEqual(["public", "api", "browser"]);
});

it("rejects the unsafe candidate while allowing independent API delivery", async () => {
  const result = await run({
    publicTransport: {
      request: async () => {
        throw new NetworkPolicyError();
      },
    },
    api: "success",
    browser: "success",
  });
  expect(result.outcome).toMatchObject({ kind: "acquired" });
  expect(result.phases).toEqual(["public", "api"]);
});

it.each([
  new TypeError("invalid fixture contract"),
  Object.assign(new Error("fixture storage failure"), { code: "EIO" }),
  new Error("unknown fixture failure"),
])("does not swallow system failures: %s", async (discoveryError) => {
  await expect(
    run({
      publicTransport: response(502),
      discoveryError,
      api: "success",
      browser: "success",
    }),
  ).rejects.toBe(discoveryError);
});

it.each(["access-unavailable", "no-viable-path"] as const)(
  "retains the Agent task assessment in Entry's result after earlier source failures (%s)",
  async (browser) => {
    const result = await run({
      publicTransport: response(502),
      api: "failure",
      browser,
    });
    expect(result.outcome).toMatchObject({
      kind: "browser-failure",
      code: `browser-agent-${browser}`,
      reason: expect.stringContaining("purchase page"),
    });
    expect(result.phases).toEqual(["public", "api", "browser"]);
  },
);
