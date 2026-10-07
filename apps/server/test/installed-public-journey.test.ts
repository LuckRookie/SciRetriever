import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { expect, it, vi } from "vitest";
import {
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import type * as Server from "../src/index.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";
import {
  FIXTURE_DOI,
  FIXTURE_LITERATURE,
  startWorkbenchFixture,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type Contracts = typeof import("@sciretriever/contracts");
type Maintenance = NonNullable<Server.Application["maintenance"]>;
type Result<T> = { protocol_version: 1; result: T };
type Responses = {
  read: {
    detail: Awaited<ReturnType<Server.Application["library"]["detail"]>>;
  };
  "parse-document": {
    receipt: Awaited<ReturnType<Maintenance["parseDocuments"]>>;
  };
  "document-describe": Result<
    Awaited<ReturnType<Server.Application["documentRead"]["describe"]>>
  >;
  "rebuild-index": Result<unknown>;
  "material-evidence": Result<
    Awaited<ReturnType<Server.Application["documentRead"]["materialEvidence"]>>
  >;
  "evidence-resolve": Result<
    Awaited<ReturnType<Server.Application["documentRead"]["resolveEvidence"]>>
  >;
  context: Result<
    Awaited<
      ReturnType<NonNullable<Server.QueryApplication["context"]>["search"]>
    >
  >;
  "extraction-prepare": Result<
    Awaited<ReturnType<Server.Application["extractionPreparation"]["prepare"]>>
  >;
  "extraction-operation": Result<
    Awaited<ReturnType<Server.Application["extractionDelivery"]["create"]>>
  >;
  "extraction-submit": Result<
    Awaited<ReturnType<Server.Application["extractionDelivery"]["submit"]>>
  >;
  "extraction-receipt": Result<
    NonNullable<
      Awaited<ReturnType<Server.Application["extractionDelivery"]["receipt"]>>
    >
  >;
  "analyze-knowledge": Result<Awaited<ReturnType<Maintenance["analyze"]>>>;
  "knowledge-read": Result<
    NonNullable<
      Awaited<
        ReturnType<
          NonNullable<Server.QueryApplication["knowledgeRead"]>["byId"]
        >
      >
    >
  >;
  "rebuild-knowledge-index": Result<unknown>;
  "knowledge-context": Result<
    Awaited<
      ReturnType<
        NonNullable<Server.QueryApplication["knowledgeContext"]>["search"]
      >
    >
  >;
  "synthesis-prepare": Result<
    Awaited<
      ReturnType<
        NonNullable<Server.QueryApplication["synthesisPreparation"]>["prepare"]
      >
    >
  >;
  synthesize: Result<
    Awaited<ReturnType<NonNullable<Maintenance["synthesize"]>>>
  >;
  "synthesis-read": Result<
    NonNullable<
      Awaited<
        ReturnType<
          NonNullable<Server.QueryApplication["synthesisRead"]>["byId"]
        >
      >
    >
  >;
};

/**
 * This fake installation manifest and executable shim are only a runtime fixture.
 * They exercise installed Bootstrap/Host code with test Chromium, and are neither
 * a signed Cloak installation nor evidence that the real Cloak runtime passed.
 */
async function prepareSyntheticBrowserRuntime(root: string): Promise<string> {
  const bundle = join(root, "synthetic-browser-bundle");
  await mkdir(bundle, { mode: 0o700 });
  const executable =
    process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ?? chromium.executablePath();
  const quoted = `'${executable.replaceAll("'", "'\\''")}'`;
  const bytes = Buffer.from(
    `#!/bin/sh\n# Synthetic test Chromium runtime.\nexec ${quoted} "$@"\n`,
  );
  await writeFile(join(bundle, "chrome"), bytes, { mode: 0o700 });
  const name = Buffer.from("chrome");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(name.byteLength);
  const mode = Buffer.alloc(2);
  mode.writeUInt16BE(0o700);
  const bundleHash = createHash("sha256")
    .update(size)
    .update(name)
    .update(mode)
    .update(bytes)
    .digest("hex");
  await writeFile(
    join(bundle, ".sciretriever-binary-manifest.json"),
    JSON.stringify({
      archive_sha256:
        "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e",
      binary_version: "146.0.7680.177.5",
      bundle_sha256: bundleHash,
      compatible_playwright: "==1.55.0",
      executable_sha256: sha256(bytes),
      origin: "https://cloakbrowser.dev",
      platform: "linux-x64",
      playwright_version: "1.55.0",
      signature_algorithm: "ed25519",
      signature_verified: true,
      verified_at: "2026-09-30T00:00:00Z",
      wrapper_version: "0.5.8",
    }),
    { mode: 0o600 },
  );
  return bundle;
}

async function installedBrowserJourney(
  server: typeof Server,
  contracts: Contracts,
  home: string,
  root: string,
  siteOrigin: string,
  literatureId: string,
): Promise<string> {
  const budget = new NetworkBudgetCoordinator();
  const port = Number(new URL(siteOrigin).port);
  const resolver = () => ["127.0.0.1"];
  const policy = {
    allowed_schemes: ["http"] as const,
    allowed_classes: ["loopback"] as const,
    allowed_addresses: ["127.0.0.1"],
    allowed_ports: [{ scheme: "http" as const, port }],
  };
  // Network is an external loopback fixture; business owners come from the install.
  const proxy = new BrowserNetworkProxy({
    resolver,
    policy,
    coordinator: budget,
    limits: {
      maxConcurrency: 4,
      maxHostConcurrency: 4,
      maxResponseBytes: 16 * 1024 * 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  let workbench:
    | Awaited<ReturnType<typeof Server.startProductionWorkbench>>
    | undefined;
  let uiBrowser: Browser | undefined;
  const gates: Promise<void>[] = [];
  const releaseModels: (() => void)[] = [];
  for (let index = 0; index < 3; index++) {
    gates.push(new Promise<void>((resolve) => releaseModels.push(resolve)));
  }
  let modelCalls = 0;
  const observedGuidance: string[] = [];
  try {
    vi.stubEnv(
      "SCIRETRIEVER_CLOAK_BUNDLE",
      process.env.SCIRETRIEVER_INSTALLED_CLOAK_BUNDLE ??
        (await prepareSyntheticBrowserRuntime(root)),
    );
    const connection = await proxy.start();
    workbench = await server.startProductionWorkbench({
      home,
      literature_id: literatureId,
      applicationOptions: {
        browserProxy: connection,
        browserAdmitNavigation: async (url) =>
          (await resolveDestination(url, resolver, policy)).url.url,
        acquisitionAssembly: {
          doiLandingSource: {
            source_name: "doi-landing",
            ready: true,
            discover: async () => [],
          },
        },
        agentTransportFactory:
          () =>
          async ({ body, onDispatched }) => {
            onDispatched?.();
            const index = modelCalls++;
            const wire = JSON.parse(new TextDecoder().decode(body)) as {
              messages: { content: { type: string; text?: string }[] }[];
            };
            const parts = wire.messages[1]!.content.filter(
              (part) => part.type === "text",
            );
            const observation = JSON.parse(parts[0]!.text!) as Pick<
              WorkbenchObservation,
              "observation_revision" | "elements"
            >;
            observedGuidance.push(...parts.slice(1).map((part) => part.text!));
            // The first/third late replies intentionally ignore AbortSignal. A
            // takeover must invalidate them before they can click the PDF button.
            await gates[index];
            const download = observation.elements.find(
              (element) => element.name === "Download PDF",
            );
            const action =
              index === 1
                ? {
                    kind: "wait-for-change",
                    revision: observation.observation_revision,
                    timeout_ms: 50,
                  }
                : download
                  ? {
                      kind: "click-element",
                      element_id: download.element_id,
                      revision: observation.observation_revision,
                    }
                  : { kind: "stop", reason: "budget" };
            return {
              status: 200,
              headers: [],
              body: Buffer.from(
                JSON.stringify({
                  model: "installed-model",
                  choices: [
                    {
                      finish_reason: "tool_calls",
                      message: {
                        tool_calls: [
                          {
                            function: {
                              name: "browser_action",
                              arguments: JSON.stringify({ action }),
                            },
                          },
                        ],
                      },
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
              ),
            };
          },
      },
    });
    const origin = workbench.origin;
    uiBrowser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const ui = await uiBrowser.newPage();
    const errors: string[] = [];
    ui.on("pageerror", (error) => errors.push(error.message));
    await ui.goto(origin);
    await ui.waitForFunction(() => {
      const button =
        document.querySelector<HTMLButtonElement>("#acquisition-start");
      return button && !button.disabled;
    });
    const landing = await fetch(origin);
    const cookie = landing.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    type Client = { id: string; csrf: string };
    const post = async (path: string, body: unknown, client?: Client) => {
      const response = await fetch(
        `${origin}${path}${client ? `?client_id=${client.id}` : ""}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie!,
            Origin: origin,
            "Content-Type": "application/json",
            ...(client
              ? { "X-Workbench-Csrf": client.csrf }
              : { "X-Workbench-Init": "1" }),
          },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const attach = async (): Promise<Client> => {
      const response = await post("/api/clients", {});
      expect(response.status).toBe(201);
      expect(
        contracts.parseWorkbenchView(response.body.view).observation,
      ).toBeNull();
      return {
        id: response.body.client_id as string,
        csrf: response.body.csrf as string,
      };
    };
    const controller = await attach();
    const watcher = await attach();
    const view = async (client = controller) => {
      const response = await fetch(
        `${origin}/api/view?client_id=${client.id}`,
        { headers: { Cookie: cookie! } },
      );
      expect(response.status).toBe(200);
      return contracts.parseWorkbenchView(await response.json());
    };
    const control = async (
      kind: string,
      current: Awaited<ReturnType<typeof view>>,
    ) => {
      const response = await post(
        "/api/control",
        {
          kind,
          session_id: current.session_id,
          article_id: current.article_id,
          control_epoch: current.control.epoch,
        },
        controller,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return contracts.parseWorkbenchView(response.body.view);
    };
    // Merely loading and watching the installed UI has not fetched a PDF.
    const before = await view();
    expect(before.observation).toBeNull();
    expect(modelCalls).toBe(0);
    await ui.locator("#acquisition-start").click();
    await vi.waitFor(
      async () => {
        expect(modelCalls).toBe(1);
        expect((await view()).observation).not.toBeNull();
      },
      { timeout: 30_000 },
    );
    const running = await view();
    expect(running.article_id).toBe(literatureId);
    expect(running.operation_feedback?.targets).toMatchObject({
      total: 1,
      running: 1,
    });
    expect(running.control.viewers).toBe(3);
    expect((await view(watcher)).observation?.page_id).toBe(
      running.observation!.page_id,
    );
    const frame = await fetch(
      `${origin}/api/frame?client_id=${watcher.id}&frame_seq=${running.observation!.frame_seq}`,
      { headers: { Cookie: cookie! } },
    );
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect((await frame.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const hint = await post(
      "/api/guidance",
      {
        guidance_id: "installed-hint-1",
        session_id: running.session_id,
        article_id: literatureId,
        control_epoch: running.control.epoch,
        text: "Use the visible PDF button",
      },
      watcher,
    );
    expect(hint.status).toBe(200);
    expect(
      contracts.parseWorkbenchView(hint.body.view).guidance?.[0]?.state,
    ).toBe("accepted");
    const taken = await control("takeover", await view());
    expect(taken.control.controller_id).toBe(controller.id);
    releaseModels[0]!();
    await vi.waitFor(async () =>
      expect((await view()).guidance?.[0]?.state).toBe("expired"),
    );
    await control("release", await view());
    await vi.waitFor(() => expect(modelCalls).toBe(2));
    const second = await view();
    const secondHint = await post(
      "/api/guidance",
      {
        guidance_id: "installed-hint-2",
        session_id: second.session_id,
        article_id: literatureId,
        control_epoch: second.control.epoch,
        text: "The Download PDF link contains the primary article",
      },
      watcher,
    );
    expect(secondHint.status).toBe(200);
    releaseModels[1]!();
    await vi.waitFor(
      async () => {
        expect(modelCalls).toBe(3);
        expect((await view()).guidance?.[1]?.state).toBe("consumed");
      },
      { timeout: 10_000 },
    );
    expect(observedGuidance).toContainEqual(
      expect.stringContaining(
        "The Download PDF link contains the primary article",
      ),
    );
    const watched = await control("takeover", await view());
    releaseModels[2]!();
    expect(watched.session_id).toBe(running.session_id);
    expect(watched.observation!.page_id).toBe(running.observation!.page_id);
    expect(watched.candidates).toHaveLength(0);
    const download = watched.observation!.elements.find(
      (element) => element.name === "Download PDF",
    )!;
    const action = {
      session_id: watched.session_id,
      page_id: watched.observation!.page_id,
      document_generation: watched.observation!.document_generation,
      observation_revision: watched.observation!.observation_revision,
      viewport_revision: watched.observation!.viewport_revision,
      control_epoch: watched.control.epoch,
      request_id: "installed-human-download",
      input: {
        kind: "click-element",
        element_id: download.element_id,
        revision: watched.observation!.observation_revision,
      },
    };
    expect(
      (
        await post(
          "/api/action",
          { ...action, control_epoch: running.control.epoch },
          controller,
        )
      ).status,
    ).toBe(409);
    const clicked = await post("/api/action", action, controller);
    expect(clicked.status, JSON.stringify(clicked.body)).toBe(200);
    await vi.waitFor(
      async () => expect((await view()).state).toBe("finished"),
      { timeout: 30_000 },
    );
    const finished = await view();
    expect(finished.operation_feedback?.targets).toMatchObject({
      total: 1,
      completed: 1,
      running: 0,
    });
    expect(finished.operation_feedback?.report?.completed).toHaveLength(1);
    expect(finished.operation_feedback?.primary_pdf_status).toBe("verified");
    expect(finished.candidates).toHaveLength(1);
    expect(finished.candidates[0]?.disposition).toBe("accepted");
    const hash = finished.operation_feedback!.primary_pdf!.sha256;
    expect(hash).toBe(sha256(workbenchPdf()));
    expect(finished.candidates[0]?.sha256).toBe(hash);
    const artifact = await fetch(
      `${origin}/api/library/artifact?client_id=${controller.id}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie!,
          Origin: origin,
          "Content-Type": "application/json",
          "X-Workbench-Csrf": controller.csrf,
        },
        body: JSON.stringify({
          literature_id: literatureId,
          kind: "primary-pdf",
        }),
      },
    );
    expect(artifact.status).toBe(200);
    expect(sha256(Buffer.from(await artifact.arrayBuffer()))).toBe(hash);
    await ui.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>("#operation-read")?.disabled,
    );
    await ui.locator("#operation-read").click();
    await expect.poll(() => ui.url()).toContain(`literature=${literatureId}`);
    expect(new URL(ui.url()).searchParams.get("workspace")).toBe("library");
    expect(errors).toEqual([]);
    return hash;
  } finally {
    for (const release of releaseModels) release();
    await uiBrowser?.close();
    await workbench?.close();
    await proxy.close();
    budget.close();
    vi.unstubAllEnvs();
  }
}

/** A separate legacy catalog uses the installed public CLI; core capability uses init. */
async function installedLegacySchemaJourney(
  server: typeof Server,
  executable: string,
  root: string,
  environment: NodeJS.ProcessEnv,
) {
  const directory = join(root, "legacy-schema");
  await mkdir(directory);
  const catalog = join(directory, "catalog.sqlite");
  const backup = join(directory, "before-v8.sqlite");
  const writer = new server.SqliteWorker(catalog);
  try {
    await writer.putLiterature(FIXTURE_LITERATURE);
  } finally {
    await writer.close();
  }
  const original = await readFile(catalog);
  const dryRun = spawnSync(
    executable,
    ["storage", "schema-upgrade", "--catalog", catalog, "--dry-run", "--json"],
    { encoding: "utf8", env: environment },
  );
  expect(dryRun.status, dryRun.stderr).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    from_version: 1,
    to_version: 8,
  });
  expect(await readFile(catalog)).toEqual(original);
  const upgraded = spawnSync(
    executable,
    [
      "storage",
      "schema-upgrade",
      "--catalog",
      catalog,
      "--backup",
      backup,
      "--json",
    ],
    { encoding: "utf8", env: environment },
  );
  expect(upgraded.status, upgraded.stderr).toBe(0);
  expect(JSON.parse(upgraded.stdout)).toMatchObject({
    action: "upgraded",
    from_version: 1,
    to_version: 8,
    backup_path: backup,
  });
  for (const [path, version] of [
    [catalog, 8],
    [backup, 1],
  ] as const) {
    const inspected = spawnSync(
      executable,
      ["storage", "schema-inspect", "--catalog", path, "--json"],
      { encoding: "utf8", env: environment },
    );
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      schema_version: version,
    });
    const reader = new server.SqliteWorker(path, undefined, { readOnly: true });
    try {
      expect(
        await reader.getLiterature(FIXTURE_LITERATURE.literature_id),
      ).toMatchObject(FIXTURE_LITERATURE);
    } finally {
      await reader.close();
    }
  }
}

it("passes producer IDs, hashes and evidence through installed public SDK, CLI and HTTP entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-installed-journey-"));
  const runtime = join(root, "runtime");
  const userHome = join(root, "user");
  const home = userHome;
  const catalog = join(home, "catalog.sqlite");
  let application:
    | Awaited<ReturnType<typeof Server.createApplication>>
    | undefined;
  let query:
    | Awaited<ReturnType<typeof Server.createQueryApplication>>
    | undefined;
  let http: Awaited<ReturnType<typeof Server.startQueryOnlyHttp>> | undefined;
  let site: Awaited<ReturnType<typeof startWorkbenchFixture>> | undefined;
  try {
    await mkdir(userHome);
    // Packaging keeps the toolchain cache and strips Application home/runtime hooks.
    const buildEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete buildEnvironment.SCIRETRIEVER_HOME;
    delete buildEnvironment.SCIRETRIEVER_CLOAK_BUNDLE;
    const built = spawnSync(
      process.execPath,
      [
        "scripts/package/build-portable.mjs",
        "--output",
        runtime,
        ...(process.env.SCIRETRIEVER_INSTALLED_CLOAK_BUNDLE
          ? ["--cloak-bundle", process.env.SCIRETRIEVER_INSTALLED_CLOAK_BUNDLE]
          : []),
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 150_000,
        env: buildEnvironment,
      },
    );
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const executable = join(runtime, "bin/sciretriever");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
    };
    delete environment.SCIRETRIEVER_HOME;
    delete environment.SCIRETRIEVER_CLOAK_BUNDLE;
    const before = spawnSync(executable, ["literature", "search", "--json"], {
      encoding: "utf8",
      env: environment,
    });
    expect(before.status).toBe(3);
    expect(JSON.parse(before.stderr)).toEqual({
      code: "query-not-initialized",
    });
    expect(existsSync(catalog)).toBe(false);

    const initialized = spawnSync(
      executable,
      ["storage", "schema-init", "--catalog", catalog, "--json"],
      { encoding: "utf8", env: environment },
    );
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      action: "initialized",
      to_version: 8,
      inspection: { status: "ready", schema_version: 8 },
    });

    const packageRoot = join(runtime, "app/node_modules/@sciretriever/server");
    const server = (await import(
      pathToFileURL(join(packageRoot, "dist/index.js")).href
    )) as typeof Server;
    await installedLegacySchemaJourney(server, executable, root, environment);
    if (process.env.SCIRETRIEVER_INSTALLED_CLOAK_BUNDLE) {
      // This invocation tests the copied portable operator bundle, not its source.
      vi.stubEnv(
        "SCIRETRIEVER_INSTALLED_CLOAK_BUNDLE",
        join(runtime, "runtime/cloakbrowser"),
      );
    }
    const contracts = (await import(
      pathToFileURL(
        join(runtime, "app/node_modules/@sciretriever/contracts/dist/index.js"),
      ).href
    )) as typeof import("@sciretriever/contracts");
    site = await startWorkbenchFixture();
    const observation = parseMetadataObservation({
      observation_id: id(101),
      provenance: {
        provenance_id: id(102),
        source_kind: "metadata-provider",
        source_name: "fixture",
        source_record_id: "fixture-article",
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: "a".repeat(64),
        parameters_sha256: null,
      },
      metadata: {
        title: "Installed journey paper",
        authors: [],
        abstract: null,
        publication_date: "2026-01-01",
        publication_year: 2026,
        document_type: "article",
        language: "en",
        venue: "Synthetic Journal",
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        identifiers: [{ namespace: "doi", value: "10.1000/installed-journey" }],
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
    const browserObservation = parseMetadataObservation({
      ...observation,
      observation_id: id(103),
      provenance: {
        ...observation.provenance,
        provenance_id: id(104),
        source_record_id: "fixture-browser-article",
      },
      metadata: {
        ...observation.metadata,
        title: "Installed Browser paper",
        identifiers: [{ namespace: "doi", value: FIXTURE_DOI }],
      },
      asset_hints: [
        {
          url: `${site.origin}/article`,
          kind: "landing-page",
          media_type: null,
          asset_role: null,
          version_role: "published",
          access_status: "open",
          license: null,
        },
      ],
    });
    application = await server.createApplication(home, {
      executionSchema: "require-v2",
      metadata: {
        topic_search_ports: [
          {
            provider_name: "fixture",
            open_topic_search: () => {
              let delivered = 0;
              return {
                pull_raw_item: () => {
                  if (delivered >= 2) return null;
                  const raw_item =
                    delivered++ === 0 ? observation : browserObservation;
                  return { raw_item, source_exhausted_after: delivered === 2 };
                },
                convert_raw_item: (raw_item) => ({
                  observations: [raw_item as typeof observation],
                  relations: [],
                }),
              };
            },
          },
        ],
      },
    });
    const discovery = await application.discovery.run({
      query: "installed journey",
      providers: [{ provider_name: "fixture", scan_limit: 2 }],
    });
    expect(discovery).toMatchObject({ status: "COMPLETED", accepted_count: 2 });
    await application.close();
    application = undefined;

    const searched = spawnSync(
      executable,
      ["literature", "search", "--text", "Installed journey paper", "--json"],
      { encoding: "utf8", env: environment },
    );
    expect(searched.status, searched.stderr).toBe(0);
    const page = JSON.parse(searched.stdout) as {
      items: { literature: { literature_id: string } }[];
    };
    expect(page.items).toHaveLength(1);
    const literatureId = page.items[0]!.literature.literature_id;
    const browserSearched = spawnSync(
      executable,
      ["literature", "search", "--text", "Installed Browser paper", "--json"],
      { encoding: "utf8", env: environment },
    );
    expect(browserSearched.status, browserSearched.stderr).toBe(0);
    const browserLiteratureId = (
      JSON.parse(browserSearched.stdout) as {
        items: { literature: { literature_id: string } }[];
      }
    ).items[0]?.literature.literature_id;
    expect(browserLiteratureId).toBeTruthy();
    if (!browserLiteratureId)
      throw new Error("discovery returned no Browser literature ID");
    const pdf = workbenchPdf("10.1000/installed-journey");
    const pdfPath = join(root, "synthetic.pdf");
    await writeFile(pdfPath, pdf);
    const imported = spawnSync(
      executable,
      ["import", "pdf", literatureId, pdfPath, "--json"],
      { encoding: "utf8", env: environment },
    );
    expect(imported.status, imported.stderr).toBe(0);
    const accepted = JSON.parse(imported.stdout) as {
      asset_id: string;
      sha256: string;
    };
    expect(accepted.sha256).toBe(sha256(pdf));
    expect(await readFile(pdfPath)).toEqual(Buffer.from(pdf));

    const owner = new server.TypeScriptConfigurationOwner(home);
    await owner.publish(
      '[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:9/v1"\n[models."fixture/installed-model"]\nimage = true\nstream = false\n[analyze]\nmodel = "fixture/installed-model"\n[browser]\nenabled = true\nmodel = "fixture/installed-model"\nprofile = "synthetic"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
      "missing",
      ["providers", "models", "analyze", "browser", "sources"],
    );
    const browserHash = await installedBrowserJourney(
      server,
      contracts,
      home,
      root,
      site.origin,
      browserLiteratureId,
    );
    let parserCalls = 0;
    let modelCalls = 0;
    let modelError: string | null = null;
    application = await server.createApplication(home, {
      executionSchema: "require-v2",
      agentTransportFactory:
        () =>
        async ({ body }) => {
          try {
            modelCalls++;
            const wire = JSON.parse(new TextDecoder().decode(body)) as {
              messages: { content: { type: string; text?: string }[] }[];
            };
            const input = JSON.parse(
              wire.messages[1]?.content.find((part) => part.type === "text")
                ?.text ?? "{}",
            ) as {
              core?: { segment_id: string; text: string }[];
              segments?: { segment_id: string; text: string }[];
              candidates?: {
                id: string;
                category: string;
                epistemic: string;
                text: string;
                conditions: string[];
                quantity: unknown;
              }[];
            };
            let value: Record<string, unknown>;
            if (input.core || input.segments) {
              const segment = (input.core ?? input.segments)!.find((item) =>
                item.text.includes("4.2 eV"),
              );
              value = segment
                ? {
                    outcome: "completed",
                    title: "Installed result",
                    statements: [
                      {
                        statement_id: "local-1",
                        category: "result",
                        epistemic: "reported",
                        text: "The measured result was 4.2 eV in dry conditions",
                        conditions: ["dry conditions"],
                        quantity: {
                          value: "4.2",
                          unit: "eV",
                          comparison_basis: null,
                        },
                        evidence_segment_ids: [segment.segment_id],
                        ...(input.core
                          ? {
                              evidence_quotes: ["4.2 eV"],
                              evidence_regions: ["core"],
                            }
                          : {}),
                      },
                    ],
                  }
                : {
                    outcome: "not_applicable",
                    title: "No measurement",
                    statements: [],
                  };
            } else if (input.candidates) {
              value = {
                title: "Installed synthesis",
                statements: input.candidates.map((candidate, index) => ({
                  statement_id: `merged-${index + 1}`,
                  category: candidate.category,
                  epistemic: candidate.epistemic,
                  relation: "single-source",
                  conflict_group_id: null,
                  text: candidate.text,
                  conditions: candidate.conditions,
                  quantity: candidate.quantity,
                  source_ids: [candidate.id],
                })),
              };
            } else throw new Error("unexpected synthetic model input");
            return {
              status: 200,
              headers: [],
              body: Buffer.from(
                JSON.stringify({
                  model: "installed-model",
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: JSON.stringify(value) },
                    },
                  ],
                  usage: { prompt_tokens: 20, completion_tokens: 30 },
                }),
              ),
            };
          } catch (error) {
            modelError =
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);
            throw error;
          }
        },
      parsing: {
        rules: new server.TypeScriptParserArtifactRules(),
        parser: {
          parse: async (request) => {
            parserCalls++;
            const bytes = Buffer.from(
              "# Results\nThe installed paper measured 4.2 eV in dry conditions.\n",
            );
            return {
              source_asset_id: request.source_asset_id,
              source_sha256: request.source_sha256,
              page_count: 1,
              markdown: {
                bytes,
                artifact: contracts.parseArtifactRef({
                  sha256: sha256(bytes),
                  byte_size: bytes.length,
                  media_type: "text/markdown",
                }),
              },
              resources: [],
              provenance: {
                provenance: contracts.parseProvenance({
                  provenance_id: id(200 + parserCalls),
                  source_kind: "parser",
                  source_name: "fixture",
                  source_record_id: null,
                  observed_at: "2026-09-29T00:00:00Z",
                  input_sha256: request.source_sha256,
                  parameters_sha256: "b".repeat(64),
                }),
                parser_version: "fixture",
                mode: null,
                model_identity: null,
              },
            };
          },
        },
      },
    });
    query = await server.createQueryApplication(home);
    http = await server.startQueryOnlyHttp({
      application: query,
      maintenance: application.maintenance!,
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html>installed</html>" }],
      ]),
    });
    const landing = await fetch(http.origin);
    const cookie = landing.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const grantResponse = await fetch(
      `${http.origin}/api/v1/maintenance/session`,
      {
        headers: { cookie: cookie! },
      },
    );
    const grant = (await grantResponse.json()) as { csrf: string };
    const post = async <K extends keyof Responses>(
      path: K,
      request: unknown,
      maintenance = false,
    ) => {
      const response = await fetch(
        `${http!.origin}/api/v1/${maintenance ? "maintenance" : "query"}/${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sciretriever-protocol-version": "1",
            ...(maintenance
              ? {
                  cookie: cookie!,
                  origin: http!.origin,
                  "x-sciretriever-csrf": grant.csrf,
                }
              : {}),
          },
          body: JSON.stringify(
            maintenance && path === "parse-document"
              ? request
              : { protocol_version: 1, request },
          ),
        },
      );
      return {
        status: response.status,
        body: (await response.json()) as Responses[K],
      };
    };
    const read = await post("read", { literature_id: literatureId });
    expect(read.status).toBe(200);
    expect(read.body.detail.metadata_observations).toContainEqual(
      expect.objectContaining({
        observation_id: observation.observation_id,
        provenance: observation.provenance,
      }),
    );
    expect(read.body.detail.primary_pdf!.asset.sha256).toBe(accepted.sha256);
    expect(read.body.detail.primary_pdf!.article_identity_status).toBe(
      "unverified",
    );
    expect(read.body.detail.parser_result).toBeNull();
    expect(read.body.detail.content).toBeNull();
    const assetId = read.body.detail.primary_pdf!.asset.asset_id;
    expect(assetId).toBe(accepted.asset_id);
    const browserRead = await post("read", {
      literature_id: browserLiteratureId,
    });
    expect(browserRead.status).toBe(200);
    expect(browserRead.body.detail.metadata_observations).toContainEqual(
      expect.objectContaining({
        observation_id: browserObservation.observation_id,
        provenance: browserObservation.provenance,
      }),
    );
    expect(browserRead.body.detail.primary_pdf!.asset.sha256).toBe(browserHash);
    const browserAssetId = browserRead.body.detail.primary_pdf!.asset.asset_id;
    const parsed = await post(
      "parse-document",
      {
        literature_id: literatureId,
        asset_id: assetId,
        asset_sha256: accepted.sha256,
        mode: "reparse",
        expected_default_revision: null,
      },
      true,
    );
    expect(parsed.status, JSON.stringify(parsed.body)).toBe(200);
    expect(parserCalls).toBe(1);
    const documentId = parsed.body.receipt.document.document_version_id;
    expect(parsed.body.receipt.document.source_material_ref.asset_id).toBe(
      assetId,
    );
    expect(parsed.body.receipt.document.source_material_ref.asset_sha256).toBe(
      accepted.sha256,
    );
    const browserParsed = await post(
      "parse-document",
      {
        literature_id: browserLiteratureId,
        asset_id: browserAssetId,
        asset_sha256: browserHash,
        mode: "reparse",
        expected_default_revision: null,
      },
      true,
    );
    expect(browserParsed.status, JSON.stringify(browserParsed.body)).toBe(200);
    const afterParsing = await post("read", {
      literature_id: browserLiteratureId,
    });
    expect(afterParsing.body.detail.primary_pdf?.article_identity_status).toBe(
      "unverified",
    );
    expect(parserCalls).toBe(2);
    const browserDocumentId =
      browserParsed.body.receipt.document.document_version_id;
    expect(
      browserParsed.body.receipt.document.source_material_ref.asset_sha256,
    ).toBe(browserHash);
    const described = await post("document-describe", {
      document_version_id: documentId,
    });
    expect(described.status).toBe(200);
    expect(described.body.result.document.document_version_id).toBe(documentId);
    const indexed = await post("rebuild-index", { kind: "rebuild" }, true);
    expect(indexed.status, JSON.stringify(indexed.body)).toBe(200);
    const material = await post("material-evidence", {
      literature_id: literatureId,
      asset_id: assetId,
    });
    expect(material.status, JSON.stringify(material.body)).toBe(200);
    expect(material.body.result.evidence.content_sha256).toBe(accepted.sha256);
    if (material.body.result.evidence.target_kind !== "material")
      throw new Error("material evidence returned a document target");
    const resolved = await post(
      "evidence-resolve",
      material.body.result.evidence,
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.result.granularity).toBe("file");
    const context = await post("context", {
      query: "4.2 eV",
      scope: { kind: "library" },
      kinds: ["metadata", "document"],
      versions: { kind: "default" },
      budget: { max_items: 10, max_bytes: 16384, token_limit: null },
      continuation: null,
    });
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.result.items).toContainEqual(
      expect.objectContaining({
        kind: "source-text",
        reference: expect.objectContaining({
          literature_id: literatureId,
          document_version_id: documentId,
          asset_id: assetId,
          asset_sha256: accepted.sha256,
        }),
      }),
    );
    const bytesResponse = await fetch(
      `${http.origin}/api/v1/query/material-bytes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: {
            literature_id: literatureId,
            asset_id: assetId,
            asset_sha256: accepted.sha256,
          },
        }),
      },
    );
    expect(bytesResponse.status).toBe(200);
    expect(sha256(Buffer.from(await bytesResponse.arrayBuffer()))).toBe(
      accepted.sha256,
    );
    const browserBytes = await fetch(
      `${http.origin}/api/v1/query/material-bytes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: {
            literature_id: browserLiteratureId,
            asset_id: browserAssetId,
            asset_sha256: browserHash,
          },
        }),
      },
    );
    expect(browserBytes.status).toBe(200);
    expect(sha256(Buffer.from(await browserBytes.arrayBuffer()))).toBe(
      browserHash,
    );

    const specContent = {
      schema_version: 1 as const,
      spec_id: "installed.candidate",
      spec_version: "1",
      record_meaning: "Synthetic measurement",
      output_schema: {
        $schema: contracts.EXTRACTION_SCHEMA_URI,
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      field_instructions: [],
      inclusion_rules: [],
      missing_value_rules: [],
      evidence_policy: {
        field_granularity: "file" as const,
        required_pointers: "record-root" as const,
        cross_input_relation: "optional" as const,
      },
      required_capabilities: ["material-file-v1" as const],
    };
    const spec = {
      ...specContent,
      spec_sha256: await contracts.extractionSpecHash(specContent),
    };
    const prepared = await post("extraction-prepare", {
      spec,
      inputs: [
        {
          input_id: "paper-1",
          literature_id: literatureId,
          asset_id: assetId,
          asset_sha256: accepted.sha256,
          document_version_id: documentId,
        },
      ],
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect(prepared.body.result.manifest.items[0]!.material!.asset_sha256).toBe(
      accepted.sha256,
    );
    const operation = await post(
      "extraction-operation",
      {
        caller_id: "installed.external-program",
        spec: prepared.body.result.spec,
        manifest: prepared.body.result.manifest,
      },
      true,
    );
    expect(operation.status, JSON.stringify(operation.body)).toBe(200);
    const submitted = await post(
      "extraction-submit",
      {
        schema_version: 1,
        operation_id: operation.body.result.operation_id,
        submission_key: "installed-key-1",
        batch_id: "installed-batch-1",
        records: [
          {
            record_id: "record-1",
            payload: { value: "4.2 eV" },
            field_evidence: [
              {
                pointer: "",
                sources: [
                  {
                    input_id: "paper-1",
                    evidence: material.body.result.evidence,
                  },
                ],
              },
            ],
          },
        ],
        relations: [],
        coverage: [
          {
            input_id: "paper-1",
            status: "processed-with-records",
            reason: null,
          },
        ],
        producer: {
          method_id: "external.fixture",
          method_version: "1",
          usage: { steps: 1 },
        },
      },
      true,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.result.receipt.checks.record_count).toBe(1);
    const receipt = await post(
      "extraction-receipt",
      {
        receipt_id: submitted.body.result.receipt.receipt_id,
      },
      true,
    );
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(operation.body.result.spec_sha256).toBe(spec.spec_sha256);
    expect(receipt.body.result.protected_materials[0]!.asset_sha256).toBe(
      accepted.sha256,
    );

    const manifest = await contracts.createInputManifest([
      {
        input_id: "paper-1",
        literature_id: literatureId,
        material: material.body.result.evidence.material,
        document: described.body.result.document,
        capabilities: [
          "material-file-v1",
          "document-segment-v1",
          "document-text-v1",
          "document-outline-v1",
          "document-resources-v1",
        ],
        gaps: [],
      },
    ]);
    const analyzed = await post(
      "analyze-knowledge",
      {
        schema_version: 1,
        input: manifest,
        purpose: "overview",
        question: null,
        default_update: null,
        budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
      },
      true,
    );
    expect(
      analyzed.status,
      `${JSON.stringify(analyzed.body)} ${modelCalls} ${modelError ?? ""}`,
    ).toBe(200);
    expect(modelCalls).toBeGreaterThan(0);
    const knowledgeId = analyzed.body.result.artifact!.artifact_id;
    const knowledge = await post("knowledge-read", {
      artifact_id: knowledgeId,
    });
    expect(knowledge.status, JSON.stringify(knowledge.body)).toBe(200);
    expect(knowledge.body.result.artifact_id).toBe(knowledgeId);
    expect(knowledge.body.result.input).toEqual(manifest);
    expect(
      knowledge.body.result.content.statements[0]!.evidence,
    ).toContainEqual(
      expect.objectContaining({
        target_kind: "document",
        document_version_id: documentId,
      }),
    );
    const knowledgeIndex = await post(
      "rebuild-knowledge-index",
      { kind: "rebuild" },
      true,
    );
    expect(knowledgeIndex.status, JSON.stringify(knowledgeIndex.body)).toBe(
      200,
    );
    const mixed = await post("knowledge-context", {
      schema_version: 2,
      query: "4.2",
      scope: { kind: "library" },
      kinds: ["metadata", "document", "knowledge"],
      versions: { kind: "default" },
      knowledge: {
        purposes: ["overview"],
        question: null,
        selection: "all",
        artifact_ids: [],
      },
      budget: { max_items: 20, max_bytes: 262144, token_limit: null },
      continuation: null,
    });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
    expect(mixed.body.result.items).toContainEqual(
      expect.objectContaining({
        kind: "generated-knowledge",
        reference: expect.objectContaining({
          artifact_id: knowledgeId,
          content_sha256: knowledge.body.result.content_ref.sha256,
          manifest_sha256: manifest.manifest_sha256,
        }),
        source_state: "verified",
        source_literature_ids: [literatureId],
      }),
    );
    const synthesisPrepared = await post("synthesis-prepare", {
      policy: "require-all",
      inputs: [
        {
          kind: "document",
          input_id: "paper-1",
          literature_id: literatureId,
          asset_id: assetId,
          asset_sha256: accepted.sha256,
          document_version_id: documentId,
        },
        {
          kind: "document",
          input_id: "browser-paper",
          literature_id: browserLiteratureId,
          asset_id: browserAssetId,
          asset_sha256: browserHash,
          document_version_id: browserDocumentId,
        },
      ],
    });
    expect(
      synthesisPrepared.status,
      JSON.stringify(synthesisPrepared.body),
    ).toBe(200);
    const synthesis = await post(
      "synthesize",
      {
        schema_version: 3,
        input: synthesisPrepared.body.result.manifest,
        purpose: "synthesis",
        question: "What was measured?",
        policy: "require-all",
        budget: {
          max_source_bytes: 8 * 1024 * 1024,
          max_verification_bytes: 64 * 1024 * 1024,
          max_call_bytes: 256 * 1024,
          max_total_call_bytes: 32 * 1024 * 1024,
          max_calls: 256,
          max_output_tokens_per_call: 2048,
          max_total_output_tokens: 524288,
        },
      },
      true,
    );
    expect(synthesis.status, JSON.stringify(synthesis.body)).toBe(200);
    if (!synthesis.body.result.artifact)
      throw new Error("synthesis returned no artifact");
    const synthesisId = synthesis.body.result.artifact.artifact_id;
    const synthesisRead = await post("synthesis-read", {
      artifact_id: synthesisId,
    });
    expect(synthesisRead.status, JSON.stringify(synthesisRead.body)).toBe(200);
    expect(synthesisRead.body.result.artifact.artifact_id).toBe(synthesisId);
    expect(synthesisRead.body.result.artifact.coverage.items).toHaveLength(2);
    expect(synthesisRead.body.result.artifact.input).toEqual(
      synthesisPrepared.body.result.manifest,
    );
    expect(synthesisRead.body.result.independent_literature_ids).toEqual(
      expect.arrayContaining([literatureId, browserLiteratureId]),
    );
    // Close every writer. A fresh, installed query application consumes the
    // newly committed IDs without rebuilding, upgrading or recovering anything.
    await http.close();
    http = undefined;
    await query.close();
    query = undefined;
    await application.close();
    application = undefined;
    query = await server.createQueryApplication(home);
    expect(query.readiness.schema_version).toBe(8);
    const reopened = await query.query!.detail(browserLiteratureId);
    expect(reopened.primary_pdf!.asset.asset_id).toBe(browserAssetId);
    expect(reopened.primary_pdf!.asset.sha256).toBe(browserHash);
    expect((await query.knowledgeRead!.byId(knowledgeId))!.artifact_id).toBe(
      knowledgeId,
    );
    expect(
      (await query.synthesisRead!.byId(synthesisId))!.artifact.artifact_id,
    ).toBe(synthesisId);
    expect(
      (
        await query.documentRead!.describe({
          document_version_id: browserDocumentId,
        })
      ).document.source_material_ref.asset_sha256,
    ).toBe(browserHash);
  } finally {
    await http?.close();
    await query?.close();
    await application?.close();
    await site?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
