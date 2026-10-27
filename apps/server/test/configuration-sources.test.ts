import {
  mkdtemp,
  rm,
  readFile,
  lstat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  parseSourceDirectory,
  parseSourceSaveRequest,
  parseSourceSelectionSaveRequest,
} from "@sciretriever/contracts";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  SourceConfigurationOwner,
  sourceBindingRevision,
} from "../src/configuration/sources.js";
import {
  bundlePreview,
  loadCredentialBundle,
} from "../src/configuration/credentials.js";
import { configuredMetadataSelections } from "../src/metadata/registry.js";
import { assembleMetadataRegistry } from "../src/metadata/assembly.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { sourceParameters } from "../src/configuration/sources.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-config-"));
  homes.push(home);
  const owner = new TypeScriptConfigurationOwner(home);
  await owner.read();
  return { home, owner, sources: new SourceConfigurationOwner(owner) };
}
const row = (
  d: Awaited<ReturnType<SourceConfigurationOwner["directory"]>>,
  id: string,
) => d.rows.find((r) => r.source === id)!;
async function save(
  sources: SourceConfigurationOwner,
  source: string,
  credentials: unknown[] = [],
  parameters: unknown = { action: "keep" },
) {
  return sources.save({
    source,
    baseline: (await sources.directory()).catalog_revision,
    parameters,
    credentials,
    test_after_save: false,
  });
}
it("projects exactly 15 rows, capability-specific requirements and secret presence only", async () => {
  const { sources } = await fixture();
  const d = await sources.directory();
  expect(parseSourceDirectory(d)).toEqual(d);
  expect(d.rows).toHaveLength(15);
  expect(
    d.rows.every(
      (r) =>
        r.uses.lookup.selected === null && r.uses.lookup.state !== "active",
    ),
  ).toBe(true);
  expect(row(d, "core").uses.lookup).toMatchObject({ ready: true });
  expect(row(d, "core").uses.pdf).toMatchObject({ ready: false });
  expect(row(d, "plos").test.availability).toBe("not-supported");
  expect(
    row(d, "springer").configuration.fields.some(
      (f) => f.field === "api_metric",
    ),
  ).toBe(false);
  expect(d.pending_pdf_routes.map((r) => r.source)).toEqual([
    "direct",
    "arxiv",
    "europe-pmc",
    "doi-landing",
    "sci-hub",
  ]);
});
it("replaces and clears one credential field, preserving other sources and CAS across key-only publications", async () => {
  const { home, sources, owner } = await fixture();
  const canary = "test-only-private-value";
  const first = await save(sources, "elsevier", [
    { field: "api_key", action: "replace", value: canary },
    {
      field: "institution_token",
      action: "replace",
      value: "second-test-field",
    },
  ]);
  const baseline = (await sources.directory()).catalog_revision;
  const beforeRow = row(await sources.directory(), "elsevier");
  await save(sources, "wiley", [
    { field: "tdm_api_token", action: "replace", value: "third-test-field" },
  ]);
  await expect(
    sources.save({
      source: "elsevier",
      baseline,
      parameters: { action: "keep" },
      credentials: [
        { field: "api_key", action: "replace", value: "replacement" },
      ],
      test_after_save: false,
    }),
  ).rejects.toMatchObject({ code: "source-configuration-conflict" });
  await save(sources, "elsevier", [
    { field: "institution_token", action: "clear" },
  ]);
  const d = await sources.directory(),
    fields = row(d, "elsevier").configuration.fields;
  expect(fields.find((f) => f.field === "api_key")).toMatchObject({
    present: true,
  });
  expect(fields.find((f) => f.field === "institution_token")).toMatchObject({
    present: false,
  });
  expect(row(d, "elsevier").source_revision).not.toBe(
    beforeRow.source_revision,
  );
  const unchanged = row(d, "wiley").source_revision;
  await save(sources, "elsevier", [
    { field: "api_key", action: "replace", value: canary },
  ]);
  expect(row(await sources.directory(), "wiley").source_revision).toBe(
    unchanged,
  );
  expect(JSON.stringify([first, d])).not.toContain(canary);
  expect(
    JSON.stringify(
      await readFile(join(home, ".sciretriever", "source-state.json"), "utf8"),
    ),
  ).not.toContain(canary);
  expect(
    (await lstat(join(home, ".sciretriever", "credentials.toml"))).mode & 0o777,
  ).toBe(0o600);
  expect((await owner.read()).configuration.sources.metadata.mode).toBe("auto");
});
it("saves public parameters one row at a time, resets mirrors and rejects invalid or cross-domain edits", async () => {
  const { sources, owner } = await fixture();
  await save(sources, "web-of-science", [], {
    action: "set",
    value: { product: "expanded", database: "WOS", edition: "SCI" },
  });
  await save(sources, "crossref", [], {
    action: "set",
    value: { mode: "polite", mailto: "owner@example.test" },
  });
  await save(sources, "unpaywall", [], {
    action: "set",
    value: { contact_email: "owner@example.test" },
  });
  await save(sources, "sci-hub", [], {
    action: "set",
    value: { urls: ["https://mirror.example"] },
  });
  expect(
    row(await sources.directory(), "sci-hub").configuration.fields[0],
  ).toMatchObject({ value: ["https://mirror.example"], value_origin: "saved" });
  await save(sources, "sci-hub", [], { action: "reset" });
  expect(
    sourceParameters((await owner.read()).configuration, "web-of-science"),
  ).toMatchObject({ database: "WOS", product: "expanded" });
  expect(
    row(await sources.directory(), "sci-hub").configuration.fields[0],
  ).toMatchObject({ value: ["https://sci-hub.ru"], value_origin: "builtin" });
  await expect(
    save(sources, "unpaywall", [], {
      action: "set",
      value: { contact_email: "invalid" },
    }),
  ).rejects.toBeDefined();
  await expect(
    save(sources, "elsevier", [
      { field: "api_metric", action: "replace", value: "synthetic" },
    ]),
  ).rejects.toBeDefined();
  await expect(
    sources.select({
      baseline: (await sources.directory()).catalog_revision,
      domain: "pdf",
      selection: { mode: "custom", providers: ["crossref"] },
    }),
  ).rejects.toBeDefined();
});
it("returns typed partial on the second publication failure and preserves the first committed fact", async () => {
  const { owner } = await fixture();
  const sources = new SourceConfigurationOwner(owner, {
    beforeConfigurationWrite: async () => {
      throw new Error("injected");
    },
  });
  const result = await save(
    sources,
    "web-of-science",
    [{ field: "api_key", action: "replace", value: "test-only" }],
    { action: "set", value: { product: "starter", database: "WOS" } },
  );
  expect(result).toMatchObject({
    status: "partial",
    committed_fields: ["credentials.api_key"],
    test_ticket: null,
  });
  expect(
    row(await sources.directory(), "web-of-science").configuration.fields.find(
      (f) => f.field === "api_key",
    ),
  ).toMatchObject({ present: true });
  expect(
    (await owner.read()).configuration.sources.metadata.web_of_science,
  ).toBeNull();
});
it("freezes runtime selections, makes configured metadata Auto additive, and does not restart for same-presence rotation", async () => {
  const { owner, sources } = await fixture();
  for (const source of ["elsevier", "springer", "web-of-science"])
    await save(sources, source, [
      { field: "api_key", action: "replace", value: "synthetic" },
    ]);
  expect((await sources.directory()).preview.auto.metadata.topic).toEqual(
    expect.arrayContaining(["elsevier", "springer"]),
  );
  expect((await sources.directory()).preview.auto.metadata.topic).not.toContain(
    "web-of-science",
  );
  await save(sources, "web-of-science", [], {
    action: "set",
    value: { product: "expanded", database: "WOS" },
  });
  const snap = await owner.read(),
    p = bundlePreview(await loadCredentialBundle(owner.home));
  const network = new NetworkBudgetCoordinator();
  const metadata = assembleMetadataRegistry(
    snap.configuration,
    await loadCredentialBundle(owner.home),
    network,
  );
  sources.runtime = {
    runtime_id: randomUUID(),
    configuration: snap.configuration,
    presence: p,
    metadata,
    effective_routes: async () => (await owner.acquisitionRoutes(snap)).pending,
  };
  try {
    expect((await sources.directory()).restart_required).toBe(false);
    await save(sources, "elsevier", [
      { field: "api_key", action: "replace", value: "rotated-synthetic" },
    ]);
    expect((await sources.directory()).restart_required).toBe(false);
    expect(
      row(await sources.directory(), "web-of-science").uses.reference_query
        .state,
    ).toBe("active");
    await save(sources, "web-of-science", [], {
      action: "set",
      value: { product: "starter", database: "WOS" },
    });
    const savedProduct = await sources.directory();
    expect(
      row(savedProduct, "web-of-science").uses.reference_query,
    ).toMatchObject({
      state: "active",
      selected: true,
      pending_selected: false,
    });
    expect(savedProduct.restart_required).toBe(true);
    await sources.select({
      baseline: (await sources.directory()).catalog_revision,
      domain: "metadata",
      selection: { mode: "custom", providers: [] },
    });
    const next = await sources.directory();
    expect(next.restart_required).toBe(true);
    expect(next.preview.custom.metadata.topic).toEqual([]);
    expect(row(next, "web-of-science").uses.lookup).toMatchObject({
      state: "active",
      pending_selected: false,
    });
    expect(sourceBindingRevision(snap.configuration, p)).toBe(
      next.runtime?.binding_revision,
    );
  } finally {
    network.close();
  }
  expect(
    configuredMetadataSelections(snap.configuration, undefined, [
      "elsevier",
      "springer",
      "web-of-science",
    ]).topic,
  ).toEqual(expect.arrayContaining(["elsevier", "springer", "web-of-science"]));
});
it("keeps strict closed requests and rejects unsafe cache paths without following them", async () => {
  expect(() =>
    parseSourceSaveRequest({
      source: "wiley",
      baseline: "abc",
      parameters: { action: "keep" },
      credentials: [{ field: "tdm_api_token", action: "replace", value: "" }],
      test_after_save: false,
    }),
  ).toThrow();
  expect(() =>
    parseSourceSelectionSaveRequest({
      baseline: "abc",
      domain: "pdf",
      selection: { mode: "auto", providers: ["arxiv"] },
    }),
  ).toThrow();
  const { home, sources } = await fixture();
  await writeFile(join(home, "sentinel"), "do-not-touch");
  await symlink(
    join(home, "sentinel"),
    join(home, ".sciretriever", "source-state.json"),
  );
  expect(
    (await sources.directory()).technical_details.diagnostics,
  ).toMatchObject([{ code: "source-state-invalid" }]);
  expect(await readFile(join(home, "sentinel"), "utf8")).toBe("do-not-touch");
});

it("keeps a saved source fact visible when asynchronous probe dispatch is refused", async () => {
  const { sources } = await fixture();
  sources.tests = {
    slot: () => null,
    start: async () => {
      throw new Error("synthetic-dispatch-refused");
    },
  };
  const result = await sources.save({
    source: "wiley",
    baseline: (await sources.directory()).catalog_revision,
    parameters: { action: "keep" },
    credentials: [
      { field: "tdm_api_token", action: "replace", value: "synthetic" },
    ],
    test_after_save: true,
  });
  expect(result).toMatchObject({
    status: "saved",
    test_ticket: null,
    test_problem: {
      display: "error",
      technical_details: { diagnostics: [{ code: "source-test-not-started" }] },
    },
  });
  expect(
    row(await sources.directory(), "wiley").configuration.fields[0],
  ).toMatchObject({ present: true });
});
