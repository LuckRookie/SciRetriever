import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium } from "playwright";
import {
  parseLiterature,
  type ProcessorBatchRequest,
} from "@sciretriever/contracts";
import { processorFixture as coreProcessingFixture } from "../../server/test/processor-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import {
  processorHttpAdapters,
  taskHttpAdapters,
} from "../../server/src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
  type WorkbenchHttpOptions,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

export const missingId = "00000000-0000-0000-0000-000000005101";
export async function workspace(
  analysisModel = true,
  setup?: (
    env: Awaited<ReturnType<typeof coreProcessingFixture>>,
  ) => Promise<void>,
  options?: {
    assets: ReadonlyMap<string, WorkbenchStaticAsset>;
    path?: string;
    ready?: string;
    configuration?: (
      env: Awaited<ReturnType<typeof coreProcessingFixture>>,
    ) => NonNullable<WorkbenchHttpOptions["configuration"]>;
  },
) {
  if (!options?.assets)
    throw new Error("Workspace fixture requires production React assets");
  const env = await coreProcessingFixture();
  const dispose: (() => Promise<void>)[] = [() => env.close()];
  const close = async () => {
    for (const action of dispose.reverse()) await action();
  };
  try {
    await env.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: missingId,
        meta_literature_id: "00000000-0000-0000-0000-000000005102",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Unparsed source",
          identifiers: [],
        },
      }),
    );
    env.setText(
      "# Measurements\nThe measured energy was 4.2 eV.\n\n## Context\nA separate discussion.\n",
    );
    if (setup) await setup(env);
    const parsed = await env.build(env.parseRequest);
    if (!analysisModel) {
      await env.disableAnalysis();
      await env.reopen();
    }
    env.setModel((input) => ({
      answer: true,
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    const query = await createQueryApplication(env.home);
    dispose.push(() => query.close());
    const session = new ProductionWorkbenchSession(null, async () => {
      throw new Error("unexpected browser action");
    });
    dispose.push(() => session.close());
    const assets = new Map<string, WorkbenchStaticAsset>(await readingAssets());
    for (const [path, asset] of options.assets) assets.set(path, asset);
    const server = await startWorkbenchHttp({
      access: workbenchTestAccess,
      ...taskHttpAdapters(env.app),
      session,
      maintenance: env.app.maintenance!,
      query: {
        application: query,
        maintenance: env.app.maintenance!,
        ...processorHttpAdapters(env.app),
      },
      library: {
        queries: env.app.library,
        artifacts: env.app.literatureArtifacts,
      },
      assets,
      ...(options?.configuration
        ? { configuration: options.configuration(env) }
        : {}),
    });
    dispose.push(() => server.close());
    const browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    dispose.push(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion:
        process.env.SCIRETRIEVER_REDUCED_MOTION === "reduce"
          ? "reduce"
          : "no-preference",
    });
    page.setDefaultTimeout(20_000);
    const errors: string[] = [],
      submissions: ProcessorBatchRequest[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/v1/maintenance/processor-submit"
      )
        submissions.push(
          (request.postDataJSON() as { request: ProcessorBatchRequest })
            .request,
        );
    });
    await loginWorkbenchPage(page, server.origin);
    await page.goto(server.origin + (options?.path ?? ""));
    await page
      .locator(options.ready ?? ".paper-row")
      .first()
      .waitFor();
    return {
      env,
      page,
      parsed,
      setupCalls: { parser: env.parseCalls, model: env.modelCalls },
      submissions,
      errors,
      close,
      origin: server.origin,
      browser,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
