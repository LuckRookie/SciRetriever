import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseConfiguration } from "../src/configuration/index.js";
import {
  TypeScriptConfigurationOwner,
  ConfigurationProbeSession,
  renderConfigurationText,
} from "../src/configuration/owner.js";
import {
  bundlePreview,
  parseCredentialText,
  readProxyCredential,
  issueCredentialGrant,
  loadCredentialBundle,
} from "../src/configuration/credentials.js";
import { outboundEgress, selectedEgress } from "../src/configuration/egress.js";
import { connectProxyFixture } from "./network-egress-fixture.js";
import { runCli } from "../src/cli/main.js";
import { SourceConfigurationOwner } from "../src/configuration/sources.js";
import { SourceProbeService } from "../src/configuration/source-probes.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { MAINTENANCE_TOOLS } from "../src/mcp/tools.js";
import { randomUUID } from "node:crypto";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function owner() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-egress-config-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return new TypeScriptConfigurationOwner(home, () => ["93.184.216.34"]);
}
it("rejects unknown configured Providers and local services, including private DNS, with stable reasons", async () => {
  for (const [payload, code] of [
    ["[network.via_proxy]\nbrowser=true", "network-proxy-required"],
    [
      '[network]\nproxy="http://p.test:80"\n[network.via_proxy]\nsources=["unknown"]',
      "network-source-unknown",
    ],
    [
      '[network]\nproxy="http://p.test:80"\n[network.via_proxy]\nproviders=["absent"]',
      "network-provider-unknown",
    ],
    [
      '[network]\nproxy="http://p.test:80"\n[network.via_proxy]\nproviders=["local"]\n[providers.local]\napi="openai-responses"\nbase_url="http://127.0.0.1:8000/v1"',
      "network-local-target",
    ],
    [
      '[network]\nproxy="http://p.test:80"\n[network.via_proxy]\nmineru=true',
      "network-local-target",
    ],
  ])
    expect(() => parseConfiguration(payload!)).toThrow(
      expect.objectContaining({ code }),
    );
  const o = await owner();
  const privateOwner = new TypeScriptConfigurationOwner(o.home, () => [
    "192.168.0.2",
  ]);
  const draft =
    '[network]\nproxy="http://p.test:80"\n[network.via_proxy]\nproviders=["remote"]\n[providers.remote]\napi="openai-responses"\nbase_url="https://model.test/v1"';
  expect(privateOwner.validate(draft).network.via_proxy.providers).toEqual([
    "remote",
  ]);
  await expect(privateOwner.diff(draft, "missing")).rejects.toMatchObject({
    code: "network-local-target",
  });
  await expect(
    privateOwner.publish(draft, "missing", ["network", "providers"]),
  ).rejects.toMatchObject({ code: "network-local-target" });
  expect((await privateOwner.read()).revision).toBe("missing");
  const unresolved = new TypeScriptConfigurationOwner(o.home, () => {
    throw new Error("synthetic DNS failure");
  });
  await expect(unresolved.diff(draft, "missing")).rejects.toMatchObject({
    code: "network-target-unresolved",
  });
});
it("publishes only network, binds authentication to exact proxy origins, supports transition and immediate removal", async () => {
  const o = await owner();
  const a = "http://127.0.0.1:7890",
    b = "http://127.0.0.1:7891";
  let snap = await o.publish(
    `[network]\nproxy="${a}"\n[network.via_proxy]\nsources=["semantic-scholar"]`,
    "missing",
    ["network"],
  );
  await o.credential(
    {
      namespace: "proxy",
      target: "proxy",
      kind: "set",
      value: "fixture-user:fixture:password with spaces",
    },
    snap.revision,
  );
  const first = outboundEgress(
    snap.configuration.network,
    { kind: "source", id: "semantic-scholar" },
    undefined,
    o.authorizeCurrentCredential.bind(o),
  );
  expect(await first.proxy?.authorization?.()).toBe(
    "fixture-user:fixture:password with spaces",
  );
  const raw = renderConfigurationText({
    ...snap.configuration,
    network: { ...snap.configuration.network, proxy: b },
  });
  snap = await o.publish(raw, snap.revision, ["network"]);
  const next = outboundEgress(
    snap.configuration.network,
    { kind: "source", id: "semantic-scholar" },
    undefined,
    o.authorizeCurrentCredential.bind(o),
  );
  expect(await next.proxy?.authorization?.()).toBeNull();
  expect((await o.status()).network).toMatchObject({
    proxy_configured: true,
    proxy_authentication: false,
  });
  await o.credential(
    {
      namespace: "proxy",
      target: "proxy",
      kind: "set",
      value: "next:fixture-value",
    },
    snap.revision,
  );
  expect(await first.proxy?.authorization?.()).toBe(
    "fixture-user:fixture:password with spaces",
  );
  expect(await next.proxy?.authorization?.()).toBe("next:fixture-value");
  const bundle = await loadCredentialBundle(o.home);
  expect(readProxyCredential(bundle, "http://127.0.0.1:7892")).toBeNull();
  expect(
    bundlePreview(bundle).sections.find((v) => v.section === "proxy"),
  ).toMatchObject({ origin: a, has_transition: true });
  expect(() =>
    issueCredentialGrant(
      bundle,
      "core",
      "proxy",
      "basic_auth",
      b,
      "proxy-connect",
    ),
  ).toThrow();
  expect(() =>
    issueCredentialGrant(
      bundle,
      "core",
      "proxy",
      "basic_auth",
      a,
      "parser-health",
    ),
  ).toThrow();
  const safe = JSON.stringify({
    snapshot: await o.read(),
    readiness: await o.status(),
    preview: bundlePreview(bundle),
  });
  expect(safe).not.toContain("fixture-value");
  expect(safe).not.toContain("fixture:password");
  expect(
    await readFile(join(o.home, ".sciretriever/config.toml"), "utf8"),
  ).not.toContain("fixture-value");
  await o.credential(
    { namespace: "proxy", target: "proxy", kind: "remove" },
    snap.revision,
  );
  expect(await first.proxy?.authorization?.()).toBeNull();
  expect(await next.proxy?.authorization?.()).toBeNull();
});
it("validates credential shapes without reflecting values, and routes by requester rather than host", () => {
  for (const payload of [
    '[proxy]\norigin="http://p.test:80"',
    '[proxy]\norigin="http://p.test:80"\nbasic_auth="fixture-only"',
    '[proxy]\norigin="http://p.test:80"\nbasic_auth="u:p"\nnext_origin="http://q.test:80"',
    '[proxy]\norigin="http://p.test:80"\nbasic_auth="u:p"\nnext_origin="http://p.test:80"\nnext_basic_auth="x:y"',
  ])
    expect(() => parseCredentialText(payload)).toThrow();
  const c = parseConfiguration(
    '[network]\nproxy="http://p.test:80"\n[network.via_proxy]\nsources=["semantic-scholar"]\ndoi_resolution=true',
  );
  expect(
    selectedEgress(c.network, { kind: "source", id: "semantic-scholar" }),
  ).toBe("proxy");
  expect(selectedEgress(c.network, { kind: "source", id: "crossref" })).toBe(
    "direct",
  );
  expect(selectedEgress(c.network, { kind: "doi-resolution" })).toBe("proxy");
  expect(selectedEgress(c.network, { kind: "browser" })).toBe("direct");
  expect(
    selectedEgress(
      parseConfiguration('[network]\nproxy="http://p.test:80"').network,
      { kind: "source", id: "semantic-scholar" },
    ),
  ).toBe("direct");
});
it("offers authorized CONNECT-only proxy tests through the owner, CLI and MCP schema", async () => {
  const p = await connectProxyFixture();
  cleanup.push(p.close);
  const o = await owner();
  await o.publish(`[network]\nproxy="${p.origin}"`, "missing", ["network"]);
  const session = await ConfigurationProbeSession.create(o, {
    resolver: () => ["93.184.216.34"],
  });
  cleanup.push(async () => session.close());
  expect(
    await session.run(
      { owner: "proxy", target: null, image: false },
      { authorized: false },
    ),
  ).toMatchObject({
    egress: "proxy",
    outcome: "blocked",
    reason: "probe-not-authorized",
    network_performed: false,
  });
  expect(p.connections).toEqual([]);
  expect(
    await session.run(
      { owner: "proxy", target: null, image: false },
      { authorized: true },
    ),
  ).toMatchObject({
    egress: "proxy",
    outcome: "passed",
    method: "CONNECT",
    execution: { code: "probe-passed" },
  });
  expect(p.connections[0]).toEqual({
    authority: "api.crossref.org:443",
    authorization: undefined,
  });
  const result = await runCli(["config", "test", "proxy", "--json"], {
    home: o.home,
    stdout: () => undefined,
    stderr: () => undefined,
    probeSeams: { resolver: () => ["93.184.216.34"] },
  });
  expect(result.code).toBe(0);
  expect(result.value).toMatchObject({ outcome: "passed", egress: "proxy" });
  expect(
    JSON.stringify(
      MAINTENANCE_TOOLS.find((t) => t.name === "configuration_probe")
        ?.inputSchema,
    ),
  ).toContain('"proxy"');
  expect(
    JSON.stringify(
      MAINTENANCE_TOOLS.find((t) => t.name === "configuration_publish")
        ?.inputSchema,
    ),
  ).toContain('"network"');
});
it("preserves proxy failure and egress on real source/model/parser probe paths and invalidates cached source results", async () => {
  const p = await connectProxyFixture({ status: 407 });
  cleanup.push(p.close);
  const o = await owner();
  const snap = await o.publish(
    `[network]\nproxy="${p.origin}"\n[network.via_proxy]\nsources=["semantic-scholar"]\nproviders=["fixture"]\nmineru=true\n[providers.fixture]\napi="openai-responses"\nbase_url="https://model.test/v1"\n[models."fixture/test"]\nimage=false\n[analyze]\nmodel="fixture/test"\n[parsing]\nconnection_mode="remote"\nbase_url="https://parser.test/v2"\nmodel_identity="mineru-3.4.4-vlm"\nremote_upload_authorized=true`,
    "missing",
    ["network", "providers", "models", "analyze", "parsing"],
  );
  await o.credential(
    {
      namespace: "model",
      target: "fixture",
      kind: "set",
      value: "synthetic-model",
    },
    snap.revision,
  );
  await o.credential(
    {
      namespace: "mineru",
      target: "mineru",
      kind: "set",
      value: "synthetic-parser",
    },
    snap.revision,
  );
  const session = await ConfigurationProbeSession.create(o, {
    resolver: () => ["93.184.216.34"],
  });
  cleanup.push(async () => session.close());
  for (const req of [
    { owner: "search" as const, target: "semantic-scholar", image: false },
    { owner: "model" as const, target: "fixture/test", image: false },
    { owner: "parse" as const, target: null, image: false },
  ])
    expect(await session.run(req, { authorized: true })).toMatchObject({
      outcome: "failed",
      egress: "proxy",
      reason: "proxy-unavailable",
    });
  const sources = new SourceConfigurationOwner(o),
    network = new NetworkBudgetCoordinator();
  cleanup.push(async () => network.close());
  const probe = new SourceProbeService(sources, network, {
    metadata: { resolver: () => ["93.184.216.34"] },
  });
  cleanup.push(() => probe.close());
  const revision = await sources.testRevision("semantic-scholar");
  await probe.test({
    source: "semantic-scholar",
    source_revision: revision,
    request_id: randomUUID(),
  });
  expect(await probe.wait("semantic-scholar")).toMatchObject({
    status: "error",
    egress: "proxy",
    checks: [
      {
        egress: "proxy",
        technical_details: { diagnostics: [{ code: "proxy-unavailable" }] },
      },
    ],
  });
  expect(
    (await sources.directory()).rows.find(
      (r) => r.source === "semantic-scholar",
    ),
  ).toMatchObject({ egress: "proxy" });
  await o.publish(
    renderConfigurationText({
      ...snap.configuration,
      network: {
        ...snap.configuration.network,
        proxy: "http://127.0.0.1:7893",
      },
    }),
    snap.revision,
    ["network"],
  );
  expect(await sources.testRevision("semantic-scholar")).not.toBe(revision);
  expect(
    (await sources.directory()).rows.find(
      (r) => r.source === "semantic-scholar",
    )?.test.latest,
  ).toBeNull();
});

it("validates the merged graph when a Provider-only publication keeps an existing proxy selection", async () => {
  const o = await owner();
  const original = await o.publish(
    '[network]\nproxy="http://127.0.0.1:7890"\n[network.via_proxy]\nproviders=["fixture"]\n[providers.fixture]\napi="openai-responses"\nbase_url="https://model.test/v1"',
    "missing",
    ["network", "providers"],
  );
  const privateDns = new TypeScriptConfigurationOwner(o.home, () => [
    "192.168.1.2",
  ]);
  await expect(
    privateDns.publish(
      '[providers.fixture]\napi="openai-responses"\nbase_url="https://intranet.test/v1"',
      original.revision,
      ["providers"],
    ),
  ).rejects.toMatchObject({ code: "network-local-target" });
  expect(await o.read()).toEqual(original);
});
