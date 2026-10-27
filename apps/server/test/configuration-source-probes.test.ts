import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { SourceConfigurationOwner } from "../src/configuration/sources.js";
import {
  SourceProbeService,
  probeFailure,
} from "../src/configuration/source-probes.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import {
  networkRequestDispatched,
  networkResponseBytes,
} from "../src/network/request-activity.js";
import { AuthorizedProviderError } from "../src/providers/shared/authorized-pdf.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
const resources: {
  home: string;
  probe: SourceProbeService;
  network: NetworkBudgetCoordinator;
}[] = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    await r.probe.close();
    r.network.close();
    await rm(r.home, { recursive: true, force: true });
  }
});
async function fixture(
  options: ConstructorParameters<typeof SourceProbeService>[2] = {},
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-probe-")),
    owner = new TypeScriptConfigurationOwner(home);
  await owner.read();
  const sources = new SourceConfigurationOwner(owner),
    network = new NetworkBudgetCoordinator(),
    probe = new SourceProbeService(sources, network, options);
  resources.push({ home, probe, network });
  return { home, owner, sources, probe };
}
async function key(sources: SourceConfigurationOwner) {
  return sources.save({
    source: "wiley",
    baseline: (await sources.directory()).catalog_revision,
    parameters: { action: "keep" },
    credentials: [
      { field: "tdm_api_token", action: "replace", value: "fake-only-private" },
    ],
    test_after_save: false,
  });
}
it("tests only the named source and validates real synthetic PDF structure without creating facts", async () => {
  let calls = 0;
  const { home, sources, probe } = await fixture({
    acquisition: {
      authorizedTransportFactory: (source) => ({
        request: async () => {
          expect(source).toBe("wiley");
          calls++;
          const body = workbenchPdf();
          networkResponseBytes(body.length);
          return {
            status: 200,
            headers: [["content-type", "application/pdf"]],
            body,
          };
        },
      }),
    },
  });
  await key(sources);
  const revision = await sources.testRevision("wiley"),
    request = {
      source: "wiley",
      source_revision: revision,
      request_id: randomUUID(),
    };
  const ticket = await probe.test(request);
  expect(await probe.test(request)).toEqual(ticket);
  const result = await probe.wait("wiley");
  expect(result).toMatchObject({
    status: "available",
    requests_started: 1,
    library_written: false,
    assets_published: false,
    checks: [{ purpose: "pdf", result: "ok", pdf_validated: true }],
  });
  expect(calls).toBe(1);
  const saved = (await sources.directory()).rows.find(
    (r) => r.source === "wiley",
  )!.test.latest;
  expect(saved).toEqual(result);
  const cache = await readFile(
    join(home, ".sciretriever", "source-state.json"),
    "utf8",
  );
  expect(cache).not.toContain("fake-only-private");
  expect(cache).not.toContain("https://");
  await expect(readFile(join(home, "catalog.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("invalidates stale in-flight results on same-presence credential replacement", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((done) => {
    unblock = done;
  });
  const { sources, probe } = await fixture({
    acquisition: {
      authorizedTransportFactory: () => ({
        request: async () => {
          await gate;
          return { status: 200, headers: [], body: workbenchPdf() };
        },
      }),
    },
  });
  await key(sources);
  const ticket = await probe.test({
    source: "wiley",
    source_revision: await sources.testRevision("wiley"),
    request_id: randomUUID(),
  });
  const done = probe.wait("wiley");
  await key(sources);
  unblock();
  await done;
  const row = (await sources.directory()).rows.find(
    (r) => r.source === "wiley",
  )!;
  expect(row.source_revision).not.toBe(ticket.source_revision);
  expect(row.test.latest).toBeNull();
});
it("keeps missing configuration local and classifies only explicit protocol evidence", async () => {
  const { sources, probe } = await fixture({
    acquisition: {
      authorizedTransportFactory: () => ({
        request: async () => {
          throw new Error("must not request");
        },
      }),
    },
  });
  await probe.test({
    source: "wiley",
    source_revision: await sources.testRevision("wiley"),
    request_id: randomUUID(),
  });
  expect(await probe.wait("wiley")).toMatchObject({
    status: "not-configured",
    requests_started: 0,
  });
  expect(
    probeFailure(
      new AuthorizedProviderError({ code: "entitlement", http_status: 403 }),
      true,
    ).status,
  ).toBe("error");
  expect(
    probeFailure(
      new AuthorizedProviderError({ code: "authentication", http_status: 401 }),
      true,
    ).status,
  ).toBe("credential-invalid");
  expect(
    probeFailure(
      new AuthorizedProviderError({
        code: "entitlement",
        http_status: 403,
        authentication: "accepted",
        fulltext_permission: "denied",
      }),
      true,
    ).status,
  ).toBe("no-fulltext-permission");
  expect(
    probeFailure(
      new AuthorizedProviderError({ code: "authentication", http_status: 401 }),
      false,
    ).status,
  ).toBe("error");
});
it("preserves empty lookup as normal and uses scan=1 with a provider-native fixture", async () => {
  let requested = "";
  const { sources, probe } = await fixture({
    metadata: {
      transportFactory: (source) => ({
        request: async (url) => {
          expect(source).toBe("opencitations");
          requested = url;
          networkRequestDispatched();
          return [];
        },
      }),
    },
  });
  await probe.test({
    source: "opencitations",
    source_revision: await sources.testRevision("opencitations"),
    request_id: randomUUID(),
  });
  const result = await probe.wait("opencitations");
  expect(result).toMatchObject({
    status: "available",
    requests_started: 1,
    checks: [{ purpose: "lookup", result: "empty", requested: true }],
  });
  expect(requested).toContain("/meta/v1/");
});

it("test-all is serialized, isolates failures, skips unsupported/missing rows, and shares one budget", async () => {
  let active = 0,
    maximum = 0;
  const seen: string[] = [];
  const { sources, probe } = await fixture({
    metadata: {
      transportFactory: (source) => ({
        request: async () => {
          seen.push(source);
          active++;
          maximum = Math.max(maximum, active);
          networkRequestDispatched();
          await new Promise<void>((done) => setTimeout(done, 2));
          active--;
          if (source === "opencitations") return [];
          throw new Error("synthetic-response-error");
        },
      }),
    },
    acquisition: { resolver: () => ["127.0.0.1"] },
    browser: async () => {},
  });
  const request = {
    catalog_revision: (await sources.directory()).catalog_revision,
    request_id: randomUUID(),
    scope: "configured",
  };
  const tickets = await probe.all(request);
  expect(await probe.all(request)).toEqual(tickets);
  expect(
    tickets.tickets.some(
      (t) =>
        t.source === "plos" ||
        t.source === "wiley" ||
        t.source === "web-of-science",
    ),
  ).toBe(false);
  await expect.poll(() => probe.activeCount, { timeout: 15000 }).toBe(0);
  expect(maximum).toBe(1);
  expect(seen).toContain("crossref");
  expect(seen).toContain("datacite");
  const directory = await sources.directory();
  expect(
    directory.rows.find((r) => r.source === "crossref")!.test.latest?.status,
  ).toBe("error");
  expect(directory.builtin_tests[0]?.test.latest?.status).toBe("available");
  await expect(
    probe.test({
      source: "plos",
      source_revision: await sources.testRevision("plos"),
      request_id: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "source-test-unavailable" });
});

it("does not retain queued tickets or idempotency entries when lifecycle admission fails", async () => {
  const { sources, probe } = await fixture({
    metadata: {
      transportFactory: () => ({
        request: async () => {
          networkRequestDispatched();
          return [];
        },
      }),
    },
  });
  const background = probe.background;
  probe.background = async () => {
    throw new Error("synthetic-admission-failed");
  };
  const request = {
    source: "opencitations",
    source_revision: await sources.testRevision("opencitations"),
    request_id: randomUUID(),
  };
  await expect(
    Promise.all([probe.test(request), probe.test(request)]),
  ).rejects.toThrow("synthetic-admission-failed");
  expect(probe.slot("opencitations")).toBeNull();
  expect(probe.activeCount).toBe(0);
  probe.background = background;
  await probe.test(request);
  await probe.settle();
  expect(
    (await sources.directory()).rows.find((r) => r.source === "opencitations")!
      .test.latest?.status,
  ).toBe("available");
  probe.background = async () => {
    throw new Error("synthetic-admission-failed");
  };
  const all = {
    catalog_revision: (await sources.directory()).catalog_revision,
    request_id: randomUUID(),
    scope: "configured",
  };
  await expect(probe.all(all)).rejects.toThrow("synthetic-admission-failed");
  expect(probe.slot("crossref")).toBeNull();
  expect(probe.activeCount).toBe(0);
});

it.each([
  [403, "AUTHORIZATION_ERROR", "no-fulltext-permission"],
  [403, "AUTHENTICATION_ERROR", "credential-invalid"],
  [403, "UNKNOWN_VENDOR_ERROR", "error"],
  [403, "", "error"],
  [429, "AUTHORIZATION_ERROR", "error"],
  [503, "AUTHORIZATION_ERROR", "error"],
] as const)(
  "classifies the bounded native Article response %s/%s as %s",
  async (status, code, expected) => {
    const { sources, probe } = await fixture({
      metadata: {
        transportFactory: () => ({
          request: async () => {
            networkRequestDispatched();
            return { "search-results": { entry: [] } };
          },
        }),
      },
      acquisition: {
        authorizedTransportFactory: () => ({
          request: async () => ({
            status,
            headers: [["content-type", "application/json"]],
            body: Buffer.from(
              code
                ? JSON.stringify({
                    "service-error": {
                      status: {
                        statusCode: code,
                        statusText: "synthetic-private-response",
                      },
                    },
                  })
                : "<html>synthetic challenge</html>",
            ),
          }),
        }),
      },
    });
    await sources.save({
      source: "elsevier",
      baseline: (await sources.directory()).catalog_revision,
      parameters: { action: "keep" },
      credentials: [
        { field: "api_key", action: "replace", value: "fake-private-elsevier" },
      ],
      test_after_save: false,
    });
    await probe.test({
      source: "elsevier",
      source_revision: await sources.testRevision("elsevier"),
      request_id: randomUUID(),
    });
    const result = await probe.wait("elsevier");
    expect(result?.status).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-response");
    expect(JSON.stringify(result)).not.toContain("fake-private-elsevier");
  },
);

it("keeps lifecycle cancellation separate from a timed-out request and never caches cancellation as a source error", async () => {
  const held = () => ({
    request: async (_url: string, options?: { signal?: AbortSignal }) => {
      networkRequestDispatched();
      await new Promise<void>((_done, fail) => {
        if (options?.signal?.aborted) fail(new Error("synthetic-abort"));
        else
          options?.signal?.addEventListener(
            "abort",
            () => fail(new Error("synthetic-abort")),
            { once: true },
          );
      });
      return [];
    },
  });
  const cancelled = await fixture({ metadata: { transportFactory: held } });
  await cancelled.probe.test({
    source: "opencitations",
    source_revision: await cancelled.sources.testRevision("opencitations"),
    request_id: randomUUID(),
  });
  await cancelled.probe.close();
  const row = (await cancelled.sources.directory()).rows.find(
    (r) => r.source === "opencitations",
  )!;
  expect(row.test).toMatchObject({ state: "cancelled", latest: null });
  expect(cancelled.probe.activeCount).toBe(0);
  const timed = await fixture({
    timeout_ms: 20,
    metadata: { transportFactory: held },
  });
  await timed.probe.test({
    source: "opencitations",
    source_revision: await timed.sources.testRevision("opencitations"),
    request_id: randomUUID(),
  });
  await timed.probe.settle();
  const timeout = (await timed.sources.directory()).rows.find(
    (r) => r.source === "opencitations",
  )!;
  expect(timeout.test.state).toBe("finished");
  expect(timeout.test.latest).toMatchObject({
    status: "error",
    technical_details: {
      diagnostics: [{ code: "source-test-timeout", scope: "test" }],
    },
  });
});
