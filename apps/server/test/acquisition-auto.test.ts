import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  assemblePublicAcquisitionRegistry,
  splitAcquisitionRoutes,
} from "../src/acquisition/assembly.js";
import { parseConfiguration } from "../src/configuration/index.js";
import {
  parseCredentialText,
  bundlePreview,
} from "../src/configuration/credentials.js";
import { configuredAcquisitionRoutes } from "../src/configuration/acquisition-selection.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { createApplication } from "../src/bootstrap/application.js";

it("Auto adds only configured APIs, never mirrors, without reading credential grants or probing", () => {
  const config = parseConfiguration(
    '[sources.acquisition.unpaywall]\ncontact_email="fixture@example.test"\n',
  );
  const credentials = parseCredentialText(
    '[elsevier]\napi_key="synthetic"\n[wiley]\ntdm_api_token="synthetic"\n[core]\napi_key="synthetic"\n',
  );
  const currentCredential = vi.fn(async () => {
    throw Error("Unexpected credential read");
  });
  const request = vi.fn(async () => {
    throw Error("Unexpected network request");
  });
  const budget = new NetworkBudgetCoordinator();
  try {
    const registry = assemblePublicAcquisitionRegistry(config, budget, {
      credentials,
      currentCredential,
      authorizedTransportFactory: () => ({ request }),
    });
    const routes = splitAcquisitionRoutes(registry);
    expect(routes.stages.direct.sources.map((s) => s.source_name)).toEqual([
      "direct",
      "arxiv",
      "europe-pmc",
    ]);
    expect(
      routes.stages["publisher-api"].sources.map((s) => s.source_name),
    ).toEqual(["elsevier", "wiley"]);
    expect(
      routes.stages["general-api"].sources.map((s) => s.source_name),
    ).toEqual(["unpaywall", "core"]);
    expect(registry.statuses.some((s) => s.source_name === "sci-hub")).toBe(
      false,
    );
    expect(currentCredential).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(
      configuredAcquisitionRoutes(config, bundlePreview(credentials))
        .filter((r) => r.mode_reason === "auto-configured")
        .map((r) => r.source),
    ).toEqual(["elsevier", "wiley", "unpaywall", "core"]);
    const absent = assemblePublicAcquisitionRegistry(
      parseConfiguration(""),
      budget,
      { currentCredential },
    );
    expect(absent.statuses.map((s) => s.source_name)).toEqual([
      "direct",
      "arxiv",
      "europe-pmc",
      "doi-landing",
    ]);
    expect(absent.unavailable).toEqual({ browser: "browser-route-not-wired" });
    const partial = assemblePublicAcquisitionRegistry(
      parseConfiguration(""),
      budget,
      {
        credentials: parseCredentialText(
          '[elsevier]\ninstitution_token="synthetic"\n',
        ),
        currentCredential,
      },
    );
    expect(partial.statuses.some((s) => s.source_name === "elsevier")).toBe(
      false,
    );
    const custom = assemblePublicAcquisitionRegistry(
      parseConfiguration(
        '[sources.acquisition]\nmode="custom"\nproviders=["wiley","core"]\n',
      ),
      budget,
    );
    expect(custom.statuses.map((s) => s.source_name)).toEqual([
      "direct",
      "wiley",
      "core",
      "doi-landing",
    ]);
    expect(
      custom.statuses.filter((s) => !s.ready).map((s) => s.failure_code),
    ).toEqual(["missing-credential", "missing-credential"]);
  } finally {
    budget.close();
  }
});

it("reports frozen effective routes and saved credential-only pending changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-auto-routes-"));
  const owner = new TypeScriptConfigurationOwner(home);
  const app = await createApplication(home, { configurationOwner: owner });
  try {
    const before = await app.configurationStatus();
    expect(before.acquisition_routes?.changed).toBe(false);
    const revision = (await owner.read()).revision;
    await owner.credential(
      {
        namespace: "source",
        target: "wiley",
        kind: "set",
        fields: { tdm_api_token: "synthetic-only" },
      },
      revision,
    );
    const next = await app.configurationStatus();
    expect(next.acquisition_routes).toMatchObject({
      changed: true,
      restart_required: true,
    });
    expect(
      next.acquisition_routes?.effective?.some((r) => r.source === "wiley"),
    ).toBe(false);
    expect(
      next.acquisition_routes?.pending.find((r) => r.source === "wiley"),
    ).toMatchObject({ mode_reason: "auto-configured", ready: true });
    expect(JSON.stringify(next)).not.toContain("synthetic-only");
    const standalone = await owner.status();
    expect(standalone.acquisition_routes).toMatchObject({
      effective: null,
      changed: null,
      restart_required: null,
    });
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
